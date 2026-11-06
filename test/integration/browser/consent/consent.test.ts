/**
 * Phases B and C with a stub CMP on the fixture site (observe, screenshot, reject, verify, reload, control pages,
 * accept), plus one test with the real CMP subsystem (`src/cmp/index.ts`) on a site without banner. The Kontakt page
 * embeds a map frame that loads Google Fonts and is not blocked by the banner, so it loads again after the reject.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { type BrowserType, chromium, type LaunchOptions } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embed02 } from '../../../../src/checks/browser/embed-02.ts';
import { sha256Hex } from '../../../../src/collectors/browser/util.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../src/core/data/messages.ts';
import type { RequestRecord } from '../../../../src/core/snapshot/browser.ts';
import type { Snapshot } from '../../../../src/core/snapshot/index.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { makeSnapshot, observationsOf, runCheck, withDerived } from '../../../utils/snapshot-builder.ts';
import { type CollectRun, collect, TEST_SANDBOX } from '../helpers.ts';
import { stubCmpApi } from './stub-cmp.ts';

const KONTAKT = 'https://www.example.test/kontakt/';
/** The tracking the stub banner loads after an accept; the map frame and its fonts are on other Google hosts. */
const tracking = (r: RequestRecord) => /google-analytics|googletagmanager/.test(r.host);

/** The collected sections as a snapshot with `derived`, to run a check over a real collection. */
function snapshotOf(run: CollectRun): Snapshot {
  const s = run.result.sections;
  return withDerived(
    makeSnapshot({
      target: run.ctx.target,
      ...(s.browser ? { browser: s.browser } : {}),
      ...(s.documents ? { documents: s.documents } : {}),
      cmp: s.cmp ?? { phases: [] },
      plan: { browser: s.plan ?? null, probes: [] },
    }),
  );
}

describe('phases B and C with a recognized CMP (stub adapter)', () => {
  let server: FixtureServer;
  let run: CollectRun;
  let calls: string[];
  const launches: Array<{ dir: string; opts: LaunchOptions & Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/cmp-stub'] });
    const cmp = stubCmpApi();
    calls = cmp.calls;
    const spy = {
      launchPersistentContext: (dir: string, opts: LaunchOptions & Record<string, unknown>) => {
        launches.push({ dir, opts });
        return chromium.launchPersistentContext(dir, opts);
      },
    } as unknown as BrowserType;
    run = await collect(server, { deps: { cmp, phases: ['A', 'B', 'C'], chromium: spy } });
  });

  afterAll(async () => {
    await server?.close();
  });

  const phase = (p: 'A' | 'B' | 'C') => run.result.sections.browser?.phases.find((x) => x.phase === p);

  it('runs A, B and C, each in its own profile', () => {
    expect(run.result.status).toBe('ok');
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status, p.profile])).toEqual([
      ['A', 'completed', 'persistent-tmp'],
      ['B', 'completed', 'persistent-tmp'],
      ['C', 'completed', 'persistent-tmp'],
    ]);
    // Fresh profile per phase: the consent cookie of B is not present at the start of C.
    expect(phase('C')?.cookies.find((c) => c.name === 'stub_consent')?.afterClick).toBe(true);
    expect(calls).toContain('extract:first-screen');
  });

  it('every launch (engine probe + A + B + C) uses a fresh temp profile that is removed afterwards', () => {
    expect(launches).toHaveLength(4);
    expect(new Set(launches.map((l) => l.dir)).size).toBe(4);
    for (const l of launches) {
      expect(existsSync(l.dir)).toBe(false);
      expect(l.opts).toMatchObject({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: TEST_SANDBOX === 'require',
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        viewport: { width: 1366, height: 768 },
        acceptDownloads: false,
      });
      expect(l.opts.args).toEqual(expect.arrayContaining(['--disable-quic']));
    }
    // Phases use the real Chrome UA plus the token; the probe launch reads it.
    expect(launches[0]?.opts.userAgent).toBeUndefined();
    for (const l of launches.slice(1)) expect(String(l.opts.userAgent)).toContain('dsgvo-check/');
  });

  it('B: the reject goes through the adapter, is verified, and the start page is reloaded', () => {
    const b = phase('B');
    const cmpB = run.result.sections.cmp?.phases.find((p) => p.phase === 'B');

    expect(b?.click).toMatchObject({ action: 'reject', cmpId: 'stub', name: 'Ablehnen', success: true });
    expect(b?.reloaded).toBe(true);
    expect(cmpB?.verify).toMatchObject({ action: 'reject', verified: true, persistedAfterReload: true });
  });

  it('B: visits the start page, its reload, then the control pages', () => {
    expect(phase('B')?.pages.map((p) => [p.url, p.reload ?? false])).toEqual([
      ['https://www.example.test/', false],
      ['https://www.example.test/', true],
      ['https://www.example.test/kontakt/', false],
      ['https://www.example.test/impressum/', false],
    ]);
  });

  it('B: the plan records the reject target', () => {
    expect(run.result.sections.plan?.click.B).toEqual({
      phase: 'B',
      action: 'reject',
      target: {
        cmpId: 'stub',
        name: 'Ablehnen',
        role: 'button',
        selector: '#stub-reject',
        kindConfidence: 'high',
      },
    });
  });

  it('B: banner facts are taken at the first screen, after the click, after the reload and on control pages', () => {
    const cmpB = run.result.sections.cmp?.phases.find((p) => p.phase === 'B');

    expect(cmpB?.facts.map((f) => f.moment)).toEqual([
      'first-screen',
      'after-click',
      'after-reload',
      'control-page',
      'control-page',
    ]);
    expect(cmpB?.facts.map((f) => f.phase)).toEqual(['B', 'B', 'B', 'B', 'B']);
  });

  it('B: nothing is tracked after the reject; requests before the click are timed from the navigation', () => {
    const b = phase('B');

    expect(b?.requests.filter(tracking).map((r) => r.host)).toEqual([]);
    const after = b?.requests.filter((r) => r.afterClick) ?? [];
    expect(after.length).toBeGreaterThan(0);
    expect(b?.requests.filter((r) => !r.afterClick && r.tRef !== 'navigation').map((r) => r.id)).toEqual([]);
  });

  it('B: the map frame of the control page Kontakt and its fonts are recorded after the click', () => {
    const mapDocuments = (p: 'A' | 'B') =>
      (phase(p)?.requests ?? [])
        .filter((r) => r.url.startsWith('https://www.google.com/maps/embed') && r.resourceType === 'document')
        .map((r) => [r.pageUrl, r.isMainFrame, r.afterClick]);
    expect(mapDocuments('A')).toEqual([[KONTAKT, false, false]]);
    expect(mapDocuments('B')).toEqual([[KONTAKT, false, true]]);

    const frameFonts = (phase('B')?.requests ?? []).filter((r) => r.host === 'fonts.googleapis.com');
    expect(frameFonts.length).toBeGreaterThan(0);
    expect(frameFonts.every((r) => !r.isMainFrame && r.afterClick && r.pageUrl === KONTAKT)).toBe(true);
  });

  it('EMBED-02 over the collection: the map with its Google Fonts before the interaction and after the confirmed reject', () => {
    const snapshot = snapshotOf(run);
    const mapB = (snapshot.derived?.requests ?? []).filter(
      (c) => c.serviceId === 'google-maps' && c.phase === 'B',
    );
    expect(mapB.length).toBeGreaterThan(0);
    expect(new Set(mapB.map((c) => c.timing))).toEqual(new Set(['after-reject']));
    expect(mapB.some((c) => c.source === 'embed-frame' && c.resourceServiceId === 'google-fonts')).toBe(true);

    const observations = observationsOf(runCheck(embed02, snapshot));
    expect(observations).toHaveLength(1);
    const [o] = observations;
    expect(o).toMatchObject({
      subject: 'google-maps',
      phases: ['A', 'B'],
      pages: [KONTAKT],
      params: {
        moment: 'before-and-after-reject',
        rejectConfirmed: true,
        afterRejectPageCount: 1,
        frameFontServices: 'Google Fonts',
      },
    });
    expect(o?.evidence.some((e) => e.type === 'request' && e.phase === 'B' && !e.beforeClick)).toBe(true);
    expect(o?.evidence.filter((e) => e.type === 'consent-state')).toHaveLength(2);

    const de = renderMessage(loadTexts('de'), 'EMBED-02.maps-loaded', o!.params);
    expect(de.title).toBe('Externer Kartendienst geladen, auch nach bestätigter Ablehnung: Google Maps');
    expect(de.body).toContain(
      'vor einer Interaktion mit dem Einwilligungsbanner und erneut nach bestätigter Ablehnung',
    );
    expect(de.body).toContain('Der Kartenrahmen lud dabei Schriften von Google Fonts');
  });

  it('B: banner screenshot of the first screen only (≤ 200 KB, ≤ 50 % viewport)', () => {
    const shots = run.result.sections.browser?.screenshots ?? [];
    expect(shots).toHaveLength(1);
    const shot = shots[0]!;

    expect(shot).toMatchObject({
      phase: 'B',
      kind: 'banner',
      path: 'artifacts/banner-B.jpg',
      viewport: 'desktop',
    });
    expect(shot.width).toBe(1366);
    expect(shot.height).toBeGreaterThan(100);
    expect(shot.width * shot.height).toBeLessThanOrEqual(0.5 * 1366 * 768);

    const file = path.join(run.artifactsDir, 'banner-B.jpg');
    expect(statSync(file).size).toBeLessThanOrEqual(200 * 1024);
    expect(sha256Hex(readFileSync(file))).toBe(shot.sha256);
    const first = run.result.sections.cmp?.phases.find((p) => p.phase === 'B')?.facts[0];
    expect(first?.screenshotId).toBe(shot.id);
  });

  it('C: accept on the start page; tracking starts after the click (tRef click) and on control pages', () => {
    const c = phase('C');

    expect(c?.click).toMatchObject({ action: 'accept', name: 'Alle akzeptieren', success: true });
    const hits = c?.requests.filter((r) => r.host === 'www.google-analytics.com') ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({ afterClick: true, tRef: 'click', identifierNames: ['cid'] });
    expect(c?.cookies.find((ck) => ck.name === '_ga')).toMatchObject({ afterClick: true, state: 'accepted' });
    expect(run.result.sections.plan?.click.C?.target?.name).toBe('Alle akzeptieren');
    expect(run.result.sections.cmp?.phases.find((p) => p.phase === 'C')?.verify).toMatchObject({
      verified: true,
    });
  });

  describe('recorded request fields', () => {
    const phases = ['A', 'B', 'C'] as const;
    const requestsOf = (p: (typeof phases)[number]) => phase(p)?.requests ?? [];

    it('every request has a time, a navigation id of its phase, a parser version, a delivery and a result', () => {
      const all = phases.flatMap(requestsOf);
      expect(all.length).toBeGreaterThan(0);

      for (const r of all) {
        expect(r.atMs, r.id).toBeTypeOf('number');
        expect(r.navigationId, r.id).toMatch(new RegExp(`^${r.phase}-n\\d+$`));
        expect(r).toMatchObject({ parserVersion: 'request-features/2', observationSource: 'playwright' });
        expect(r.delivery).toBeDefined();
        expect(r.result).toBeDefined();
      }
    });

    it('one monotonic tMs scale over A/B/C: every request of B starts after every request of A, C after B', () => {
      // The phases run one after another.
      const span = (p: (typeof phases)[number]) => requestsOf(p).map((r) => r.atMs ?? Number.NaN);

      expect(Math.min(...span('B'))).toBeGreaterThan(Math.max(...span('A')));
      expect(Math.min(...span('C'))).toBeGreaterThan(Math.max(...span('B')));
    });

    it('the click is an action: requests after it, and only those, carry its id; the click record names it', () => {
      const b = phase('B');

      expect(b?.click?.actionId).toBe('B-a1');
      for (const r of b?.requests ?? []) expect(r.actionId === 'B-a1', r.id).toBe(r.afterClick);
    });

    it('page visits name their navigation; documents of the main frame share one frame id within a phase', () => {
      const b = phase('B');

      for (const p of b?.pages ?? []) expect(p.navigationId).toMatch(/^B-n\d+$/);
      const mainDocs = (b?.requests ?? []).filter((r) => r.isMainFrame && r.resourceType === 'document');
      expect(new Set(mainDocs.map((r) => r.frameId)).size).toBe(1);
    });
  });

  it('A: no tracking without consent, banner facts on every page', () => {
    const a = phase('A');
    const cmpA = run.result.sections.cmp?.phases.find((p) => p.phase === 'A');

    expect(a?.requests.filter(tracking).map((r) => r.host)).toEqual([]);
    // The fixture shows the banner on the start page and on Kontakt only.
    expect(cmpA?.facts.map((f) => [f.pageUrl, f.firstLayer.bannerPresent])).toEqual([
      ['https://www.example.test/', true],
      ['https://www.example.test/impressum/', false],
      ['https://www.example.test/datenschutz/', false],
      ['https://www.example.test/kontakt/', true],
    ]);
    expect(server.unexpected).toEqual([]);
  });
});

describe('no-screenshots', () => {
  it('takes no banner screenshot', async () => {
    const server = await startFixtureServer({ sites: ['browser/cmp-stub'] });
    try {
      const run = await collect(server, {
        deps: { cmp: stubCmpApi(), phases: ['A', 'B'] },
        maxPages: 1,
        screenshots: false,
      });
      expect(run.result.sections.browser?.screenshots).toEqual([]);
      expect(existsSync(run.artifactsDir)).toBe(false);
      expect(
        run.result.sections.cmp?.phases.find((p) => p.phase === 'B')?.facts[0]?.screenshotId,
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('with the real CMP subsystem (src/cmp/index.ts)', () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/clean'] });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('no banner: B is partial (cmp-not-recognized), C is skipped, all sections are delivered', async () => {
    const run = await collect(server, { deps: { phases: ['A', 'B', 'C'] }, maxPages: 1 });

    expect(run.result.status).toBe('ok');
    const s = run.result.sections;
    expect(s.browser).toBeDefined();
    expect(s.documents).toBeDefined();
    expect(s.cmp).toBeDefined();
    expect(s.plan).toBeDefined();
    expect(s.browser?.phases.map((p) => [p.phase, p.status, p.reason])).toEqual([
      ['A', 'completed', undefined],
      ['B', 'partial', 'cmp-not-recognized'],
      ['C', 'skipped', 'cmp-not-recognized'],
    ]);
    expect(s.plan?.click.B).toMatchObject({ target: null, reason: 'cmp-not-recognized' });
    expect(s.cmp?.phases.map((p) => p.phase)).toEqual(['A', 'B']);
    expect(server.unexpected).toEqual([]);
  });
});
