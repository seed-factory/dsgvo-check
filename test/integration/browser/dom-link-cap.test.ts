/**
 * The link cap must not drop a footer's legal links on a page with a long article list (LEGAL-01 would infer a missing
 * link from truncated input): legal-looking and footer/nav links go first, the list is reported as truncated. Forms
 * carry whether they take input other than a site search, by the rules the HTTP collector applies to markup. A link
 * whose rel names `bookmark` is flagged as a permalink.
 */
import { describe, expect, it } from 'vitest';
import { domFactsInPage } from '../../../src/collectors/browser/in-page/dom.ts';
import { collectDom, formRules } from '../../../src/collectors/browser/pages/dom-facts.ts';
import { loadDomPatterns } from '../../../src/collectors/browser/rules.ts';
import { page as html, useSite } from './site-dir.ts';

const articles = (n: number) =>
  Array.from({ length: n }, (_, i) => `<li><a href="/artikel/${i}">Artikel ${i}</a></li>`).join('');

const site = useSite(
  {
    'long/index.html': html(`
      <header><a href="/">Start</a></header>
      <main><ul>${articles(1600)}</ul></main>
      <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>`),
    'legal-in-main/index.html': html(`
      <main><ul>${articles(1600)}</ul><p><a href="/kontakt/">Kontakt</a></p></main>`),
    'short/index.html': html(`
      <main><ul>${articles(20)}</ul></main>
      <footer><a href="/impressum/">Impressum</a></footer>`),
    'forms/index.html': html(`
      <header><form role="search" action="/"><input type="search" name="s"><input type="submit"></form></header>
      <form class="site-search" action="/suche"><input name="term"></form>
      <form action="/"><input type="text" name="s"><button>Suchen</button></form>
      <form method="post"><input type="hidden" name="a" value="1"><input type="submit" value="Abmelden"></form>
      <form method="get" action="/kontakt/senden"><input name="name"><textarea name="nachricht"></textarea></form>
      <form method="post" action="/wp-comments-post.php"><textarea name="comment"></textarea></form>
      <form method="post" action="/login"><input type="password" name="pw"></form>
      <template><form method="post"><textarea></textarea></form></template>`),
    'permalinks/index.html': html(`
      <main>
        <a href="/eins/" rel="bookmark"><time datetime="2025-03-14T09:30:00+01:00">14. März 2025</time></a>
        <a href="/zwei/" rel="NoFollow Bookmark">Zwei</a>
        <a href="/drei/" rel="nofollow">Drei</a>
        <a href="/vier/" rel="bookmarks">Vier</a>
        <a href="/fuenf/">Fünf</a>
        <map name="m"><area href="/sechs/" rel="bookmark" alt="Sechs" shape="rect" coords="0,0,10,10"></map>
      </main>`),
  },
  { browser: true },
);

const target = { etld1: 'example.test', host: 'www.example.test' };

async function collectAt(path: string) {
  await site.tab.goto(`https://www.example.test/${path}`);
  return collectDom(site.tab, target, []);
}

describe('collectDom with more links than the cap', () => {
  it('keeps the footer links (Impressum, Datenschutz) of a page with 1600 article links', async () => {
    const { dom, candidates } = await collectAt('long/');
    const hrefs = dom.links.map((l) => l.href);
    expect(hrefs).toContain('https://www.example.test/impressum/');
    expect(hrefs).toContain('https://www.example.test/datenschutz/');
    expect(dom.links.find((l) => l.href?.endsWith('/impressum/'))).toMatchObject({
      text: 'Impressum',
      region: 'footer',
    });
    // the same links reach the page selection
    expect(candidates.map((c) => c.raw)).toContain('https://www.example.test/impressum/');
  });

  it('stays within the cap, keeps document order and flags the truncation', async () => {
    const { dom } = await collectAt('long/');
    expect(dom.links.length).toBeLessThanOrEqual(1500);
    expect((dom as { linksTruncated?: boolean }).linksTruncated).toBe(true);
    const nums = dom.links
      .map((l) => Number(/\/artikel\/(\d+)$/.exec(l.href ?? '')?.[1] ?? -1))
      .filter((n) => n >= 0);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(dom.links.at(-1)?.href).toBe('https://www.example.test/datenschutz/');
    expect(dom.links[0]?.href).toBe('https://www.example.test/');
  });

  it('keeps a legal-looking link in the middle of the page (outside footer and nav)', async () => {
    const { dom } = await collectAt('legal-in-main/');
    expect(dom.links.map((l) => l.href)).toContain('https://www.example.test/kontakt/');
  });

  it('a page under the cap is read completely and carries no truncation flag', async () => {
    const { dom, raw } = await collectAt('short/');
    expect(dom.links).toHaveLength(21);
    expect((dom as { linksTruncated?: boolean }).linksTruncated).toBeUndefined();
    expect(raw.linksTotal).toBe(21);
  });
});

describe('collectDom: forms', () => {
  it('a site search or a form without a field to type in takes no input; a GET contact form does', async () => {
    const { dom } = await collectAt('forms/');
    expect(dom.forms.map((f) => [f.method, f.takesInput])).toEqual([
      ['get', false],
      ['get', false],
      ['get', false],
      ['post', false],
      ['get', true],
      ['post', true],
      ['post', true],
    ]);
  });
});

describe('collectDom: permalinks', () => {
  it('rel="bookmark", also beside other tokens and in any case, flags the link; other rel values do not', async () => {
    const { dom } = await collectAt('permalinks/');
    expect(dom.links.map((l) => [new URL(l.href ?? '').pathname, l.permalink ?? false])).toEqual([
      ['/eins/', true],
      ['/zwei/', true],
      ['/drei/', false],
      ['/vier/', false],
      ['/fuenf/', false],
      ['/sechs/', true],
    ]);
  });
});

describe('domFactsInPage with a small cap', () => {
  it('reads priority links first and fills the rest in document order', async () => {
    await site.tab.goto('https://www.example.test/long/');
    const raw = await site.tab.evaluate(domFactsInPage, {
      maxLinks: 10,
      maxScripts: 5,
      maxPlaceholders: 20,
      patterns: loadDomPatterns().page,
      forms: formRules(),
    });
    expect(raw.linksTotal).toBe(1603);
    expect(raw.linksTruncated).toBe(true);
    const hrefs = raw.links.map((l) => new URL(l.href).pathname);
    // header link, footer links, then the first articles up to the cap
    expect(hrefs).toEqual([
      '/',
      '/artikel/0',
      '/artikel/1',
      '/artikel/2',
      '/artikel/3',
      '/artikel/4',
      '/artikel/5',
      '/artikel/6',
      '/impressum/',
      '/datenschutz/',
    ]);
  });
});
