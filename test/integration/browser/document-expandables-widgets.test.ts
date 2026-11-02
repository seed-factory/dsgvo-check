/**
 * A collapsed policy section counts as an unopened part, with text classified as `expandable`, even without
 * `<main>`/`<article>`. Widget headers such as `accordion-header`, `card-header` and `panel-header` belong to
 * their panels: treating them as page chrome would hide both policy text and completeness limitations.
 * Actual page headers and footers (`site-header`, `header`, `page_footer`) remain chrome.
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentInPage } from '../../../src/collectors/browser/in-page.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { page as html, type SiteDir, writeSite } from './site-dir.ts';

const HEAD = '<style>.collapse:not(.show){display:none}.panel-body[hidden]{display:none}</style>';
const POLICY = '<h1>Datenschutzerklärung</h1><p>Wir verarbeiten personenbezogene Daten nach der DSGVO.</p>';
const SECTION = 'Wir setzen Google Analytics ein.';

/** Bootstrap 5 accordion: `<h2 class="accordion-header"><button aria-expanded="false" aria-controls=…>`. */
const accordion = (headerClass: string, tag = 'h2') => `
  <div class="accordion"><div class="accordion-item">
    <${tag} class="${headerClass}"><button aria-expanded="false" aria-controls="c1">Analyse</button></${tag}>
    <div id="c1" class="collapse">${SECTION}</div>
  </div></div>`;

const PAGES: Record<string, string> = {
  // the report: no <main>, the policy sits in a plain wrapper
  'bs5-no-main': html(`<div id="content">${POLICY}${accordion('accordion-header')}</div>`, HEAD),
  'bs5-main': html(`<main>${POLICY}${accordion('accordion-header')}</main>`, HEAD),
  // Bootstrap 4 card: the button is in `card-header`
  'bs4-no-main': html(
    `<div id="content">${POLICY}<div class="card">
       <div class="card-header"><button aria-expanded="false" aria-controls="c1">Analyse</button></div>
       <div id="c1" class="collapse">${SECTION}</div>
       <div class="card-footer">Stand: 2026</div>
     </div></div>`,
    HEAD,
  ),
  // other kits: BEM names, a header of a panel / item / section / entry
  'bem-no-main': html(`<div class="page">${POLICY}${accordion('c-accordion__header')}</div>`, HEAD),
  'panel-no-main': html(
    `<div class="page">${POLICY}${accordion('mat-expansion-panel-header', 'div')}</div>`,
    HEAD,
  ),
  'item-no-main': html(
    `<div class="page">${POLICY}${accordion('el-collapse-item__header', 'div')}</div>`,
    HEAD,
  ),
  'section-no-main': html(`<div class="page">${POLICY}${accordion('section-header', 'div')}</div>`, HEAD),
  // counter-examples: the chrome of the page is still chrome
  'site-header': html(
    `<div class="site-header"><button aria-expanded="false" aria-controls="m1">Produkte</button><div id="m1" hidden></div></div>
     <div id="content">${POLICY}</div>`,
    HEAD,
  ),
  'bare-header-and-footer': html(
    `<div id="header"><button aria-expanded="false" aria-controls="m1">Menü</button><div id="m1" hidden></div></div>
     <div id="content">${POLICY}</div>
     <div class="page_footer"><button aria-expanded="false" aria-controls="m2">Mehr</button><div id="m2" hidden></div></div>`,
    HEAD,
  ),
  // a widget header inside real page chrome is still chrome
  'widget-in-site-header': html(
    `<div class="site-header">${accordion('accordion-header')}</div>
     <div id="content">${POLICY}</div>`,
    HEAD,
  ),
  // `footer-…` / `header-…` name parts of the page chrome, only `<widget>-header` names a part of a component
  'header-prefixed': html(
    `<div class="header-menu"><button aria-expanded="false" aria-controls="m1">Menü</button><div id="m1" hidden></div></div>
     <div class="footer-panel"><button aria-expanded="false" aria-controls="m2">Mehr</button><div id="m2" hidden></div></div>
     <div id="content">${POLICY}</div>`,
    HEAD,
  ),
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

const originOf = (d: Awaited<ReturnType<typeof read>>, needle: string) =>
  d.parts.find((p) => p.text.includes(needle))?.origin;

describe('an accordion of the policy outside <main>, named like a widget', () => {
  it('control: the same accordion inside <main> counts and is read as expandable', async () => {
    const d = await read('bs5-main');
    expect(d.expandablesFound).toBe(1);
    expect(d.expandablesWithContent).toBe(1);
    expect(originOf(d, 'Google Analytics')).toBe('expandable');
  });

  it.each([
    ['bs5-no-main', 'accordion-header'],
    ['bs4-no-main', 'card-header'],
    ['bem-no-main', 'c-accordion__header'],
    ['panel-no-main', 'mat-expansion-panel-header'],
    ['item-no-main', 'el-collapse-item__header'],
    ['section-no-main', 'section-header'],
  ])('%s (%s): counted, the text of the panel is expandable, not hidden-irrelevant', async (name) => {
    const d = await read(name);
    expect(d.expandablesFound).toBe(1);
    expect(d.expandablesWithContent).toBe(1);
    expect(d.expandablesIgnored).toBe(0);
    expect(originOf(d, 'Google Analytics')).toBe('expandable');
    expect(originOf(d, 'personenbezogene Daten')).toBe('visible');
  });
});

describe('the header and footer of the page stay chrome', () => {
  it('site-header: an empty menu panel is ignored', async () => {
    const d = await read('site-header');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(1);
  });

  it('a bare header / footer wrapper (`header`, `page_footer`) is ignored', async () => {
    const d = await read('bare-header-and-footer');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(2);
  });

  it('an accordion inside site-header is ignored, its text is not expandable', async () => {
    const d = await read('widget-in-site-header');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(1);
    expect(originOf(d, 'Google Analytics')).not.toBe('expandable');
  });

  it('`header-menu` and `footer-panel` name parts of the page chrome', async () => {
    const d = await read('header-prefixed');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(2);
  });
});
