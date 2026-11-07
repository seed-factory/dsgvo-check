/**
 * Collapsed elements count in a legal document's manifest only when they belong to its text: empty navigation panels
 * must not make the policy `document-incomplete`, unopened policy sections must still count, also without
 * `<main>`/`<article>`. Widget headers (`accordion-header`, `card-header`, `panel-header`) belong to their panels, real
 * page headers and footers stay chrome.
 */
import { describe, expect, it } from 'vitest';
import { documentInPage } from '../../../../src/collectors/browser/in-page/document.ts';
import { loadDomPatterns } from '../../../../src/collectors/browser/rules.ts';
import { page as html, useSite } from '../site-dir.ts';

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
  // no <main>, the policy sits in a plain wrapper
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

const site = useSite(Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [`${k}/index.html`, v])), {
  browser: true,
});

async function read(name: string) {
  await site.tab.goto(`https://www.example.test/${name}/`);
  return site.tab.evaluate(documentInPage, { maxChars: 100_000, patterns: loadDomPatterns().document });
}

const originOf = (d: Awaited<ReturnType<typeof read>>, needle: string) =>
  d.parts.find((p) => p.text.includes(needle))?.origin;

describe('collapsed elements without content count only inside the text of the document', () => {
  it.each([
    ['(a) an empty menu panel in nav/header', 'nav-panel', 0, 1],
    ['a menu button recognised by aria-haspopup or by a header-like wrapper', 'menu-wrapper', 0, 2],
    ['(b) an unopened empty panel inside main (expand-failed stays possible)', 'accordion-empty', 1, 0],
    ['a control in a <header> inside an article, beside the page navigation', 'article-header', 1, 1],
    ['an empty menu panel in a site-header', 'site-header', 0, 1],
    ['a bare header / footer wrapper (`header`, `page_footer`)', 'bare-header-and-footer', 0, 2],
    ['`header-menu` and `footer-panel`, parts of the page chrome', 'header-prefixed', 0, 2],
  ])('%s (%s): %i found, %i ignored', async (_what, name, found, ignored) => {
    const d = await read(name);
    expect(d.expandablesFound).toBe(found);
    expect(d.expandablesWithContent).toBe(0);
    expect(d.expandablesIgnored).toBe(ignored);
  });
});

describe('collapsed elements of the page chrome with text', () => {
  it('closed <details> of nav and footer are not counted and their text is not "expandable"', async () => {
    const d = await read('chrome-details');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(2);
    expect(originOf(d, 'NavLinkText')).not.toBe('expandable');
    expect(originOf(d, 'FooterDetailsText')).not.toBe('expandable');
    expect(originOf(d, 'personenbezogene Daten')).toBe('visible');
  });

  it('an accordion inside site-header is ignored, its text is not expandable', async () => {
    const d = await read('widget-in-site-header');
    expect(d.expandablesFound).toBe(0);
    expect(d.expandablesIgnored).toBe(1);
    expect(originOf(d, 'Google Analytics')).not.toBe('expandable');
  });
});

describe('collapsed sections of the policy itself', () => {
  it('(b) a closed <details> with text counts, its text is read as expandable', async () => {
    const d = await read('accordion-details');
    expect(d.expandablesFound).toBe(1);
    expect(d.expandablesWithContent).toBe(1);
    expect(originOf(d, 'sechs Monate')).toBe('expandable');
  });

  it('control: an accordion inside <main> counts and is read as expandable', async () => {
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
  ])(
    'outside <main>, %s (%s): counted, the text of the panel is expandable, not hidden-irrelevant',
    async (name) => {
      const d = await read(name);
      expect(d.expandablesFound).toBe(1);
      expect(d.expandablesWithContent).toBe(1);
      expect(d.expandablesIgnored).toBe(0);
      expect(originOf(d, 'Google Analytics')).toBe('expandable');
      expect(originOf(d, 'personenbezogene Daten')).toBe('visible');
    },
  );
});
