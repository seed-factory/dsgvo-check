/** The localized legal-link lexicon determines which page and banner links count as covered. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extract } from '../../../src/cmp/index.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { page as html, type SiteDir, writeSite } from '../browser/site-dir.ts';

interface Footer {
  /** [label, href] of the links of the footer. */
  links: ReadonlyArray<readonly [string, string]>;
  /** Where the fixed bar sits: at the bottom it covers the footer, at the top it does not. */
  bar: 'bottom' | 'top';
  inBanner?: ReadonlyArray<readonly [string, string]>;
}

function pageOf({ links, bar, inBanner = [] }: Footer): string {
  const anchors = (list: ReadonlyArray<readonly [string, string]>) =>
    list.map(([label, href]) => `<a href="${href}">${label}</a>`).join(' · ');
  return html(
    `<main><h1>Exemple</h1></main>
    <footer>${anchors(links)}</footer>
    <style>
      html, body { height: 100%; margin: 0; font-family: sans-serif; }
      main { padding: 24px; }
      footer { position: absolute; bottom: 0; left: 0; right: 0; height: 40px; padding: 10px 24px; background: #eee; }
      .notice { position: fixed; left: 0; right: 0; ${bar}: 0; height: 90px; background: #222; color: #fff; padding: 12px 24px; z-index: 50; box-sizing: border-box; }
      .notice button, .notice a { margin-right: 8px; color: #fff; }
    </style>
    <div class="notice">
      <p style="margin:0 0 8px">Diese Seite nutzt Cookies und Tracking von Drittanbietern. ${anchors(inBanner)}</p>
      <button type="button">Akzeptieren</button>
      <button type="button">Ablehnen</button>
    </div>`,
  );
}

const LANGUAGES: Array<{ lang: string; legal: [string, string]; privacy: [string, string] }> = [
  {
    lang: 'fr',
    legal: ['Mentions légales', '/mentions-legales'],
    privacy: ['Politique de confidentialité', '/confidentialite'],
  },
  { lang: 'es', legal: ['Aviso legal', '/aviso-legal'], privacy: ['Política de privacidad', '/privacidad'] },
  {
    lang: 'it',
    legal: ['Note legali', '/note-legali'],
    privacy: ['Informativa sulla privacy', '/privacy'],
  },
  {
    lang: 'pl',
    legal: ['Informacje prawne', '/informacje-prawne'],
    privacy: ['Polityka prywatności', '/prywatnosc'],
  },
  { lang: 'en', legal: ['Legal Notice', '/legal-notice'], privacy: ['Privacy Policy', '/privacy-policy'] },
];

const FILES: Record<string, string> = {};
for (const l of LANGUAGES) {
  FILES[`${l.lang}-covered.html`] = pageOf({ links: [l.legal, l.privacy], bar: 'bottom' });
  FILES[`${l.lang}-open.html`] = pageOf({ links: [l.legal, l.privacy], bar: 'top' });
}
FILES['fr-no-legal.html'] = pageOf({
  links: [
    ['Nos produits', '/produits'],
    ['Nous contacter', '/contact'],
    ['Paramètres de confidentialité', '#parametres'],
  ],
  bar: 'bottom',
});
FILES['de-settings.html'] = pageOf({
  links: [
    ['Datenschutz-Einstellungen', '#einstellungen'],
    ['Unsere Produkte', '/produkte'],
  ],
  bar: 'bottom',
});
FILES['fr-banner-links.html'] = pageOf({
  links: [['Nos produits', '/produits']],
  bar: 'bottom',
  inBanner: [
    ['Politique de confidentialité', '/confidentialite'],
    ['En savoir plus sur notre société', '/societe'],
  ],
});
FILES['de-banner-links.html'] = pageOf({
  links: [['Nos produits', '/produits']],
  bar: 'bottom',
  inBanner: [
    ['Datenschutzerklärung', '/datenschutz'],
    ['Mehr über uns', '/ueber-uns'],
  ],
});

let server: FixtureServer;
let site: SiteDir;
let browser: TestBrowser;

beforeAll(async () => {
  site = writeSite(FILES);
  server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
  browser = await launchTestBrowser(server);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  site?.cleanup();
});

async function facts(file: string) {
  const p = await browser.context.newPage();
  try {
    await p.goto(`https://www.example.test/${file}`, { waitUntil: 'load' });
    const f = await extract(p, null, 'first-screen');
    expect(f.detection.method, `${file}: the generic heuristic finds the bar`).toBe('heuristic');
    expect(f.firstLayer.bannerVisible).toBe(true);
    expect(
      f.firstLayer.buttons
        .filter((b) => b.role !== 'link')
        .map((b) => b.kind)
        .sort(),
    ).toEqual(['accept', 'reject']);
    return f.firstLayer;
  } finally {
    await p.close();
  }
}

describe('the legal-link lexicon decides which covered links count', () => {
  for (const l of LANGUAGES) {
    it(`${l.lang}: Impressum and privacy links under the banner are observed as covered`, async () => {
      const layer = await facts(`${l.lang}-covered.html`);
      expect(layer.coversFooter).toBe(true);
      expect(layer.coveredFooterLinks?.map((x) => x.label)).toEqual([l.legal[0], l.privacy[0]]);
      expect(layer.coveredFooterLinks?.every((x) => x.coveredBy === 'banner')).toBe(true);
    });

    it(`${l.lang}: counterexample, the same links without an overlap are not covered`, async () => {
      const layer = await facts(`${l.lang}-open.html`);
      expect(layer.coversFooter ?? false).toBe(false);
      expect(layer.coveredFooterLinks ?? []).toEqual([]);
    });
  }

  it('counterexample: links that name no legal document, and a cookie settings link, under the banner are not reported', async () => {
    const layer = await facts('fr-no-legal.html');
    expect(layer.coversFooter ?? false).toBe(false);
    expect(layer.coveredFooterLinks ?? []).toEqual([]);
  });

  it('counterexample: "Datenschutz-Einstellungen" opens the settings dialog, it is no document link', async () => {
    const layer = await facts('de-settings.html');
    expect(layer.coversFooter ?? false).toBe(false);
    expect(layer.coveredFooterLinks ?? []).toEqual([]);
  });
});

describe('the legal links of the banner itself', () => {
  it('a French privacy link in the banner is listed, a link that names no document is not', async () => {
    const layer = await facts('fr-banner-links.html');
    expect(layer.legalLinks?.map((l) => l.text)).toEqual(['Politique de confidentialité']);
  });

  it('counterexample: a German privacy link in the banner is still listed', async () => {
    const layer = await facts('de-banner-links.html');
    expect(layer.legalLinks?.map((l) => l.text)).toEqual(['Datenschutzerklärung']);
  });
});
