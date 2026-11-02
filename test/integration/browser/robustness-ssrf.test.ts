/**
 * The SSRF guard and a resolver that fails for a moment. The name resolves in phase A; during phase B the
 * injected lookup fails with EAI_AGAIN. A transient failure must not mark the start page `unresolved` and lose B/C.
 */
import { type BrowserType, chromium, type LaunchOptions } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lookup } from '../../../src/core/net.ts';
import { type DynamicHandler, type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { collect } from './helpers.ts';
import { stubCmpApi } from './stub-cmp.ts';

const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];
const html = (body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Start</title></head><body>${body}</body></html>`;

const site = (host: string): DynamicHandler => ({
  host,
  path: /.*/,
  handle: (_req, res, ctx) => {
    if (ctx.url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('<main><h1>Start</h1></main>'));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html('<h1>Nicht gefunden</h1>'));
  },
});

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ handlers: [site('flaky.example.test'), site('gone.example.test')] });
});

afterAll(async () => {
  await server?.close();
});

/**
 * Lookup that works until the third browser launch (probe = 1, phase A = 2, phase B = 3) and then fails with
 * `code` for the next `failures` calls (`Infinity`: for good). The spy counts the launches.
 */
function resolverFailingInPhaseB(code: string, failures: number) {
  let launches = 0;
  let left = failures;
  const calls: number[] = [];
  const spy = {
    launchPersistentContext: (dir: string, opts: LaunchOptions) => {
      launches++;
      return chromium.launchPersistentContext(dir, opts);
    },
  } as unknown as BrowserType;
  const lookup: Lookup = async (host) => {
    calls.push(launches);
    if (launches >= 3 && left > 0) {
      left--;
      throw Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
    }
    return PUBLIC;
  };
  return { spy, lookup, calls };
}

const bStart = (run: Awaited<ReturnType<typeof collect>>) =>
  run.result.sections.browser?.phases.find((p) => p.phase === 'B')?.pages[0];

describe('a start page refused in phase B because the resolver hiccuped', () => {
  it('EAI_AGAIN twice, then success: the guard re-asks and the start page of B loads', async () => {
    const r = resolverFailingInPhaseB('EAI_AGAIN', 2);
    const run = await collect(server, {
      url: 'https://flaky.example.test/',
      maxPages: 1,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B'], chromium: r.spy, lookupBackoffMs: [30, 30] },
      network: { allowPrivateAddresses: false, lookup: r.lookup },
    });
    expect(bStart(run)).toMatchObject({ evaluable: true, navigation: { ok: true } });
    expect(run.result.sections.browser?.guard).toMatchObject({ blocked: 0 });
    expect(run.result.diagnostics?.map((d) => d.code) ?? []).not.toContain('SCAN-PRIVATE-REQUEST-BLOCKED');
    expect(run.result.sections.browser?.phases.find((p) => p.phase === 'B')?.status).not.toBe('failed');
  });

  it('EAI_AGAIN for all three attempts: the start page gets one more navigation after a pause; the retry that loads it leaves no diagnostic about a document not fetched', async () => {
    const r = resolverFailingInPhaseB('EAI_AGAIN', 3);
    const run = await collect(server, {
      url: 'https://flaky.example.test/',
      maxPages: 1,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B'], chromium: r.spy, lookupBackoffMs: [30, 30] },
      network: { allowPrivateAddresses: false, lookup: r.lookup },
    });
    const b = run.result.sections.browser?.phases.find((p) => p.phase === 'B');
    // The refused navigation is replaced by the retry (one page record).
    expect(b?.pages.map((p) => [p.role, p.navigation.ok])).toEqual([['start', true]]);
    // The refusal itself stays a fact in the data: one blocked navigation, flagged on its request record.
    expect(run.result.sections.browser?.guard).toMatchObject({ blocked: 1 });
    expect(b?.requests.filter((q) => q.blockedByGuard)).toHaveLength(1);
    // the document was fetched by the retry, so the report must not say that documents were not fetched.
    expect(run.result.diagnostics?.map((d) => d.code) ?? []).not.toContain('SCAN-PRIVATE-REQUEST-BLOCKED');
  });

  it('counterexample: a name that does not exist (ENOTFOUND) stays refused — fail-closed, two navigations tried', async () => {
    const r = resolverFailingInPhaseB('ENOTFOUND', Number.POSITIVE_INFINITY);
    const run = await collect(server, {
      url: 'https://gone.example.test/',
      maxPages: 1,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B'], chromium: r.spy, lookupBackoffMs: [30, 30] },
      network: { allowPrivateAddresses: false, lookup: r.lookup },
    });
    const b = run.result.sections.browser?.phases.find((p) => p.phase === 'B');
    expect(b).toMatchObject({ status: 'failed' });
    expect(bStart(run)).toMatchObject({
      evaluable: false,
      notEvaluableReason: 'navigation-failed:ERR_BLOCKED_BY_CLIENT',
    });
    const diag = run.result.diagnostics?.find((d) => d.code === 'SCAN-PRIVATE-REQUEST-BLOCKED');
    expect(diag?.params).toMatchObject({ count: 2, addressClass: 'unresolved', lookupCodes: 'ENOTFOUND' });
    // Nothing reached the host.
    expect(server.requestsTo('gone.example.test').filter((q) => q.path === '/').length).toBe(1);
  });
});
