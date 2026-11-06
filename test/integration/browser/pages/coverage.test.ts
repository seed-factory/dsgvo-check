/**
 * Page coverage on a site under /de/: phase A visits the location and history pages instead of the language roots, a
 * CMP's helper frame above the page is no control signal, and phase B revisits the pages with the map and the video
 * thumbnail after the reject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { stubCmpApi } from '../consent/stub-cmp.ts';
import { type CollectRun, collect, FAST_TIMING } from '../helpers.ts';

const START = 'https://www.example.test/de/';
const u = (path: string) => `https://www.example.test${path}`;

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/page-coverage'] });
});

afterAll(async () => {
  await server?.close();
});

const languageRootRequests = () =>
  server.requestsTo('www.example.test').filter((r) => /^\/(en|es)(\/|$)/.test(r.path));

describe('page coverage: phases A, B and C', () => {
  let run: CollectRun;

  beforeAll(async () => {
    server.reset();
    run = await collect(server, { url: START, deps: { cmp: stubCmpApi(), phases: ['A', 'B', 'C'] } });
  });

  const phase = (p: 'A' | 'B' | 'C') => run.result.sections.browser?.phases.find((x) => x.phase === p);

  it('A visits the start page, the legal pages, Kontakt, then the location and the history page', () => {
    const plan = run.result.sections.plan;
    expect(plan?.pages.map((p) => [p.order, p.url, p.role, p.source, p.reasons, p.robotsAllowed])).toEqual([
      [0, START, 'start', 'start', ['start'], undefined],
      [1, u('/de/impressum/'), 'impressum', 'link', ['footer-link:impressum'], undefined],
      [2, u('/de/datenschutz/'), 'privacy', 'link', ['footer-link:datenschutz'], undefined],
      [3, u('/de/kontakt/'), 'contact', 'link', ['footer-link:kontakt'], undefined],
      [4, u('/de/kontakt/anfahrt/'), 'nav', 'link', ['keyword:anfahrt'], true],
      [5, u('/de/unternehmen/geschichte/'), 'nav', 'link', ['keyword:geschichte'], true],
    ]);
    expect(phase('A')?.pages.map((p) => p.url)).toEqual(plan?.pages.map((p) => p.url));
  });

  it('the language roots are never requested', () => {
    expect(languageRootRequests()).toEqual([]);
    expect(server.unexpected).toEqual([]);
  });

  it('every page of A shows the helper frame above the page; it gives no control signal', () => {
    for (const p of phase('A')?.pages ?? []) {
      const helper = p.dom?.iframes.find((f) => f.src?.startsWith('https://consent.example.net/'));
      expect(helper?.box, p.url).toMatchObject({ y: -9999, height: 4 });
    }
    expect(run.result.sections.plan?.controlPages.map((p) => [p.url, p.reasons])).toEqual([
      [u('/de/kontakt/'), ['iframe-signal', 'network-signal', 'embed-signal', 'role:contact']],
      [u('/de/unternehmen/geschichte/'), ['network-signal', 'embed-signal']],
    ]);
  });

  it('B revisits the map and the history page after the reject and records their embeds after the click', () => {
    const b = phase('B');
    expect(b?.click).toMatchObject({ action: 'reject', success: true });
    expect(b?.pages.map((p) => [p.url, p.reload ?? false])).toEqual([
      [START, false],
      [START, true],
      [u('/de/kontakt/'), false],
      [u('/de/unternehmen/geschichte/'), false],
    ]);

    for (const host of ['www.google.com', 'i1.ytimg.com']) {
      const embeds = b?.requests.filter((r) => r.host === host) ?? [];
      expect(embeds.length, host).toBeGreaterThan(0);
      expect(
        embeds.every((r) => r.afterClick),
        host,
      ).toBe(true);
    }
  });

  it('C visits the same control pages after the accept', () => {
    expect(phase('C')?.pages.map((p) => p.url)).toEqual([
      START,
      u('/de/kontakt/'),
      u('/de/unternehmen/geschichte/'),
    ]);
  });
});

describe('page coverage: limits', () => {
  it('is deterministic across runs', async () => {
    const a = await collect(server, { url: START });
    const b = await collect(server, { url: START });
    expect(b.result.sections.plan).toEqual(a.result.sections.plan);
  });

  it('--max-pages 4 leaves no extras; the legal pages are visited all the same', async () => {
    server.reset();
    const run = await collect(server, { url: START, maxPages: 4 });
    expect(run.result.sections.plan?.pages.map((p) => [p.role, p.url])).toEqual([
      ['start', START],
      ['impressum', u('/de/impressum/')],
      ['privacy', u('/de/datenschutz/')],
      ['contact', u('/de/kontakt/')],
    ]);
    expect(languageRootRequests()).toEqual([]);
  });

  it('the control-page setting decides how many pages B and C revisit', async () => {
    const run = await collect(server, { url: START, config: { browser: { maxControlPages: 1 } } });
    expect(run.result.sections.plan?.controlPages.map((p) => p.url)).toEqual([u('/de/kontakt/')]);
  });

  it('keeps at least 1.5 s between navigations with production pacing', async () => {
    const run = await collect(server, {
      url: START,
      maxPages: 2,
      deps: { timing: { ...FAST_TIMING, navigationPauseMs: 1_500 } },
    });
    const pages = run.result.sections.browser?.phases[0]?.pages ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1]!;
      const prevEnd = Date.parse(prev.navigation.startedAt) + prev.navigation.dwellMs;
      expect(Date.parse(pages[i]!.navigation.startedAt) - prevEnd).toBeGreaterThanOrEqual(1_450);
    }
  });
});
