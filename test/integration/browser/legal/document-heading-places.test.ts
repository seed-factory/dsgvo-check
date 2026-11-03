/**
 * Which headings confirm the type of a fetched legal page: only those of the content, not of navigation, aside, footer,
 * page-level header or hidden elements (one chrome/content classifier also serves the manifest). Real Chromium.
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractDocument } from '../../../../src/collectors/browser/legal/documents.ts';
import type { DocumentKind } from '../../../../src/core/snapshot/browser.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../../utils/browser.ts';
import { type SiteDir, writeSite } from '../site-dir.ts';

const LOREM =
  'Wir verarbeiten personenbezogene Daten ausschließlich im Rahmen der gesetzlichen Vorgaben. Diese Erklärung beschreibt, welche Daten beim Besuch dieser Website anfallen und wie lange sie gespeichert werden. ';
const BODY_TEXT = `<p>${LOREM.repeat(6)}</p>`;

let server: FixtureServer;
let site: SiteDir;
let browser: TestBrowser;
let tab: Page;
const files: Record<string, string> = {};
let seq = 0;

/** Registers a page and returns its path. */
function add(body: string, title = 'Muster GmbH'): string {
  const name = `p${++seq}`;
  files[`${name}/index.html`] =
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  return `/${name}/`;
}

// The pages are registered before the server starts (the site directory is written once).
interface Row {
  label: string;
  kind: DocumentKind;
  path: string;
}
const rows: Record<string, Row> = {};
function row(key: string, label: string, kind: DocumentKind, body: string, title?: string): void {
  rows[key] = { label, kind, path: add(body, title) };
}

const IMPRESSUM_BODY = `<p>Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. ${LOREM.repeat(2)}</p>`;
const NAV_H1: Array<[string, string, DocumentKind, string]> = [
  ['nav', 'h1 "Impressum" in a nav', 'impressum', '<nav><h1>Impressum</h1></nav>'],
  ['aside', 'h1 "Impressum" in an aside', 'impressum', '<aside><h1>Impressum</h1></aside>'],
  ['footer', 'h1 "Impressum" in the page footer', 'impressum', '<footer><h1>Impressum</h1></footer>'],
  [
    'site-header',
    'h1 "Impressum" in a site header',
    'impressum',
    '<div class="site-header"><h1>Impressum</h1></div>',
  ],
  [
    'hidden-wrapper',
    'h1 "Datenschutzerklärung" in a hidden element',
    'privacy',
    '<div style="display:none"><h1>Datenschutzerklärung</h1></div>',
  ],
  ['hidden-attr', 'hidden h1 "Datenschutzerklärung"', 'privacy', '<h1 hidden>Datenschutzerklärung</h1>'],
  [
    'nav-privacy',
    'h1 "Datenschutzerklärung" in a nav',
    'privacy',
    '<nav><h1>Datenschutzerklärung</h1></nav>',
  ],
];
for (const [key, label, kind, chrome] of NAV_H1) {
  row(
    `h1-${key}`,
    label,
    kind,
    `${chrome}<main><h2>Leistungen</h2>${kind === 'privacy' ? BODY_TEXT : IMPRESSUM_BODY}</main>`,
  );
}
// counterexamples: the h1 of the content confirms; a chrome h1 in front of it does not hide it; the title counts
row(
  'h1-content',
  'h1 "Impressum" in main',
  'impressum',
  `<nav><a href="/">Start</a></nav><main><h1>Impressum</h1>${IMPRESSUM_BODY}</main>`,
);
row(
  'h1-after-nav-h1',
  'a nav h1 in front of the h1 of the policy',
  'privacy',
  `<nav><h1>Menü</h1></nav><main><h1>Datenschutzerklärung</h1>${BODY_TEXT}</main>`,
);
row(
  'h1-nav-same-text-as-content',
  'the same text as nav h1 and as content h1',
  'impressum',
  `<nav><h1>Impressum</h1></nav><main><h1>Impressum</h1>${IMPRESSUM_BODY}</main>`,
);
row(
  'h1-article-header',
  'h1 in a header inside an article',
  'privacy',
  `<nav><a href="/">Start</a></nav><article><header><h1>Datenschutzerklärung</h1></header>${BODY_TEXT}</article>`,
);
row(
  'h1-nav-title-confirms',
  'chrome h1, the title names the document',
  'impressum',
  `<nav><h1>Impressum</h1></nav><main><h2>Leistungen</h2>${IMPRESSUM_BODY}</main>`,
  'Impressum – Muster GmbH',
);

/** A wrapper with a heading that carries the only marker and a collapsed panel. `content`: both count as content. */
const WRAPPERS: Array<[string, string, string, 'content' | 'chrome']> = [
  ['accordion-header', '<div class="accordion-header">', '</div>', 'content'],
  ['card-header', '<div class="card-header">', '</div>', 'content'],
  ['panel-header', '<div class="panel-header">', '</div>', 'content'],
  ['card-footer', '<div class="card-footer">', '</div>', 'content'],
  ['el-collapse-item__header', '<div class="el-collapse-item__header">', '</div>', 'content'],
  ['in main', '<main>', '</main>', 'content'],
  ['article > header', '<article><header>', '</header></article>', 'content'],
  ['site-header', '<div class="site-header">', '</div>', 'chrome'],
  ['header-menu', '<div class="header-menu">', '</div>', 'chrome'],
  ['footer-panel', '<div class="footer-panel">', '</div>', 'chrome'],
  ['page_footer', '<div class="page_footer">', '</div>', 'chrome'],
  ['id=header', '<div id="header">', '</div>', 'chrome'],
  ['offcanvas', '<div class="offcanvas">', '</div>', 'chrome'],
  ['bare header', '<header>', '</header>', 'chrome'],
  ['bare footer', '<footer>', '</footer>', 'chrome'],
  ['nav', '<nav>', '</nav>', 'chrome'],
  ['aside', '<aside>', '</aside>', 'chrome'],
  ['role=banner', '<div role="banner">', '</div>', 'chrome'],
  // the footer of an ambiguous noun (section, block, item, entry, post, article) is a footer of the page more
  // often than a bar of a component; its header stays a bar of a component.
  ['section-header', '<div class="section-header">', '</div>', 'content'],
  ['section-footer', '<div class="section-footer">', '</div>', 'chrome'],
  ['block-footer', '<div class="block-footer">', '</div>', 'chrome'],
  ['item-footer', '<div class="item-footer">', '</div>', 'chrome'],
  ['entry-footer', '<div class="entry-footer">', '</div>', 'chrome'],
  ['post-footer', '<div class="post-footer">', '</div>', 'chrome'],
  // a state of the layout names no page part; the same word as a part (a token of its own) still does
  ['has-header', '<div class="has-header">', '</div>', 'content'],
  ['with-fixed-header', '<div class="page with-fixed-header">', '</div>', 'content'],
  ['has-header + header', '<div class="has-header header">', '</div>', 'chrome'],
];
const wrapperPath: Record<string, string> = {};
for (const [name, open, close] of WRAPPERS) {
  wrapperPath[name] = add(
    `<h1>Rechtliches</h1>${open}<h2>Datenschutzerklärung</h2>` +
      `<button aria-expanded="false" aria-controls="pan">Mehr</button><div id="pan" hidden>Text im Panel</div>${close}` +
      `<div>${BODY_TEXT}</div>`,
    'Rechtliches',
  );
}

const FOOTER_COLUMN: Array<[string, string]> = [
  ['section-footer', 'section-footer'],
  ['block-footer', 'block-footer'],
  ['item-footer', 'item-footer'],
];
for (const [key, cls] of FOOTER_COLUMN) {
  row(
    `footer-column-${key}`,
    `a footer column "Impressum" in div.${cls}`,
    'impressum',
    `<div class="${cls}"><h4>Impressum</h4><a href="/x">x</a></div><div><h2>Willkommen</h2>${IMPRESSUM_BODY}</div>`,
  );
}

row(
  'footer-column-with-content',
  'a footer column "Impressum" and the same heading in the content',
  'impressum',
  `<div class="section-footer"><h4>Impressum</h4></div><main><h2>Impressum</h2>${IMPRESSUM_BODY}</main>`,
);

/** `content`: the h1 of the wrapper confirms the document; `chrome`: the wrapper is a part of the page, it does not. */
const H1_WRAPPERS: Array<[string, string, string, 'content' | 'chrome']> = [
  ['has-fixed-header', '<div class="wrapper has-fixed-header">', '</div>', 'content'],
  ['with-header', '<div class="with-header">', '</div>', 'content'],
  ['has-fixed-top-header', '<div class="has-fixed-top-header">', '</div>', 'content'],
  ['page-with-footer (id)', '<div id="page-with-footer">', '</div>', 'content'],
  ['no-sidebar', '<div id="page" class="hfeed site no-sidebar">', '</div>', 'content'],
  ['has-sidebar', '<div class="has-sidebar">', '</div>', 'content'],
  // counterexamples: a real part of the page keeps being chrome, whatever else its class says
  ['site-header--no-border', '<div class="site-header site-header--no-border">', '</div>', 'chrome'],
  ['header-with-logo', '<div class="header-with-logo">', '</div>', 'chrome'],
  ['nav-has-dropdown', '<div class="nav-has-dropdown">', '</div>', 'chrome'],
  ['has-header + footer', '<div class="has-header footer">', '</div>', 'chrome'],
  ['fixed-header', '<div class="fixed-header">', '</div>', 'chrome'],
  // ambiguous on purpose: the real footer of a theme often carries it, so it stays chrome (documented limit)
  ['sticky-footer', '<div class="wrapper sticky-footer">', '</div>', 'chrome'],
];
const h1WrapperPath: Record<string, string> = {};
for (const [name, open, close, where] of H1_WRAPPERS) {
  h1WrapperPath[name] =
    where === 'content'
      ? add(`${open}<div><h1>Impressum</h1>${IMPRESSUM_BODY}</div>${close}`)
      : add(`${open}<h1>Impressum</h1>${close}<main><h2>Leistungen</h2>${IMPRESSUM_BODY}</main>`);
}

beforeAll(async () => {
  site = writeSite(files);
  server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
  browser = await launchTestBrowser(server);
  tab = await browser.context.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  site?.cleanup();
});

async function extract(path: string, kind: DocumentKind) {
  await tab.goto(`https://www.example.test${path}`);
  return extractDocument(tab, {
    id: `doc-${kind}-1`,
    kind,
    phase: 'A',
    url: `https://www.example.test${path}`,
    foundVia: 'fallback',
    status: 200,
    contentType: 'text/html; charset=utf-8',
  });
}

describe('the h1 is judged where it sits, like the section headings', () => {
  it.each(NAV_H1.map(([key, label, kind]) => [key, label, kind] as const))(
    '%s: %s (a content page without any marker) stays unconfirmed',
    async (key, _label, kind) => {
      const r = rows[`h1-${key}`] as Row;
      const doc = await extract(r.path, kind);
      expect(doc.errors).toContain('unconfirmed');
      expect(doc.complete).toBe(false);
    },
  );

  it('counterexample: the h1 inside main confirms the Impressum', async () => {
    const r = rows['h1-content'] as Row;
    const doc = await extract(r.path, r.kind);
    expect(doc.errors).toEqual([]);
    expect(doc.complete).toBe(true);
  });

  it('counterexample: a chrome h1 in front of the h1 of the policy does not hide it', async () => {
    const r = rows['h1-after-nav-h1'] as Row;
    const doc = await extract(r.path, r.kind);
    expect(doc.errors).toEqual([]);
    expect(doc.lang).toBe('de');
  });

  it('counterexample: the same text in the nav and as the h1 of the content still confirms', async () => {
    const r = rows['h1-nav-same-text-as-content'] as Row;
    expect((await extract(r.path, r.kind)).errors).toEqual([]);
  });

  it('counterexample: an h1 in the header of an article is content', async () => {
    const r = rows['h1-article-header'] as Row;
    expect((await extract(r.path, r.kind)).errors).toEqual([]);
  });

  it('counterexample: a title that names the document confirms it although the h1 is chrome', async () => {
    const r = rows['h1-nav-title-confirms'] as Row;
    expect((await extract(r.path, r.kind)).errors).toEqual([]);
  });
});

describe('headings and collapsed elements share one chrome rule', () => {
  it.each(WRAPPERS.map(([name, , , where]) => [name, where] as const))(
    '%s is %s for the heading and for the collapsed panel alike',
    async (name, where) => {
      const doc = await extract(wrapperPath[name] as string, 'privacy');
      if (where === 'content') {
        // The only marker is the h2 "Datenschutzerklärung" (title and h1 say "Rechtliches").
        expect(doc.errors).toEqual([]);
        expect(doc.manifest.expandablesFound).toBe(1);
      } else {
        expect(doc.errors).toContain('unconfirmed');
        expect(doc.manifest.expandablesFound).toBe(0);
      }
    },
  );
});

describe('a footer column in a wrapper named like an ambiguous component is page chrome', () => {
  it.each(FOOTER_COLUMN.map(([key]) => [key] as const))(
    'div.%s: the column "Impressum" does not confirm the page',
    async (key) => {
      const r = rows[`footer-column-${key}`] as Row;
      const doc = await extract(r.path, r.kind);
      expect(doc.errors).toContain('unconfirmed');
      expect(doc.complete).toBe(false);
    },
  );

  it('counterexample: the same heading in the content of the page confirms it', async () => {
    const r = rows['footer-column-with-content'] as Row;
    expect((await extract(r.path, r.kind)).errors).toEqual([]);
  });
});

describe('a layout state class on the wrapper of the content does not make the h1 chrome', () => {
  it.each(H1_WRAPPERS.map(([name, , , where]) => [name, where] as const))(
    '%s wraps the %s of the page',
    async (name, where) => {
      const doc = await extract(h1WrapperPath[name] as string, 'impressum');
      if (where === 'content') {
        expect(doc.errors).toEqual([]);
        expect(doc.complete).toBe(true);
      } else {
        expect(doc.errors).toContain('unconfirmed');
      }
    },
  );
});
