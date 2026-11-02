/**
 * Collapsed elements count in a legal document's manifest only when they belong to its text.
 * Empty navigation panels must not make the policy `document-incomplete`; unopened policy sections must
 * still count so that unread content is not silently treated as evaluated.
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentInPage } from '../../../src/collectors/browser/in-page.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { page as html, type SiteDir, writeSite } from './site-dir.ts';

const POLICY = '<h1>Datenschutzerklärung</h1><p>Wir verarbeiten personenbezogene Daten nach der DSGVO.</p>';

const PAGES: Record<string, string> = {
  // (a) an empty, collapsed menu panel in the navigation
  'nav-panel': html(`
    <header><nav><button aria-expanded="false" aria-controls="menu">Menü</button><div id="menu" hidden></div></nav></header>
    <main>${POLICY}</main>`),
  // menu button without a landmark: told apart by aria-haspopup and by the wrapper class
  'menu-wrapper': html(`
    <div class="site-header"><button aria-expanded="false" aria-controls="m1">Produkte</button><div id="m1" hidden></div></div>
    <div><button aria-haspopup="true" aria-expanded="false" aria-controls="m2">Mehr</button><div id="m2" hidden></div></div>
    <main>${POLICY}</main>`),
  // a closed <details> in the footer and in the navigation with text: not part of the policy
  'chrome-details': html(`
    <nav><details><summary>Mehr</summary><a href="/x">NavLinkText</a></details></nav>
    <main>${POLICY}</main>
    <footer><details><summary>Info</summary><p>FooterDetailsText</p></details></footer>`),
  // (b) a collapsed section of the policy: lazy (empty) panel, and a closed <details> with text
  'accordion-empty': html(`
    <main>${POLICY}
      <h2>Cookies</h2>
      <button aria-expanded="false" aria-controls="sec1">Einzelheiten</button><div id="sec1" hidden></div>
    </main>`),
  'accordion-details': html(`
    <main>${POLICY}
      <details><summary>Speicherdauer</summary><p>Wir speichern Daten sechs Monate.</p></details>
    </main>`),
  // a menu-like control inside an article keeps counting
  'article-header': html(`
    <nav><button aria-expanded="false" aria-controls="menu">Menü</button><div id="menu" hidden></div></nav>
    <article><header>${POLICY}<button aria-expanded="false" aria-controls="p1">Mehr lesen</button><div id="p1" hidden></div></header></article>`),
};

let server: FixtureServer;
let site: SiteDir;
let browser: TestBrowser;
let tab: Page;

beforeAll(async () => {
  site = writeSite(Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [`${k}/index.html`, v])));
  server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
  browser = await launchTestBrowser(server);
  tab = await browser.context.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  site?.cleanup();
});

async function read(name: string) {
  await tab.goto(`https://www.example.test/${name}/`);
  return tab.evaluate(documentInPage, { maxChars: 100_000 });
}

describe('collapsed elements outside the text of the document', () => {
  it('(a) an empty menu panel in nav/header is not counted', async () => {
    const d = await read('nav-panel');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesWithContent).toBe(0);
    expect(d.expandablesIgnored).toBe(1);
  });

  it('a menu button recognised by aria-haspopup or by a header-like wrapper is not counted', async () => {
    const d = await read('menu-wrapper');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(2);
  });

  it('closed <details> of nav and footer are not counted and their text is not "expandable"', async () => {
    const d = await read('chrome-details');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(2);
    const part = (needle: string) => d.parts.find((p) => p.text.includes(needle));
    expect(part('NavLinkText')?.origin).not.toBe('expandable');
    expect(part('FooterDetailsText')?.origin).not.toBe('expandable');
    expect(part('personenbezogene Daten')?.origin).toBe('visible');
  });
});

describe('collapsed sections of the policy itself', () => {
  it('(b) an unopened empty panel inside main counts as found without content (expand-failed stays possible)', async () => {
    const d = await read('accordion-empty');
    expect(d.expandablesFound).toBe(1);
    expect(d.expandablesWithContent).toBe(0);
    expect(d.expandablesIgnored).toBe(0);
  });

  it('(b) a closed <details> with text counts, its text is read as expandable', async () => {
    const d = await read('accordion-details');
    expect(d.expandablesFound).toBe(1);
    expect(d.expandablesWithContent).toBe(1);
    expect(d.parts.find((p) => p.text.includes('sechs Monate'))?.origin).toBe('expandable');
  });

  it('a control in a <header> inside an article is part of the text; the page navigation is not', async () => {
    const d = await read('article-header');
    expect(d.expandablesFound).toBe(1);
    expect(d.expandablesIgnored).toBe(1);
  });
});
