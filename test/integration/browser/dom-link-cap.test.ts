/**
 * The link cap must not exclude a footer's legal links on a page with a long article list: otherwise
 * LEGAL-01 could infer a missing link from truncated input. Over the cap the collector prioritizes legal-looking
 * links and footer/nav regions, fills the rest in document order, and reports that the list is truncated.
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectDom } from '../../../src/collectors/browser/dom.ts';
import { domFactsInPage } from '../../../src/collectors/browser/in-page-dom.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { page as html, type SiteDir, writeSite } from './site-dir.ts';

const articles = (n: number) =>
  Array.from({ length: n }, (_, i) => `<li><a href="/artikel/${i}">Artikel ${i}</a></li>`).join('');

let server: FixtureServer;
let site: SiteDir;
let browser: TestBrowser;
let tab: Page;

beforeAll(async () => {
  site = writeSite({
    'long/index.html': html(`
      <header><a href="/">Start</a></header>
      <main><ul>${articles(1600)}</ul></main>
      <footer><a href="/impressum/">Impressum</a> <a href="/datenschutz/">Datenschutzerklärung</a></footer>`),
    'legal-in-main/index.html': html(`
      <main><ul>${articles(1600)}</ul><p><a href="/kontakt/">Kontakt</a></p></main>`),
    'short/index.html': html(`
      <main><ul>${articles(20)}</ul></main>
      <footer><a href="/impressum/">Impressum</a></footer>`),
  });
  server = await startFixtureServer({ hosts: { 'www.example.test': site.root } });
  browser = await launchTestBrowser(server);
  tab = await browser.context.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  site?.cleanup();
});

const target = { etld1: 'example.test', host: 'www.example.test' };

async function collectAt(path: string) {
  await tab.goto(`https://www.example.test/${path}`);
  return collectDom(tab, target, []);
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

describe('domFactsInPage with a small cap', () => {
  it('reads priority links first and fills the rest in document order', async () => {
    await tab.goto('https://www.example.test/long/');
    const raw = await tab.evaluate(domFactsInPage, { maxLinks: 10, maxScripts: 5 });
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
