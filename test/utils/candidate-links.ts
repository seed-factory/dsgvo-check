/**
 * Links of the start page https://www.example.test/ for the pure tests of the page selection: `link` numbers the
 * links in the order they are built, as the DOM order would; `plan` selects with the defaults of a scan.
 */
import {
  type CandidateLink,
  type SelectInput,
  selectPages,
} from '../../src/collectors/browser/pages/pages.ts';

export const START = 'https://www.example.test/';
export const u = (path: string) => `https://www.example.test${path}`;
export const scope = { startRaw: START, finalHost: 'www.example.test', etld1: 'example.test' };

let n = 0;
export const link = (p: Partial<CandidateLink> & { raw: string; text: string }): CandidateLink => ({
  hrefKind: p.raw.startsWith('https:') ? 'https' : 'http',
  region: 'footer',
  visible: true,
  order: n++,
  ...p,
});

/** selectPages on www.example.test with the defaults of a scan (6 pages, no robots.txt, no sitemap). */
export const plan = (links: CandidateLink[], o: Partial<SelectInput> = {}) =>
  selectPages({ links, ...scope, maxPages: 6, robots: null, token: 'dsgvo-check', sitemapLocs: [], ...o });
