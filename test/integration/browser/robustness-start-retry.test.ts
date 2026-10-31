/**
 * L2: the repeated navigation to the start page is not silent (L2 of the live rescan). The start page of phase A is
 * navigated once more after a failure (timeout, connection error, 5xx; spec 7.4 / table 5.2: "timeout or 5xx of the
 * start page twice" is unreachable). The first attempt used to be wiped (`pages.pop()`), so neither the snapshot nor
 * the log showed that 30 s of the budget had gone. Now the failed attempt stays in the snapshot as an error of the
 * phase (code of the failure, attempt, duration, pause, navigation id) and in the log. Synthetic hosts only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../src/core/logger.ts';
import { type DynamicHandler, type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { collect, FAST_TIMING } from './helpers.ts';

const html = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

type Attempt = 'stall' | 'silent' | 503 | 'ok';

/** Answers `/` of `host` per attempt (the last entry repeats); every other path is an ordinary 404. */
function startPage(host: string, attempts: Attempt[]): DynamicHandler {
  let n = 0;
  return {
    host,
    path: /.*/,
    handle: (req, res, ctx) => {
      if (ctx.url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html('404', '<h1>Nicht gefunden</h1>'));
        return;
      }
      const attempt = attempts[Math.min(n++, attempts.length - 1)];
      if (attempt === 'stall') {
        // Headers and the first bytes of the document, then silence: DOMContentLoaded never comes, the browser gives
        // up at its navigation timeout.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.write('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Start</title>');
        req.on('close', () => res.destroy());
        return;
      }
      if (attempt === 'silent') {
        // Not a single byte: the request is accepted and nothing comes back, so the navigation has no committed
        // document when it times out. Chromium counts the next navigation to the same URL as the same, unfinished one.
        req.on('close', () => res.destroy());
        return;
      }
      if (attempt === 503) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html('503', '<p>Wartung</p>'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('Start', '<main><h1>Start</h1></main>'));
    },
  };
}

const HOSTS = {
  timeoutThenOk: 'timeout-then-ok.example.test',
  unavailableThenOk: 'unavailable-then-ok.example.test',
  clean: 'clean.example.test',
  timeoutTwice: 'timeout-twice.example.test',
  silentThenOk: 'silent-then-ok.example.test',
  silentTwice: 'silent-twice.example.test',
};

// Short enough to keep the test fast; the retry pause (`retryDelayMs`) is 200 ms in FAST_TIMING.
const TIMING = { ...FAST_TIMING, navigationTimeoutMs: 1_500 };

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    handlers: [
      startPage(HOSTS.timeoutThenOk, ['stall', 'ok']),
      startPage(HOSTS.unavailableThenOk, [503, 'ok']),
      startPage(HOSTS.clean, ['ok']),
      startPage(HOSTS.timeoutTwice, ['stall']),
      startPage(HOSTS.silentThenOk, ['silent', 'ok']),
      startPage(HOSTS.silentTwice, ['silent']),
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const rootHits = (host: string) => server.requestsTo(host).filter((r) => r.path === '/');

describe('start page repeated after a failed navigation', () => {
  it('timeout, then a good answer: the failed attempt stays visible in the snapshot and in the log', async () => {
    const warn = vi.spyOn(silentLogger, 'warn');
    const run = await collect(server, { url: `https://${HOSTS.timeoutThenOk}/`, deps: { timing: TIMING } });

    // The repeat worked: no fatal, exactly one start visit (the good one), exactly two requests of the document.
    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.timeoutThenOk)).toHaveLength(2);
    const phaseA = run.result.sections.browser?.phases[0];
    const starts = phaseA?.pages.filter((p) => p.role === 'start') ?? [];
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ evaluable: true, navigation: { status: 200 } });

    // The first attempt is a fact of the snapshot: code of the failure, which attempt, how long, how long the pause.
    const retried = phaseA?.errors.filter((e) => e.code === 'navigation-timeout') ?? [];
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ phase: 'A', url: starts[0]?.url });
    expect(retried[0]?.message).toMatch(/attempt 1 of 2/);
    expect(retried[0]?.message).toMatch(/after \d+ ms/);
    expect(retried[0]?.message).toMatch(/pause of 200 ms/);
    // The requests of the failed attempt carry its navigation id; the entry names it, so they are not orphans.
    const failedNavigation = /\(navigation ([^)\s]+)\)/.exec(retried[0]?.message ?? '')?.[1];
    expect(failedNavigation).toBeTruthy();
    expect(phaseA?.requests.some((r) => r.navigationId === failedNavigation)).toBe(true);
    expect(starts[0]?.navigationId).not.toBe(failedNavigation);

    // The log (scan.log) says it too, without the URL.
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => /start page.*attempt 1.*navigation-timeout/.test(l))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(HOSTS.timeoutThenOk);
  });

  it('503, then a good answer: the same record with the status as the code', async () => {
    const run = await collect(server, {
      url: `https://${HOSTS.unavailableThenOk}/`,
      deps: { timing: TIMING },
    });
    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.unavailableThenOk)).toHaveLength(2);
    const phaseA = run.result.sections.browser?.phases[0];
    expect(phaseA?.pages.filter((p) => p.role === 'start')).toHaveLength(1);
    const retried = phaseA?.errors.filter((e) => e.code === 'http-503') ?? [];
    expect(retried).toHaveLength(1);
    expect(retried[0]?.message).toMatch(/attempt 1 of 2/);
  });

  it('timeout twice: unreachable after two attempts, the first one is in the snapshot, the second is the visit', async () => {
    const run = await collect(server, { url: `https://${HOSTS.timeoutTwice}/`, deps: { timing: TIMING } });
    expect(run.result.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
    // Two attempts, not three (spec 7.4: "twice").
    expect(rootHits(HOSTS.timeoutTwice)).toHaveLength(2);
    const phaseA = run.result.sections.browser?.phases[0];
    const starts = phaseA?.pages.filter((p) => p.role === 'start') ?? [];
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ evaluable: false, navigation: { error: 'timeout' } });
    expect(phaseA?.errors.filter((e) => e.code === 'navigation-timeout')).toHaveLength(1);
  });

  it('no answer at all, then a good answer: the repeat is a second request, not an instant ERR_ABORTED (L2)', async () => {
    const run = await collect(server, { url: `https://${HOSTS.silentThenOk}/`, deps: { timing: TIMING } });

    // Before the fix Chromium took the repeat for the same, still unfinished navigation and aborted it within a few
    // milliseconds without a request: one hit on the server, `start-page-unreachable` with `ERR_ABORTED`.
    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.silentThenOk)).toHaveLength(2);
    const phaseA = run.result.sections.browser?.phases[0];
    const starts = phaseA?.pages.filter((p) => p.role === 'start') ?? [];
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ evaluable: true, navigation: { status: 200 } });
    const retried = phaseA?.errors.filter((e) => e.code === 'navigation-timeout') ?? [];
    expect(retried).toHaveLength(1);
    expect(retried[0]?.message).toMatch(/attempt 1 of 2/);
  });

  it('no answer twice: unreachable with the reason timeout after two real attempts, never ERR_ABORTED (L2)', async () => {
    const run = await collect(server, { url: `https://${HOSTS.silentTwice}/`, deps: { timing: TIMING } });
    expect(run.result.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
    expect(rootHits(HOSTS.silentTwice)).toHaveLength(2);
    const phaseA = run.result.sections.browser?.phases[0];
    const starts = phaseA?.pages.filter((p) => p.role === 'start') ?? [];
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ evaluable: false, navigation: { error: 'timeout' } });
    expect(phaseA?.errors.filter((e) => e.code === 'navigation-timeout')).toHaveLength(1);
    expect(phaseA?.errors.some((e) => /ERR_ABORTED/.test(e.code + e.message))).toBe(false);
  });

  it('counterexample: a start page that loads at once has no retry record and no retry log line', async () => {
    const warn = vi.spyOn(silentLogger, 'warn');
    const run = await collect(server, { url: `https://${HOSTS.clean}/`, deps: { timing: TIMING } });
    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.clean)).toHaveLength(1);
    const phaseA = run.result.sections.browser?.phases[0];
    expect(phaseA?.pages.filter((p) => p.role === 'start')).toHaveLength(1);
    expect(
      phaseA?.errors.filter((e) => e.code === 'navigation-timeout' || e.code.startsWith('http-')),
    ).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /start page/.test(l))).toEqual([]);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
