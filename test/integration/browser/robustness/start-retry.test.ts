/**
 * A failed start-page navigation (timeout, connection error, 5xx) is repeated once and stays visible as a phase error
 * with code, attempt, duration, pause and navigation id in the snapshot and log. Synthetic hosts only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import {
  type DynamicHandler,
  type FixtureServer,
  startFixtureServer,
} from '../../../fixture-server/server.ts';
import { type CollectRun, collect, FAST_TIMING } from '../helpers.ts';

const html = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

type Attempt = 'stall' | 'silent' | 503 | 'ok';
type Respond = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Headers and the first bytes of the document, then silence: DOMContentLoaded never comes, the browser gives up at its
 * navigation timeout.
 */
const stall: Respond = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Start</title>');
  req.on('close', () => res.destroy());
};

/**
 * Not a single byte: the request is accepted and nothing comes back, so the navigation has no committed document when
 * it times out. Chromium counts the next navigation to the same URL as the same, unfinished one.
 */
const silent: Respond = (req, res) => {
  req.on('close', () => res.destroy());
};

const unavailable: Respond = (_req, res) => {
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html('503', '<p>Wartung</p>'));
};

const startPageOk: Respond = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html('Start', '<main><h1>Start</h1></main>'));
};

const RESPONDERS: Record<Attempt, Respond> = { stall, silent, 503: unavailable, ok: startPageOk };

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

      const attempt = attempts[Math.min(n++, attempts.length - 1)] ?? 'ok';
      RESPONDERS[attempt](req, res);
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
const phaseAOf = (run: CollectRun) => run.result.sections.browser?.phases[0];
const startVisits = (run: CollectRun) => phaseAOf(run)?.pages.filter((p) => p.role === 'start') ?? [];
const errorsWithCode = (run: CollectRun, code: string) =>
  phaseAOf(run)?.errors.filter((e) => e.code === code) ?? [];

describe('start page repeated after a failed navigation', () => {
  describe('timeout, then a good answer: the failed attempt stays visible in the snapshot and in the log', () => {
    const host = HOSTS.timeoutThenOk;
    let run: CollectRun;
    let logLines: string[];

    beforeAll(async () => {
      const warn = vi.spyOn(silentLogger, 'warn');

      run = await collect(server, { url: `https://${host}/`, deps: { timing: TIMING } });

      logLines = warn.mock.calls.map((c) => String(c[0]));
    });

    it('the repeat worked: no fatal, one start visit (the good one), two requests of the document', () => {
      expect(run.result.fatal).toBeUndefined();
      expect(rootHits(host)).toHaveLength(2);
      expect(startVisits(run)).toHaveLength(1);
      expect(startVisits(run)[0]).toMatchObject({ evaluable: true, navigation: { status: 200 } });
    });

    it('the first attempt is a fact of the snapshot: code of the failure, which attempt, how long, the pause', () => {
      const retried = errorsWithCode(run, 'navigation-timeout');

      expect(retried).toHaveLength(1);
      expect(retried[0]).toMatchObject({ phase: 'A', url: startVisits(run)[0]?.url });
      expect(retried[0]?.message).toMatch(/attempt 1 of 2/);
      expect(retried[0]?.message).toMatch(/after \d+ ms/);
      expect(retried[0]?.message).toMatch(/pause of 200 ms/);
    });

    it('the requests of the failed attempt carry its navigation id; the entry names it, so they are not orphans', () => {
      const message = errorsWithCode(run, 'navigation-timeout')[0]?.message ?? '';

      const failedNavigation = /\(navigation ([^)\s]+)\)/.exec(message)?.[1];

      expect(failedNavigation).toBeTruthy();
      expect(phaseAOf(run)?.requests.some((r) => r.navigationId === failedNavigation)).toBe(true);
      expect(startVisits(run)[0]?.navigationId).not.toBe(failedNavigation);
    });

    it('the log (scan.log) says it too, without the URL', () => {
      expect(logLines.filter((l) => /start page.*attempt 1.*navigation-timeout/.test(l))).toHaveLength(1);
      expect(logLines.join('\n')).not.toContain(host);
    });
  });

  it('503, then a good answer: the same record with the status as the code', async () => {
    const run = await collect(server, {
      url: `https://${HOSTS.unavailableThenOk}/`,
      deps: { timing: TIMING },
    });

    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.unavailableThenOk)).toHaveLength(2);
    expect(startVisits(run)).toHaveLength(1);
    const retried = errorsWithCode(run, 'http-503');
    expect(retried).toHaveLength(1);
    expect(retried[0]?.message).toMatch(/attempt 1 of 2/);
  });

  it('timeout twice: unreachable after two attempts, the first one is in the snapshot, the second is the visit', async () => {
    const run = await collect(server, { url: `https://${HOSTS.timeoutTwice}/`, deps: { timing: TIMING } });

    expect(run.result.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
    // Two attempts, not three.
    expect(rootHits(HOSTS.timeoutTwice)).toHaveLength(2);
    expect(startVisits(run)).toHaveLength(1);
    expect(startVisits(run)[0]).toMatchObject({ evaluable: false, navigation: { error: 'timeout' } });
    expect(errorsWithCode(run, 'navigation-timeout')).toHaveLength(1);
  });

  it('no answer at all, then a good answer: the repeat is a second request, not an instant ERR_ABORTED', async () => {
    const run = await collect(server, { url: `https://${HOSTS.silentThenOk}/`, deps: { timing: TIMING } });

    // Recovery needs a distinct request; reusing an unfinished navigation could abort without contacting the server.
    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.silentThenOk)).toHaveLength(2);
    expect(startVisits(run)).toHaveLength(1);
    expect(startVisits(run)[0]).toMatchObject({ evaluable: true, navigation: { status: 200 } });
    const retried = errorsWithCode(run, 'navigation-timeout');
    expect(retried).toHaveLength(1);
    expect(retried[0]?.message).toMatch(/attempt 1 of 2/);
  });

  it('no answer twice: unreachable with the reason timeout after two real attempts, never ERR_ABORTED', async () => {
    const run = await collect(server, { url: `https://${HOSTS.silentTwice}/`, deps: { timing: TIMING } });

    expect(run.result.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
    expect(rootHits(HOSTS.silentTwice)).toHaveLength(2);
    expect(startVisits(run)).toHaveLength(1);
    expect(startVisits(run)[0]).toMatchObject({ evaluable: false, navigation: { error: 'timeout' } });
    expect(errorsWithCode(run, 'navigation-timeout')).toHaveLength(1);
    const aborted = (phaseAOf(run)?.errors ?? []).filter((e) => /ERR_ABORTED/.test(e.code + e.message));
    expect(aborted).toEqual([]);
  });

  it('counterexample: a start page that loads at once has no retry record and no retry log line', async () => {
    const warn = vi.spyOn(silentLogger, 'warn');

    const run = await collect(server, { url: `https://${HOSTS.clean}/`, deps: { timing: TIMING } });

    expect(run.result.fatal).toBeUndefined();
    expect(rootHits(HOSTS.clean)).toHaveLength(1);
    expect(startVisits(run)).toHaveLength(1);
    expect(
      phaseAOf(run)?.errors.filter((e) => e.code === 'navigation-timeout' || e.code.startsWith('http-')),
    ).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /start page/.test(l))).toEqual([]);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
