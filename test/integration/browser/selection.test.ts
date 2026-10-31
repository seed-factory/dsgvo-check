/** L2: page selection is deterministic, keeps reasons, honours robots.txt for additional pages and maxPages. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { collect } from './helpers.ts';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/selection'] });
});

afterAll(async () => {
  await server?.close();
});

describe('page selection (D09)', () => {
  it('start, Impressum, Datenschutz, Kontakt and two extras of different templates; robots.txt respected', async () => {
    const run = await collect(server);
    const plan = run.result.sections.plan;
    expect(plan?.pages.map((p) => [p.order, p.url, p.role, p.source, p.reasons, p.robotsAllowed])).toEqual([
      [0, 'https://www.example.test/', 'start', 'start', ['start'], undefined],
      [1, 'https://www.example.test/impressum/', 'impressum', 'link', ['footer-link:impressum'], undefined],
      [2, 'https://www.example.test/datenschutz/', 'privacy', 'link', ['footer-link:datenschutz'], undefined],
      [3, 'https://www.example.test/kontakt/', 'contact', 'link', ['nav-link:kontakt'], undefined],
      // "Über uns" is disallowed by robots.txt; the next keywords are team and karriere.
      [4, 'https://www.example.test/team/', 'nav', 'link', ['keyword:team'], true],
      [5, 'https://www.example.test/karriere/', 'nav', 'link', ['keyword:karriere'], true],
    ]);
    const visited = run.result.sections.browser?.phases[0]?.pages.map((p) => p.url);
    expect(visited).toEqual(plan?.pages.map((p) => p.url));
    expect(run.result.probes?.map((p) => [p.purpose, p.target])).toEqual([
      ['robots.txt', 'https://www.example.test/robots.txt'],
    ]);
    expect(server.requestsTo('www.example.test').some((r) => r.path.startsWith('/ueber-uns'))).toBe(false);
    expect(server.unexpected).toEqual([]);
  });

  it('is deterministic across runs', async () => {
    const a = await collect(server);
    const b = await collect(server);
    expect(b.result.sections.plan).toEqual(a.result.sections.plan);
  });

  it('maxPages limits additional pages; legal pages are always visited', async () => {
    const run = await collect(server, { maxPages: 2 });
    expect(run.result.sections.plan?.pages.map((p) => p.role)).toEqual(['start', 'impressum', 'privacy']);
  });

  it('the shared request cap truncates recording and stops further navigation (D09)', async () => {
    const run = await collect(server, { deps: { requestLimit: 3, phases: ['A', 'B', 'C'] } });
    const b = run.result.sections.browser;
    expect(run.result.status).toBe('partial');
    expect(b?.requestCap).toMatchObject({ limit: 3, truncated: true });
    expect(b?.requestCap.issued).toBeGreaterThan(3);
    expect(b?.phases[0]?.requests).toHaveLength(3);
    expect(b?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'partial', 'request-cap'],
      ['B', 'skipped', 'request-cap'],
      ['C', 'skipped', 'request-cap'],
    ]);
  });

  it('keeps at least 1.5 s between navigations with production pacing', async () => {
    const { FAST_TIMING } = await import('./helpers.ts');
    const run = await collect(server, {
      maxPages: 2,
      deps: { timing: { ...FAST_TIMING, navigationPauseMs: 1_500 } },
    });
    const pages = run.result.sections.browser?.phases[0]?.pages ?? [];
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1]!;
      const prevEnd = Date.parse(prev.navigation.startedAt) + prev.navigation.dwellMs;
      expect(Date.parse(pages[i]!.navigation.startedAt) - prevEnd).toBeGreaterThanOrEqual(1_450);
    }
  });
});
