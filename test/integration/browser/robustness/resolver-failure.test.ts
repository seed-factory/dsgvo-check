/**
 * The SSRF guard and a resolver that fails for a moment. The name resolves in phase A; during phase B the
 * injected lookup fails with EAI_AGAIN. A transient failure must not mark the start page `unresolved` and lose B/C.
 */
import { type BrowserType, chromium, type LaunchOptions } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { Lookup } from '../../../../src/core/url/net.ts';
import { useFixtureServer } from '../../../fixture-server/use-fixture-server.ts';
import { stubCmpApi } from '../consent/stub-cmp.ts';
import { type CollectRun, collect } from '../helpers.ts';
import { html, send, site } from '../site-dir.ts';

const PUBLIC = [{ address: '93.184.215.14', family: 4 as const }];

const START = { '/': send(html('Start', '<main><h1>Start</h1></main>')) };

const server = useFixtureServer(() => ({
  handlers: [site('flaky.example.test', START), site('gone.example.test', START)],
}));

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

const phaseB = (run: CollectRun) => run.result.sections.browser?.phases.find((p) => p.phase === 'B');
const bStart = (run: CollectRun) => phaseB(run)?.pages[0];

/** Phases A and B of `host` with the failing resolver `r`; the guard's pauses between lookups are short. */
function collectWithFailingResolver(host: string, r: ReturnType<typeof resolverFailingInPhaseB>) {
  return collect(server(), {
    url: `https://${host}/`,
    maxPages: 1,
    deps: { cmp: stubCmpApi(), phases: ['A', 'B'], chromium: r.spy, lookupBackoffMs: [30, 30] },
    network: { allowPrivateAddresses: false, lookup: r.lookup },
  });
}

const diagnosticCodes = (run: CollectRun) => run.result.diagnostics?.map((d) => d.code) ?? [];

describe('a start page refused in phase B because the resolver hiccuped', () => {
  it('EAI_AGAIN twice, then success: the guard re-asks and the start page of B loads', async () => {
    const r = resolverFailingInPhaseB('EAI_AGAIN', 2);

    const run = await collectWithFailingResolver('flaky.example.test', r);

    expect(bStart(run)).toMatchObject({ evaluable: true, navigation: { ok: true } });
    expect(run.result.sections.browser?.guard).toMatchObject({ blocked: 0 });
    expect(diagnosticCodes(run)).not.toContain('SCAN-PRIVATE-REQUEST-BLOCKED');
    expect(phaseB(run)?.status).not.toBe('failed');
  });

  it('EAI_AGAIN for all three attempts: the start page gets one more navigation after a pause; the retry that loads it leaves no diagnostic about a document not fetched', async () => {
    const r = resolverFailingInPhaseB('EAI_AGAIN', 3);

    const run = await collectWithFailingResolver('flaky.example.test', r);

    const b = phaseB(run);
    // The refused navigation is replaced by the retry (one page record).
    expect(b?.pages.map((p) => [p.role, p.navigation.ok])).toEqual([['start', true]]);
    // The refusal itself stays a fact in the data: one blocked navigation, flagged on its request record.
    expect(run.result.sections.browser?.guard).toMatchObject({ blocked: 1 });
    expect(b?.requests.filter((q) => q.blockedByGuard)).toHaveLength(1);
    // The document was fetched by the retry, so the report must not say that documents were not fetched.
    expect(diagnosticCodes(run)).not.toContain('SCAN-PRIVATE-REQUEST-BLOCKED');
  });

  it('counterexample: a name that does not exist (ENOTFOUND) stays refused — fail-closed, two navigations tried', async () => {
    const r = resolverFailingInPhaseB('ENOTFOUND', Number.POSITIVE_INFINITY);

    const run = await collectWithFailingResolver('gone.example.test', r);

    expect(phaseB(run)).toMatchObject({ status: 'failed' });
    expect(bStart(run)).toMatchObject({
      evaluable: false,
      notEvaluableReason: 'navigation-failed:ERR_BLOCKED_BY_CLIENT',
    });
    const diag = run.result.diagnostics?.find((d) => d.code === 'SCAN-PRIVATE-REQUEST-BLOCKED');
    expect(diag?.params).toMatchObject({ count: 2, addressClass: 'unresolved', lookupCodes: 'ENOTFOUND' });
    // Nothing reached the host.
    expect(
      server()
        .requestsTo('gone.example.test')
        .filter((q) => q.path === '/').length,
    ).toBe(1);
  });
});
