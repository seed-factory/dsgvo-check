/**
 * The real collector with the real CMP subsystem stores no e-mail local part from page text the CMP probe copies:
 * banner control names, banner legal link text, covered footer link labels and click selectors. Markers start with `zq7`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { type CollectRun, collect, persisted } from '../helpers.ts';
import { page, type SiteDir, writeSite } from '../site-dir.ts';

const INDEX = page(`
  <main><h1>Beispiel Kanzlei</h1></main>
  <footer>
    <a href="/datenschutz/" aria-label="Datenschutz – Fragen an zq7dpo@example.test">Datenschutz</a>
    <a href="/impressum/">zq7text@example.test (Impressum)</a>
  </footer>
  <style>
    html, body { height: 100%; margin: 0; }
    footer { position: absolute; bottom: 0; left: 0; right: 0; height: 40px; padding: 10px 24px; }
    .consent { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #222; color: #fff; padding: 12px 24px; z-index: 50; box-sizing: border-box; }
    .consent button, .consent a { margin-right: 8px; color: #fff; }
  </style>
  <div class="consent" role="dialog" aria-label="Cookies">
    <p style="margin:0">Diese Seite nutzt Cookies und Tracking von Drittanbietern.</p>
    <button type="button">Alle akzeptieren</button>
    <button type="button">Ablehnen</button>
    <button type="button" aria-label="Einstellungen – Fragen an zq7btn@example.test">Einstellungen</button>
    <a href="/datenschutz/">Datenschutz – Fragen an zq7cmp@example.test</a>
  </div>`);

let server: FixtureServer;
let site: SiteDir;
let run: CollectRun;

beforeAll(async () => {
  site = writeSite({ 'index.html': INDEX });
  server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
  run = await collect(server, { maxPages: 1 });
});

afterAll(async () => {
  await server?.close();
  site?.cleanup();
});

const cmpFacts = () => run.result.sections.cmp?.phases.flatMap((p) => p.facts) ?? [];

describe('CMP facts: text copied from the page', () => {
  it('the banner is recognized by the heuristic and covers the footer links (the scenario is real)', () => {
    const f = cmpFacts().find((x) => x.firstLayer.bannerPresent);
    expect(f?.detection.method).toBe('heuristic');
    expect(f?.firstLayer.coveredFooterLinks?.length ?? 0).toBeGreaterThan(0);
    expect(f?.firstLayer.buttons.some((b) => b.name.startsWith('Einstellungen'))).toBe(true);
  });

  it('masks the address in the names of controls, the text of legal links and the labels of covered footer links', () => {
    const f = cmpFacts().find((x) => x.firstLayer.bannerPresent);
    expect(f?.firstLayer.buttons.map((b) => b.name)).toContain(
      'Einstellungen – Fragen an [redacted]@example.test',
    );
    expect(f?.firstLayer.legalLinks?.map((l) => l.text)).toContain(
      'Datenschutz – Fragen an [redacted]@example.test',
    );
    expect(f?.firstLayer.coveredFooterLinks?.map((l) => l.label)).toEqual(
      expect.arrayContaining(['Datenschutz – Fragen an [redacted]@example.test']),
    );
  });

  it('no local part anywhere in what the collector persists (also not in a selector)', () => {
    expect(persisted(run)).not.toContain('zq7');
  });

  it('counterexample: the controls stay usable, a selector is still recorded for the accept button', () => {
    const f = cmpFacts().find((x) => x.firstLayer.bannerPresent);
    const accept = f?.firstLayer.buttons.find((b) => b.name === 'Alle akzeptieren');
    expect(accept?.selector).toBeTruthy();
    const settings = f?.firstLayer.buttons.find((b) => b.name.startsWith('Einstellungen'));
    expect(settings?.selector).toBeTruthy();
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
