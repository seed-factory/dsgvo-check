/**
 * Overload policy for browser navigations: 429/503 → pause by Retry-After (≤ 30 s), one retry, then SCAN-THROTTLED with
 * no further navigation to the host; ≥ 3 such responses in a phase → the same. A throttled legal page is not "not found".
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { useFixtureServer } from '../../../fixture-server/use-fixture-server.ts';
import { stubCmpApi } from '../consent/stub-cmp.ts';
import { type CollectRun, collect } from '../helpers.ts';

const server = useFixtureServer(() => ({ sites: ['browser/throttle'] }));

describe('429 on a subpage navigation', () => {
  let run: CollectRun;
  let t0: number;

  beforeAll(async () => {
    server().reset();
    t0 = Date.now();
    run = await collect(server(), { deps: { cmp: stubCmpApi(), phases: ['A', 'B', 'C'] } });
  });

  it('pauses by Retry-After and retries the navigation exactly once', () => {
    const hits = server()
      .requestsTo('www.example.test')
      .filter((r) => r.path === '/impressum/');
    expect(hits).toHaveLength(2);
    expect((hits[1]?.at ?? 0) - (hits[0]?.at ?? 0)).toBeGreaterThanOrEqual(900);
    expect(Date.now() - t0).toBeGreaterThan(900);
  });

  it('then starts no new navigation to the host: SCAN-THROTTLED, phase A partial, B and C skipped', () => {
    const impressumAt = server()
      .requestsTo('www.example.test')
      .findLastIndex((r) => r.path === '/impressum/');
    const later = server()
      .requestsTo('www.example.test')
      .slice(impressumAt + 1)
      .filter((r) => r.path.endsWith('/') && r.path !== '/impressum/');
    expect(later.map((r) => r.path)).toEqual([]);
    expect(run.result.status).toBe('partial');
    expect(run.result.fatal).toBeUndefined();
    expect(run.result.diagnostics?.filter((d) => d.code === 'SCAN-THROTTLED')).toHaveLength(1);
    expect(run.result.diagnostics?.find((d) => d.code === 'SCAN-THROTTLED')?.affects).toEqual(
      expect.arrayContaining(['LEGAL-01', 'MAIL-01', 'MAIL-02', 'MAIL-03', 'TLS-01']),
    );
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'throttled'],
      ['B', 'skipped', 'throttled'],
      ['C', 'skipped', 'throttled'],
    ]);
  });

  it('the throttled Impressum is an error attempt, not "not found" (no false links-broken)', () => {
    const attempts = run.result.sections.documents?.attempts.filter((a) => a.kind === 'impressum') ?? [];
    expect(attempts.map((a) => [a.outcome, a.status])).toEqual([['error', 429]]);
    const visit = run.result.sections.browser?.phases[0]?.pages.filter((p) => p.url.endsWith('/impressum/'));
    expect(visit?.map((p) => [p.navigation.status, p.evaluable])).toEqual([[429, false]]);
  });
});

describe('≥ 3 responses 429/503 of the target host within a phase', () => {
  it('count like a throttled navigation: SCAN-THROTTLED and no further navigation', async () => {
    server().reset();
    const run = await collect(server(), { url: 'https://busy.example.test/' });
    expect(run.requests.filter((r) => r.host === 'busy.example.test' && r.status === 503)).toHaveLength(3);
    expect(run.result.diagnostics?.map((d) => d.code)).toContain('SCAN-THROTTLED');
    expect(run.result.sections.browser?.phases[0]).toMatchObject({ status: 'partial', reason: 'throttled' });
    const paths = server()
      .requestsTo('busy.example.test')
      .map((r) => r.path);
    expect(paths.filter((p) => p.endsWith('/') && p !== '/')).toEqual([]);
  });
});
