/**
 * Phase A on small fixture sites (clean, Google Fonts, map embed on Kontakt, no legal links), policy extraction,
 * cookies and storage without values; phases A and B with a stub CMP on a site with video players and a thumbnail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consent01 } from '../../../src/checks/browser/consent-01.ts';
import { consent02 } from '../../../src/checks/browser/consent-02.ts';
import { embed03 } from '../../../src/checks/browser/embed-03.ts';
import { loadRouting, loadRuleset, loadTexts } from '../../../src/core/data/load.ts';
import { renderMessage } from '../../../src/core/data/messages.ts';
import { assess } from '../../../src/core/evaluation/assess.ts';
import type { Snapshot } from '../../../src/core/snapshot/index.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { makeSnapshot, observationsOf, runCheck, withDerived } from '../../utils/snapshot-builder.ts';
import { stubCmpApi } from './consent/stub-cmp.ts';
import { type CollectRun, collect, persisted } from './helpers.ts';

/** One phase A collection of the fixture site `browser/<name>`, shared by the tests in `fn`. */
function site(name: string, fn: (get: () => { run: CollectRun; server: FixtureServer }) => void) {
  describe(name, () => {
    let server: FixtureServer;
    let run: CollectRun;

    beforeAll(async () => {
      server = await startFixtureServer({ sites: [`browser/${name}`] });
      run = await collect(server);
    });

    afterAll(async () => {
      await server?.close();
    });

    fn(() => ({ run, server }));

    it('touches only declared hosts', () => {
      expect(server.unexpected).toEqual([]);
    });
  });
}

site('clean', (get) => {
  it('no third-party request, no cookies, both legal documents found', () => {
    const { run } = get();

    expect(run.result.status).toBe('ok');
    expect(run.requests.length).toBeGreaterThan(0);
    expect(run.requests.map((r) => r.host).filter((host) => host !== 'www.example.test')).toEqual([]);
    const a = run.result.sections.browser?.phases[0];
    expect(a?.cookies).toEqual([]);
    expect(a?.storage).toEqual([]);
    expect(run.result.sections.documents?.documents.map((d) => [d.kind, d.complete])).toEqual([
      ['impressum', true],
      ['privacy', true],
    ]);
  });

  it('forms are DOM facts with action scheme (TLS-01 input)', () => {
    const kontakt = get().run.result.sections.browser?.phases[0]?.pages.find((p) => p.role === 'contact');
    expect(kontakt?.dom?.forms).toEqual([
      {
        action: 'http://www.example.test/senden',
        actionScheme: 'http',
        method: 'post',
        visible: true,
        fieldCount: 2,
        hasPasswordField: false,
        hasEmailField: true,
      },
    ]);
  });

  it('legal links are DOM facts of every page (LEGAL-01 input)', () => {
    const pages = get().run.result.sections.browser?.phases[0]?.pages ?? [];
    for (const p of pages) {
      const legal = p.dom?.links.filter((l) => l.region === 'footer').map((l) => l.text);
      expect(legal, p.url).toEqual(['Impressum', 'Datenschutzerklärung']);
    }
    expect(pages[0]?.dom?.links.find((l) => l.text === 'Kontakt')).toMatchObject({
      href: 'https://www.example.test/kontakt/',
      hrefKind: 'https',
      region: 'nav',
      visible: true,
      inShadowDom: false,
      sameSite: true,
    });
  });
});

site('fonts', (get) => {
  it('records the Google Fonts CSS and font requests and the preconnect hints', () => {
    const { run } = get();

    const css = run.requests.find((r) => r.host === 'fonts.googleapis.com');
    expect(css).toMatchObject({
      resourceType: 'stylesheet',
      url: 'https://fonts.googleapis.com/css2?family=Roboto&display=swap',
      phase: 'A',
      afterClick: false,
    });
    const font = run.requests.find((r) => r.host === 'fonts.gstatic.com');
    expect(font).toMatchObject({
      resourceType: 'font',
      url: 'https://fonts.gstatic.com/s/roboto/v30/fixture-roboto.woff2',
    });

    const rels = run.result.sections.browser?.phases[0]?.pages[0]?.dom?.linkRels ?? [];
    expect(rels.map((r) => [r.rel, r.href, r.source])).toEqual([
      ['preconnect', 'https://fonts.gstatic.com/', 'dom'],
      ['dns-prefetch', 'https://fonts.googleapis.com/', 'dom'],
      ['stylesheet', 'https://fonts.googleapis.com/css2?family=Roboto&display=swap', 'dom'],
    ]);
  });
});

site('maps', (get) => {
  const kontaktPage = (run: CollectRun) =>
    run.result.sections.browser?.phases[0]?.pages.find((p) => p.role === 'contact');

  it('Kontakt is selected into the plan by its navigation link', () => {
    const plan = get().run.result.sections.plan;

    expect(plan?.pages.find((p) => p.role === 'contact')).toMatchObject({
      url: 'https://www.example.test/kontakt/',
      reasons: ['nav-link:kontakt'],
    });
  });

  it('its Google Maps iframe is seen in the DOM', () => {
    const kontakt = kontaktPage(get().run);

    expect(kontakt?.dom?.iframes[0]).toMatchObject({
      src: 'https://www.google.com/maps/embed?pb=[redacted]',
      title: 'Karte',
      visible: true,
      depth: 1,
      loading: 'eager',
    });
  });

  it('its Google Maps iframe is seen in the network', () => {
    const embed = get().run.requests.find((r) => r.host === 'www.google.com');

    expect(embed).toMatchObject({
      resourceType: 'document',
      isNavigation: true,
      isMainFrame: false,
      frameUrl: 'https://www.google.com/maps/embed?pb=[redacted]',
      pageUrl: 'https://www.example.test/kontakt/',
      url: 'https://www.google.com/maps/embed?pb=[redacted]',
    });
  });

  it('the page with the embed becomes a B/C control page (DOM/network signals, a catalog embed)', () => {
    const plan = get().run.result.sections.plan;

    expect(plan?.controlPages[0]).toMatchObject({
      url: 'https://www.example.test/kontakt/',
      reasons: ['iframe-signal', 'network-signal', 'embed-signal', 'role:contact'],
    });
  });
});

site('no-legal', (get) => {
  it('hops via "Über uns", then falls back to /impressum and /datenschutz, finds nothing', () => {
    const { run } = get();

    const plan = run.result.sections.plan;
    expect(plan?.pages.map((p) => [p.url, p.role, p.source, p.reasons])).toEqual([
      ['https://www.example.test/', 'start', 'start', ['start']],
      ['https://www.example.test/ueber-uns/', 'legal-hop', 'hop', ['hop:über uns']],
      ['https://www.example.test/impressum', 'fallback', 'fallback', ['fallback:/impressum']],
      ['https://www.example.test/datenschutz', 'fallback', 'fallback', ['fallback:/datenschutz']],
    ]);

    const docs = run.result.sections.documents;
    expect(docs?.documents).toEqual([]);
    expect(docs?.attempts.map((a) => [a.kind, a.via, a.outcome, a.status])).toEqual([
      ['impressum', 'hop', 'not-found', 200],
      ['privacy', 'hop', 'not-found', 200],
      ['impressum', 'fallback', 'not-found', 404],
      ['privacy', 'fallback', 'not-found', 404],
    ]);

    const fallback = run.result.sections.browser?.phases[0]?.pages.find((p) => p.role === 'fallback');
    expect(fallback).toMatchObject({ evaluable: false, notEvaluableReason: 'http-404' });
  });
});

site('dse', (get) => {
  const documentOf = (kind: 'impressum' | 'privacy') =>
    (get().run.result.sections.documents?.documents ?? []).find((d) => d.kind === kind);

  /** The texts of the policy parts that were read from `origin`. */
  const partsFrom = (origin: string) =>
    (documentOf('privacy')?.parts ?? []).filter((p) => p.origin === origin).map((p) => p.text);

  it('a PDF Impressum is found but not evaluated', () => {
    expect(documentOf('impressum')).toMatchObject({
      format: 'pdf',
      complete: false,
      errors: ['pdf-not-evaluated'],
      url: 'https://www.example.test/impressum.pdf',
      foundVia: 'link',
    });
  });

  it('the privacy policy is a complete HTML document with a hash and the link it was found by', () => {
    const dse = documentOf('privacy');

    expect(dse).toMatchObject({
      url: 'https://www.example.test/datenschutz/',
      status: 200,
      format: 'html',
      lang: 'de',
      complete: true,
      errors: [],
    });
    expect(dse?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dse?.linkedFrom).toEqual([{ pageUrl: 'https://www.example.test/', text: 'Datenschutz' }]);
  });

  it('the policy parts keep their origin: visible, expandable, hidden, frame', () => {
    expect(partsFrom('visible').join(' ')).toContain('Google Analytics 4 der Google Ireland Limited');
    expect(partsFrom('expandable')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Matomo setzt keine Cookies'),
        expect.stringContaining('Google Fonts werden lokal'),
      ]),
    );
    expect(partsFrom('hidden-irrelevant').join(' ')).toContain('Verstecktes Navigationsfragment');
    expect(partsFrom('frame').join(' ')).toContain('Beispiel Hosting GmbH');
    // What sits in an expandable section is not attributed to the visible text.
    expect(partsFrom('visible').join(' ')).not.toContain('Matomo');
  });

  it('the policy parts carry their section path; the manifest counts expandables and frames', () => {
    const dse = documentOf('privacy');

    const analyse = dse?.parts.find((p) => p.text.includes('Google Analytics 4'));
    expect(analyse?.section).toBe('Datenschutzerklärung > 2. Analyse');
    expect(dse?.manifest).toMatchObject({ expandablesFound: 2, expandablesOpened: 2, framesIncluded: 1 });
  });
});

site('cookies', (get) => {
  it('records cookies with flags, lifetime, setter and length — never values', () => {
    const a = get().run.result.sections.browser?.phases[0];
    const byName = (n: string) => a?.cookies.find((c) => c.name === n && c.state === 'accepted');
    expect(byName('sid')).toMatchObject({
      domain: 'www.example.test',
      firstParty: true,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      setter: 'http-response',
      setterHost: 'www.example.test',
      lifetime: { kind: 'session' },
      length: 'SECRET_HTTP_VALUE_1'.length,
    });
    expect(byName('pref')?.lifetime.kind).toBe('persistent');
    expect(byName('js_cookie')).toMatchObject({
      setter: 'script',
      httpOnly: false,
      length: 'SECRET_JS_VALUE_3'.length,
    });
    expect(byName('uid')).toMatchObject({
      domain: 'tracker.example.net',
      firstParty: false,
      sameSite: 'None',
      setter: 'http-response',
      setterHost: 'tracker.example.net',
    });
    // Set and deleted by script before the snapshot: a transient write is still observed.
    expect(a?.cookies.find((c) => c.name === 'tmp_probe')).toMatchObject({
      state: 'attempted',
      setter: 'script',
    });
  });

  it('records Web Storage keys with value lengths and IndexedDB names', () => {
    const storage = get().run.result.sections.browser?.phases[0]?.storage ?? [];
    expect(storage.map((s) => [s.storageType, s.origin, s.key, s.length, s.firstParty])).toEqual(
      expect.arrayContaining([
        ['localStorage', 'https://www.example.test', 'ls_key', 'SECRET_LS_VALUE_5'.length, true],
        ['sessionStorage', 'https://www.example.test', 'ss_key', 'SECRET_SS_VALUE_6'.length, true],
        ['indexedDB', 'https://www.example.test', 'idb_test_db', undefined, true],
      ]),
    );
  });

  it('no cookie, storage or query value reaches the collector output', () => {
    const { run } = get();

    const text = persisted(run);

    for (let i = 1; i <= 8; i++) expect(text).not.toMatch(new RegExp(`SECRET_[A-Z0-9]+_VALUE_${i}`));
    const pixel = run.requests.find((r) => r.host === 'tracker.example.net');
    expect(pixel).toMatchObject({
      // `id` keeps its value only for tag/account ids (core QUERY_VALUE_RULES); `site-1` is not one.
      url: 'https://tracker.example.net/pixel.gif?uid=[redacted]&id=[redacted]',
      identifierNames: ['uid'],
      setCookieNames: ['uid'],
    });
  });
});

describe('video (stub CMP, phases A and B)', () => {
  const ORIGIN = 'https://www.example.test';
  const VIDEOS = `${ORIGIN}/videos/`;
  const HISTORY = `${ORIGIN}/unternehmen/geschichte/`;
  const THUMBNAIL = 'https://i.ytimg.com/vi/fixture/hqdefault.jpg';
  let server: FixtureServer;
  let run: CollectRun;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/video'] });
    run = await collect(server, { deps: { cmp: stubCmpApi(), phases: ['A', 'B'] } });
  });

  afterAll(async () => {
    await server?.close();
  });

  const phase = (p: 'A' | 'B') => run.result.sections.browser?.phases.find((x) => x.phase === p);
  /** The collected sections as a snapshot with `derived`, to run the checks over a real collection. */
  const snapshotOf = (): Snapshot => {
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
  };

  it('plans the video page by its keyword and the history page, and rechecks both after the reject', () => {
    const plan = run.result.sections.plan;
    expect(plan?.pages.find((p) => p.url === VIDEOS)?.reasons).toEqual(['keyword:video']);
    expect(plan?.pages.map((p) => p.url)).toContain(HISTORY);
    expect(plan?.controlPages.map((p) => p.url).sort()).toEqual([HISTORY, VIDEOS]);
    expect(phase('B')?.click).toMatchObject({ action: 'reject', success: true });
  });

  it('the thumbnail of the history page is a request of the page itself, before the interaction and after the reject', () => {
    const thumbnails = (p: 'A' | 'B') =>
      (phase(p)?.requests ?? [])
        .filter((r) => r.url === THUMBNAIL)
        .map((r) => [r.pageUrl, r.isMainFrame, r.afterClick, r.resourceType]);
    expect(thumbnails('A')).toEqual([[HISTORY, true, false, 'image']]);
    expect(thumbnails('B')).toEqual([[HISTORY, true, true, 'image']]);
  });

  it('the two player frames of the video page store names only, never values', () => {
    const storage = (phase('A')?.storage ?? []).filter(
      (s) => s.origin === 'https://www.youtube-nocookie.com',
    );
    expect([...new Set(storage.map((s) => `${s.storageType}:${s.key}`))].sort()).toEqual([
      'indexedDB:YtIdbMeta',
      'localStorage:ytidb::LAST_RESULT_ENTRY_KEY',
    ]);
    expect(persisted(run)).not.toMatch(/SECRET_PLAYER_VALUE_\d/);
  });

  it('EMBED-03 over the collection: the thumbnail as YouTube, the players as youtube-nocookie, both after the confirmed reject', () => {
    const snapshot = snapshotOf();
    const found = observationsOf(runCheck(embed03, snapshot));
    expect(
      found.map((o) => [
        o.subject,
        o.pages,
        o.params.integrationType,
        o.params.moment,
        o.params.rejectConfirmed,
      ]),
    ).toEqual([
      ['youtube', [HISTORY], 'thumbnail', 'before-and-after-reject', true],
      ['youtube-nocookie', [VIDEOS], 'iframe', 'before-and-after-reject', true],
    ]);
    const [thumbnail] = found;
    expect(
      thumbnail?.evidence.some(
        (e) => e.type === 'request' && e.url === THUMBNAIL && e.phase === 'B' && !e.beforeClick,
      ),
    ).toBe(true);
    expect(thumbnail?.evidence.filter((e) => e.type === 'consent-state')).toHaveLength(2);
    expect(renderMessage(loadTexts('de'), 'EMBED-03.video-loaded', thumbnail!.params).title).toBe(
      'Externer Videodienst geladen, auch nach bestätigter Ablehnung: YouTube',
    );
  });

  it('the report links the players to their stored entries and holds no value', () => {
    const snapshot = snapshotOf();
    const checks = [consent01, consent02, embed03];
    const out = assess({
      checks,
      executed: new Map(checks.map((c) => [c.id, runCheck(c, snapshot)])),
      ruleset: loadRuleset(),
      routing: loadRouting(),
      texts: loadTexts('de'),
    });
    const player = out.findings.find((f) => f.checkId === 'EMBED-03' && f.subject === 'youtube-nocookie');
    const stored = out.findings.find((f) => f.checkId === 'CONSENT-02' && f.serviceId === 'youtube-nocookie');
    expect(player?.related).toContainEqual(
      expect.objectContaining({
        checkId: 'CONSENT-02',
        fingerprint: stored?.fingerprint,
        relation: 'same-service',
      }),
    );
    expect(JSON.stringify(out)).not.toMatch(/SECRET_PLAYER_VALUE_\d/);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
