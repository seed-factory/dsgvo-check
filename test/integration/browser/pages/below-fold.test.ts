/**
 * Content below the first screen: after the first-screen facts of a page the viewport is enlarged to the document
 * height, without any scroll or input event, so a lazy map far down the contact page loads in phase A and again after
 * the click in B and C. The banner facts and the screenshot keep the first screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import { derive } from '../../../../src/derive/index.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { stubCmpApi } from '../consent/stub-cmp.ts';
import { type CollectRun, collect } from '../helpers.ts';
import { page as html, type SiteDir, writeSite } from '../site-dir.ts';

const ORIGIN = 'https://www.example.test';
const START = `${ORIGIN}/`;
const KONTAKT = `${ORIGIN}/kontakt/`;
const MAP = 'https://www.google.com/maps/embed?pb=[redacted]';
const FONT = 'https://fonts.gstatic.com/s/roboto/v30/fixture-roboto.woff2';

describe('content below the first screen', () => {
  let server: FixtureServer;
  /** Phases A, B and C with the built-in settings. */
  let run: CollectRun;
  /** Phase A with DSGVO_CHECK_BROWSER_REVEAL_DWELL_MS=0. */
  let off: CollectRun;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/lazy-embed'] });
    run = await collect(server, { deps: { cmp: stubCmpApi(), phases: ['A', 'B', 'C'] } });
    off = await collect(server, { deps: { cmp: stubCmpApi() }, config: { browser: { revealDwellMs: 0 } } });
  });

  afterAll(async () => {
    await server?.close();
  });

  const phase = (r: CollectRun, p: 'A' | 'B' | 'C'): PhaseRecord => {
    const found = r.result.sections.browser?.phases.find((x) => x.phase === p);
    if (!found) throw new Error(`no phase ${p}`);
    return found;
  };
  const visit = (r: CollectRun, p: 'A' | 'B' | 'C', url: string) =>
    phase(r, p).pages.find((v) => v.finalUrl === url && !v.reload);
  const cookieNames = (r: CollectRun) =>
    (r.result.sections.browser?.phases ?? []).flatMap((p) => p.cookies.map((c) => `${p.phase}:${c.name}`));

  it('runs every phase to the end', () => {
    expect(run.result.status).toBe('ok');
    expect(run.result.sections.browser?.phases.map((p) => [p.phase, p.status])).toEqual([
      ['A', 'completed'],
      ['B', 'completed'],
      ['C', 'completed'],
    ]);
  });

  it('the lazy map far below Kontakt loads after the reveal, and its frame loads the Google font', () => {
    const a = phase(run, 'A');
    const embed = a.requests.find((r) => r.url === MAP && r.resourceType === 'document');
    const font = a.requests.find((r) => r.url === FONT);

    expect(embed).toMatchObject({
      pageUrl: KONTAKT,
      isMainFrame: false,
      afterReveal: true,
      afterClick: false,
    });
    expect(font).toMatchObject({ pageUrl: KONTAKT, frameUrl: MAP, resourceType: 'font', afterReveal: true });
    // The page itself was loaded before: only what the larger viewport brought is marked.
    const page = a.requests.find(
      (r) => r.pageUrl === KONTAKT && r.isMainFrame && r.resourceType === 'document',
    );
    expect(page?.afterReveal).toBeUndefined();
    expect(visit(run, 'A', KONTAKT)?.reveal).toMatchObject({ outcome: 'revealed', quietReached: true });
    expect(visit(run, 'A', KONTAKT)?.reveal?.capped).toBeUndefined();
  });

  it('derive keeps the font with the map and names its own service', () => {
    const snapshot = {
      ...run.ctx.snapshot,
      browser: run.result.sections.browser,
      cmp: run.result.sections.cmp,
      documents: run.result.sections.documents,
    };
    const fontId = phase(run, 'A').requests.find((r) => r.url === FONT)?.id;
    const font = derive(snapshot).requests.find((c) => c.requestId === fontId);

    expect(font).toMatchObject({
      serviceId: 'google-maps',
      source: 'embed-frame',
      resourceServiceId: 'google-fonts',
      timing: 'before-interaction',
    });
  });

  it('after the reject, the control page Kontakt shows the map below its first screen again', () => {
    const b = phase(run, 'B');
    expect(b.requests.find((r) => r.url === MAP && r.resourceType === 'document')).toMatchObject({
      pageUrl: KONTAKT,
      afterClick: true,
      afterReveal: true,
    });
  });

  it('counterexample: with the reveal switched off the map never loads, and the gap is named', () => {
    expect(off.requests.filter((r) => r.host === 'www.google.com')).toEqual([]);
    expect(off.result.sections.browser?.knownGaps).toContain('below-fold-not-revealed');
    expect(visit(off, 'A', KONTAKT)?.reveal).toBeUndefined();
    expect(run.result.sections.browser?.knownGaps).not.toContain('below-fold-not-revealed');
  });

  it('counterexample: the page sees its viewport change, but never a scroll', () => {
    const names = cookieNames(run);
    expect(names).toContain('A:kontakt_resized');
    expect(names.filter((n) => n.endsWith('kontakt_scrolled'))).toEqual([]);
  });

  it('counterexample: a banner that takes scrolling as consent registers none', () => {
    const a = phase(run, 'A');
    expect(cookieNames(run).filter((n) => n.startsWith('A:stub_consent'))).toEqual([]);
    expect(a.requests.filter((r) => r.host === 'www.googletagmanager.com')).toEqual([]);
    const cmpA = run.result.sections.cmp?.phases.find((p) => p.phase === 'A');
    expect(new Set(cmpA?.facts.map((f) => f.state[0]?.categories.analytics))).toEqual(new Set(['unknown']));
    // After the reject nothing grants it either: the reveal of the reload and of Kontakt leaves the state denied.
    const b = phase(run, 'B');
    expect(b.requests.filter((r) => r.host === 'www.googletagmanager.com')).toEqual([]);
    expect(run.result.sections.cmp?.phases.find((p) => p.phase === 'B')?.verify).toMatchObject({
      verified: true,
      persistedAfterReload: true,
    });
  });

  it('the banner facts and the screenshot are taken on the first screen, before any reveal', () => {
    const facts = (run.result.sections.cmp?.phases ?? []).flatMap((p) => p.facts);
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts)
      expect(f.viewport, `${f.phase} ${f.moment} ${f.pageUrl}`).toEqual({ width: 1366, height: 768 });

    const first = facts.find((f) => f.phase === 'B' && f.moment === 'first-screen');
    expect(first?.firstLayer.buttons.length).toBeGreaterThan(0);
    for (const b of first?.firstLayer.buttons ?? []) {
      expect((b.box?.y ?? 0) + (b.box?.height ?? 0)).toBeLessThanOrEqual(768);
    }
    const [shot] = run.result.sections.browser?.screenshots ?? [];
    expect(shot).toMatchObject({ phase: 'B', width: 1366 });
    expect(shot?.height).toBeLessThanOrEqual(768);
  });

  it('B shows the start page below its first screen only after the click, on the reload', () => {
    const pages = phase(run, 'B').pages.filter((v) => v.finalUrl === START);
    expect(pages.map((v) => [v.reload ?? false, v.reveal?.outcome])).toEqual([
      [false, undefined],
      [true, 'revealed'],
    ]);
  });

  it('counterexample: a page that fits the viewport is not resized', () => {
    expect(visit(run, 'A', `${ORIGIN}/impressum/`)?.reveal).toMatchObject({ outcome: 'fits-viewport' });
    expect(cookieNames(run).filter((n) => n.endsWith('impressum_resized'))).toEqual([]);
  });

  it('a page taller than the largest viewport is shown down to the cap', () => {
    const reveal = visit(run, 'A', `${ORIGIN}/ueber-uns/`)?.reveal;
    expect(reveal).toMatchObject({ outcome: 'revealed', viewportHeightPx: 10_000, capped: true });
    expect(reveal?.documentHeightPx).toBeGreaterThan(20_000);
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});

describe('a page with a section as tall as the viewport above its content', () => {
  let server: FixtureServer;
  let site: SiteDir;
  let run: CollectRun;

  beforeAll(async () => {
    // The hero grows with the enlarged viewport, so the lazy frame keeps its distance below it and never loads.
    site = writeSite({
      'index.html': html(`
        <section style="height:100vh">Willkommen</section>
        <div style="height:4000px">Inhalt</div>
        <iframe loading="lazy" src="/karte/" width="600" height="400" title="Karte"></iframe>
        <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>`),
      'karte/index.html': html('<p>Karte</p>'),
      'impressum/index.html': html('<h1>Impressum</h1>'),
      'datenschutz/index.html': html('<h1>Datenschutzerklärung</h1>'),
    });
    server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
    run = await collect(server);
  });

  afterAll(async () => {
    await server?.close();
    site?.cleanup();
  });

  it('is recorded as not shown to its end, like a page taller than the cap', () => {
    const a = run.result.sections.browser?.phases.find((p) => p.phase === 'A');
    const start = a?.pages.find((p) => p.finalUrl === START);
    expect(start?.reveal).toMatchObject({ outcome: 'revealed', capped: true });
    expect(start?.reveal?.viewportHeightPx).toBeLessThan(10_000);
    expect(server.requests.map((r) => r.path)).not.toContain('/karte/');
  });
});

describe('a host that throttles what the reveal loads', () => {
  let server: FixtureServer;
  let site: SiteDir;
  let run: CollectRun;

  beforeAll(async () => {
    const lazy = [1, 2, 3].map(
      (i) => `<img loading="lazy" src="/busy-${i}.png" width="10" height="10" alt="">`,
    );
    site = writeSite({
      'index.html': html(`
        <nav><a href="/kontakt/">Kontakt</a></nav>
        <div style="height:9000px">Willkommen</div>${lazy.join('')}
        <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>`),
      'impressum/index.html': html('<h1>Impressum</h1>'),
      'datenschutz/index.html': html('<h1>Datenschutzerklärung</h1>'),
      'kontakt/index.html': html('<h1>Kontakt</h1>'),
    });
    server = await startFixtureServer({
      hosts: { 'www.example.test': site.root },
      routes: [
        {
          host: 'www.example.test',
          path: '^/busy-\\d\\.png$',
          pathRegex: true,
          status: 503,
          headers: { 'retry-after': '0', 'content-type': 'text/plain' },
          body: 'busy',
        },
      ],
    });
    run = await collect(server);
  });

  afterAll(async () => {
    await server?.close();
    site?.cleanup();
  });

  it('gets no further navigation once the images below the first screen were answered with 503', () => {
    const a = run.result.sections.browser?.phases.find((p) => p.phase === 'A');
    expect(a?.requests.filter((r) => r.status === 503 && r.afterReveal).length).toBe(3);
    expect(a).toMatchObject({ status: 'partial', reason: 'throttled' });
    expect(a?.pages.map((p) => p.url)).toEqual([START]);
    expect(server.requests.map((r) => r.path)).not.toContain('/impressum/');
  });
});

describe('a page that scrolled itself before the reveal', () => {
  let server: FixtureServer;
  let site: SiteDir;
  let run: CollectRun;

  beforeAll(async () => {
    // A taller window makes the document short (a media query on the height): resizing the scrolled page would move it
    // back to the top, which the browser reports as a scroll.
    const style =
      '<style>body{margin:0;height:5000px}@media (min-height:1000px){body{height:1000px}}</style>';
    const script = `<script>
      window.scrollTo(0, 1000);
      setTimeout(function () {
        window.addEventListener('scroll', function () { document.cookie = 'scrolled_later=1; path=/'; });
      }, 100);
    </script>`;
    site = writeSite({
      'index.html': html(
        `<footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutz</a></footer>${script}`,
        style,
      ),
      'impressum/index.html': html('<h1>Impressum</h1>'),
      'datenschutz/index.html': html('<h1>Datenschutzerklärung</h1>'),
    });
    server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
    run = await collect(server);
  });

  afterAll(async () => {
    await server?.close();
    site?.cleanup();
  });

  it('is left as it is, and no scroll reaches it', () => {
    const a = run.result.sections.browser?.phases.find((p) => p.phase === 'A');
    expect(a?.pages.find((p) => p.url === START)?.reveal).toMatchObject({ outcome: 'scrolled' });
    expect(a?.cookies.filter((c) => c.name === 'scrolled_later')).toEqual([]);
  });
});
