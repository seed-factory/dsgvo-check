/**
 * Global timeouts and browsers that do not close must preserve collected facts and explain partial results.
 * Synthetic hosts only (`*.example.test`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { type BrowserContext, type BrowserType, chromium, type LaunchOptions } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { profilesOfPid } from '../../../src/collectors/browser/launch.ts';
import { defineCheck } from '../../../src/core/api.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { CheckRegistry } from '../../../src/core/registry.ts';
import { scan } from '../../../src/scan.ts';
import { type DynamicHandler, type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { expectValidReport } from '../../utils/report-validator.ts';
import { fakeCollectors, testDataDir } from '../../utils/scan-harness.ts';
import { collect, FAST_TIMING, TEST_SANDBOX } from './helpers.ts';
import { stubCmpApi } from './stub-cmp.ts';

const html = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen. ';
const FOOTER =
  '<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>';

const PAGES: Record<string, string> = {
  '/': html('Start', `<main><h1>Start</h1><a href="/kontakt/">Kontakt</a></main>${FOOTER}`),
  '/kontakt/': html('Kontakt', `<main><h1>Kontakt</h1></main>${FOOTER}`),
  '/impressum/': html(
    'Impressum',
    '<main><h1>Impressum</h1><p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Vertreten durch die Geschäftsführung.</p></main>',
  ),
  '/datenschutz/': html(
    'Datenschutzerklärung',
    `<main><h1>Datenschutzerklärung</h1><p>${LOREM.repeat(4)}</p></main>`,
  ),
};

const site = (host: string): DynamicHandler => ({
  host,
  path: /.*/,
  handle: (_req, res, ctx) => {
    const body = PAGES[ctx.url.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? html('404', '<h1>Nicht gefunden</h1>'));
  },
});

let server: FixtureServer;
const cleanup: Array<() => Promise<void>> = [];
const leftovers: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer({
    handlers: [
      site('hang.example.test'),
      site('budget.example.test'),
      site('abort.example.test'),
      site('queue.example.test'),
      site('phaseb.example.test'),
    ],
    sites: ['browser/fatal'],
  });
});

afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
  for (const dir of leftovers) rmSync(dir, { recursive: true, force: true });
  await server?.close();
  // No profile of this process is left behind by the collectors above.
  expect(profilesOfPid(process.pid)).toEqual([]);
});

/**
 * A chromium whose `context.close` never returns for the browsers launched from the `from`-th launch on (the first
 * launch is the engine probe, the second phase A). The real browser keeps running until the test ends.
 */
function hangingClose(from: number) {
  const dirs: string[] = [];
  const contexts: BrowserContext[] = [];
  let launches = 0;
  const spy = {
    launchPersistentContext: async (dir: string, opts: LaunchOptions) => {
      const ctx = await chromium.launchPersistentContext(dir, opts);
      launches++;
      dirs.push(dir);
      if (launches < from) return ctx;
      contexts.push(ctx);
      return new Proxy(ctx, {
        get(t, p) {
          if (p === 'close') return () => new Promise<void>(() => {});
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    },
  } as unknown as BrowserType;
  cleanup.push(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    leftovers.push(...dirs);
  });
  return { spy, dirs, contexts };
}

const processesUsing = (dir: string) =>
  execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' }).includes(dir);

describe('a phase browser that does not close', () => {
  it('is killed after the close budget; the phase and its pages are kept, the profile is gone', async () => {
    const h = hangingClose(2);
    const t0 = Date.now();
    const run = await collect(server, {
      url: 'https://hang.example.test/',
      maxPages: 2,
      deps: { chromium: h.spy, closeBudgetMs: 700 },
    });
    expect(run.result.status).toBe('ok');
    expect(run.result.sections.browser?.phases[0]?.pages.length).toBeGreaterThanOrEqual(2);
    expect(Date.now() - t0).toBeLessThan(60_000);
    for (const dir of h.dirs) {
      expect(existsSync(dir)).toBe(false);
      // SIGKILL is asynchronous: the OS may still list the exiting browser after profile cleanup returns.
      await expect.poll(() => processesUsing(dir), { timeout: 3_000, interval: 25 }).toBe(false);
    }
  });

  it('after the global timeout the collector hands over phase A although the close hangs', async () => {
    const h = hangingClose(2);
    const lines: string[] = [];
    const t0 = Date.now();
    const timeoutMs = 14_000;
    const dataDir = testDataDir({ ruleset: { 'TEST-01': { seen: 'info' } } });
    const probe = defineCheck({
      id: 'TEST-01',
      module: 'browser',
      requires: ['browser', 'documents', 'cmp'],
      variants: [{ variant: 'seen' }],
      run: () => [],
    });
    const r = await scan({
      url: 'https://abort.example.test/',
      network: server.network(),
      registry: new CheckRegistry([probe]),
      dataDir,
      log: { ...silentLogger, warn: (m) => lines.push(m) },
      sandbox: TEST_SANDBOX,
      maxPages: 2,
      timeoutMs,
      collectors: fakeCollectors({
        browser: createBrowserCollector({
          timing: FAST_TIMING,
          phases: ['A', 'B', 'C'],
          chromium: h.spy,
          // The orderly shutdown would need longer than the patience after the abort.
          closeBudgetMs: 120_000,
          abortOrderlyMs: 400,
        }),
      }),
    });
    expectValidReport(r.report);
    expect(r.report.scan.status).toBe('partial');
    expect(r.snapshot?.collection.browser).toMatchObject({ status: 'partial', reason: 'timeout' });
    const a = r.snapshot?.browser?.phases.find((p) => p.phase === 'A');
    expect(a?.pages.length).toBeGreaterThanOrEqual(2);
    expect(a?.status).toBe('completed');
    // Phase A ended by itself; only the close of its browser hung. B and C did not run: cut by the deadline.
    expect(
      r.snapshot?.browser?.phases.filter((p) => p.phase !== 'A').map((p) => [p.phase, p.status, p.reason]),
    ).toEqual([
      ['B', 'skipped', 'timeout'],
      ['C', 'skipped', 'timeout'],
    ]);
    expect(r.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
    expect(r.report.scan.status).not.toBe('failed');
    // The result came within the grace period after the deadline.
    expect(Date.now() - t0).toBeLessThan(timeoutMs + 10_000);
    expect(lines.some((l) => /handing over the collected facts/.test(l))).toBe(true);
  }, 60_000);
});

describe('a collection cut by the deadline', () => {
  it('phases that did not run are skipped/timeout, the running one is partial/timeout; the result carries the reason', async () => {
    const ac = new AbortController();
    const started = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (server.requestsTo('budget.example.test').some((r) => r.path.startsWith('/kontakt'))) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    const pending = collect(server, {
      url: 'https://budget.example.test/',
      signal: ac.signal,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B', 'C'] },
    });
    await started;
    ac.abort();
    const run = await pending;
    expect(run.result).toMatchObject({ status: 'partial', reason: 'timeout' });
    const phases = run.result.sections.browser?.phases ?? [];
    expect(phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'timeout'],
      ['B', 'skipped', 'timeout'],
      ['C', 'skipped', 'timeout'],
    ]);
    expect(phases[0]?.pages.length).toBeGreaterThanOrEqual(1);
  });

  // A deadline that cuts the queue of phase A or later phases means `timeout`, never the local `time-budget`.
  it('the abort while pages are still queued in phase A: A is partial/timeout (not time-budget), B and C skipped/timeout', async () => {
    server.reset();
    const ac = new AbortController();
    const started = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (server.requestsTo('queue.example.test').some((r) => r.path.startsWith('/impressum'))) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    const pending = collect(server, {
      url: 'https://queue.example.test/',
      signal: ac.signal,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B', 'C'] },
    });
    await started;
    ac.abort();
    const run = await pending;
    expect(run.result).toMatchObject({ status: 'partial', reason: 'timeout' });
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'timeout'],
      ['B', 'skipped', 'timeout'],
      ['C', 'skipped', 'timeout'],
    ]);
  });

  it('the abort during phase B: B is cut by the deadline (partial/timeout, not failed), C is skipped/timeout', async () => {
    server.reset();
    const ac = new AbortController();
    const started = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (server.requestsTo('phaseb.example.test').filter((r) => r.path === '/').length >= 2) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    const pending = collect(server, {
      url: 'https://phaseb.example.test/',
      signal: ac.signal,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B', 'C'] },
    });
    await started;
    ac.abort();
    const run = await pending;
    expect(run.result).toMatchObject({ status: 'partial', reason: 'timeout' });
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'completed', undefined],
      ['B', 'partial', 'timeout'],
      ['C', 'skipped', 'timeout'],
    ]);
  });

  it('a partial result names its reason: throttling', async () => {
    server.reset();
    const run = await collect(server, {
      url: 'https://throttled.example.test/',
      deps: { phases: ['A', 'B', 'C'] },
    });
    expect(run.result).toMatchObject({ status: 'partial', reason: 'throttled' });
  });

  it('a partial result names its reason: the time budget', async () => {
    server.reset();
    const run = await collect(server, {
      url: 'https://budget.example.test/',
      deps: { timing: { ...FAST_TIMING, deadlineReserveMs: 600_000 }, phases: ['A', 'B', 'C'] },
    });
    expect(run.result).toMatchObject({ status: 'partial', reason: 'time-budget' });
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'time-budget'],
      ['B', 'skipped', 'time-budget'],
      ['C', 'skipped', 'time-budget'],
    ]);
  });

  it('counterexample: a complete collection has no reason', async () => {
    server.reset();
    const run = await collect(server, { url: 'https://budget.example.test/', maxPages: 2 });
    expect(run.result.status).toBe('ok');
    expect(run.result.reason).toBeUndefined();
  });
});

/**
 * Skipping fallback probes for lack of time leaves phase A unfinished, just like cutting its page queue.
 * LEGAL-01 is guarded by `fallback-skipped`, but the phase and collector must expose the limitation as well.
 */
describe('the fallback probe skipped by the time budget', () => {
  const BUDGET_MS = 5_000;

  const addSite = (host: string, delayStartUntil: number) =>
    server.addHandler({
      host,
      path: /.*/,
      handle: async (_req, res, ctx) => {
        // The start page links nothing: the queue is empty, only the fallback probe of the two paths is left.
        if (ctx.url.pathname === '/') await sleepUntil(delayStartUntil);
        const body = ctx.url.pathname === '/' ? html('Start', '<main><h1>Start</h1></main>') : undefined;
        res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body ?? html('404', '<h1>Nicht gefunden</h1>'));
      },
    });
  const sleepUntil = (at: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));
  const fallbackPaths = (host: string) =>
    server
      .requestsTo(host)
      .map((r) => r.path)
      .filter((p) => p.startsWith('/impressum') || p.startsWith('/datenschutz'));

  it('A is partial/time-budget, the collector says so, the fallback paths are not requested', async () => {
    server.reset();
    const host = 'fallbackcut.example.test';
    addSite(host, Date.now() + BUDGET_MS + 300);
    const run = await collect(server, {
      url: `https://${host}/`,
      deps: { timing: { ...FAST_TIMING, deadlineReserveMs: 110_000 - BUDGET_MS } },
    });
    expect(run.result).toMatchObject({ status: 'partial', reason: 'time-budget' });
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'time-budget'],
    ]);
    expect(fallbackPaths(host)).toEqual([]);
  }, 60_000);

  it('counterexample: with time left the fallback paths are requested and A is completed', async () => {
    server.reset();
    const host = 'fallbackdone.example.test';
    addSite(host, 0);
    const run = await collect(server, { url: `https://${host}/` });
    expect(run.result.status).toBe('ok');
    expect(run.result.reason).toBeUndefined();
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'completed', undefined],
    ]);
    expect(fallbackPaths(host).sort()).toEqual(['/datenschutz', '/impressum']);
  }, 60_000);
});
