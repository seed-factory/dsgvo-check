/** The browser collector's lists are data (test/data/browser): what the compiled rules accept, and that callers can replace them. */
import { describe, expect, it } from 'vitest';
import { type CandidateLink, selectPages } from '../../../../src/collectors/browser/pages/pages.ts';
import {
  loadDomPatterns,
  loadIdentifierRules,
  loadPageRules,
  pagesSection,
} from '../../../../src/collectors/browser/rules.ts';

describe('identifier rules', () => {
  const rules = loadIdentifierRules();

  it('parameter names are lower case, and the path form is a separate list', () => {
    for (const name of [...rules.params, ...rules.pathParams]) expect(name).toBe(name.toLowerCase());
    expect(rules.params.has('gclid')).toBe(true);
    expect(rules.pathParams.has('dpuuid')).toBe(true);
    expect(rules.params.has('dpuuid')).toBe(false);
  });

  it.each([
    ['_ga', true],
    ['_ga_ABC123', true],
    ['_gat', false],
    ['_gcl_au', true],
    ['IDE', true],
    ['nid', true],
    ['_hjSessionUser_1', true],
    ['session', false],
  ])('cookie %s is an identifier cookie: %s', (name, expected) => {
    expect(rules.cookies.some((re) => re.test(name))).toBe(expected);
  });
});

describe('page rules', () => {
  const rules = loadPageRules();

  it.each([
    ['/wp-admin/options.php', true],
    ['/Kasse', true],
    ['/feed/', true],
    ['/feed/archive', false],
    ['/leistungen', false],
  ])('path %s is excluded: %s', (p, expected) => expect(rules.excludedPath.test(p)).toBe(expected));

  it.each([
    ['/media/Preisliste.PDF', true],
    ['/photo.jpeg', true],
    ['/download.mp4', true],
    ['/pdf', false],
    ['/impressum.html', false],
  ])('path %s ends in a file extension: %s', (p, expected) => expect(rules.file.test(p)).toBe(expected));

  const link = (raw: string, text: string, order: number): CandidateLink => ({
    raw,
    text,
    hrefKind: 'https',
    region: 'nav',
    visible: true,
    order,
  });
  const input = {
    startRaw: 'https://www.example.test/',
    finalHost: 'www.example.test',
    etld1: 'example.test',
    links: [
      link('https://www.example.test/blog/', 'Blog', 0),
      link('https://www.example.test/podcast/', 'Podcast', 1),
      link('https://www.example.test/podcast-intern/', 'Podcast intern', 2),
    ],
    maxPages: 6,
    robots: null,
    token: 'dsgvo-check',
    sitemapLocs: [],
  };

  it('the keyword groups decide which extra pages are chosen, in the order of the file', () => {
    expect(selectPages(input).extras[0]?.reasons).toEqual(['keyword:blog']);
    const own = pagesSection.parse({
      pages: {
        extraGroups: [{ id: 'podcast', words: ['podcast'] }],
        languages: { localePrefixes: ['de'], switchLabels: ['deutsch'] },
        excludedPaths: ['intern'],
        fileExtensions: ['pdf'],
      },
    });
    const plan = selectPages(input, undefined, own);
    expect(plan.extras[0]).toMatchObject({
      url: 'https://www.example.test/podcast/',
      reasons: ['keyword:podcast'],
    });
    expect(plan.extras.map((e) => e.url)).not.toContain('https://www.example.test/podcast-intern/');
  });

  it('every group has an id of its own and words', () => {
    expect(rules.extraGroups.map((g) => g.id)).toEqual([...new Set(rules.extraGroups.map((g) => g.id))]);
    expect(rules.extraGroups.slice(0, 3).map((g) => g.id)).toEqual(['video', 'location', 'history']);
    const parse = (extraGroups: unknown) =>
      pagesSection.parse({
        pages: {
          extraGroups,
          languages: { localePrefixes: ['de'], switchLabels: ['deutsch'] },
          excludedPaths: ['intern'],
          fileExtensions: ['pdf'],
        },
      });
    expect(() => parse([{ id: 'a', words: [] }])).toThrow(/pages\.extraGroups\.0\.words/);
    expect(() =>
      parse([
        { id: 'a', words: ['x'] },
        { id: 'a', words: ['y'] },
      ]),
    ).toThrow(/pages\.extraGroups: duplicate group id "a"/);
  });

  it('locale prefixes are language codes; the words "karte" and "unternehmen" are no keywords', () => {
    for (const code of rules.languages.localePrefixes) expect(code).toMatch(/^[a-z]{2,3}$/);
    const words = rules.extraGroups.flatMap((g) => g.words);
    expect(words).not.toContain('karte');
    expect(words).not.toContain('unternehmen');
  });
});

describe('page vocabulary handed to the in-page readers', () => {
  const { page, document } = loadDomPatterns();
  const re = (source: string, flags = 'i') => new RegExp(source, flags);

  it('banner names: the DSGVO wrapper is a banner for links but not for the legal text', () => {
    expect(re(page.bannerNames).test('dsgvo-box')).toBe(true);
    expect(re(document.bannerNames).test('dsgvo-box')).toBe(false);
    expect(re(document.bannerNames).test('cmplz-cookiebanner')).toBe(true);
  });

  it.each([
    ['Karte laden', true],
    ['Video anzeigen', true],
    ['Inhalt aktivieren', true],
    ['Zur Karte', false],
  ])('placeholder text "%s": %s', (text, expected) => {
    expect(re(page.placeholderText).test(text)).toBe(expected);
  });

  it('a placeholder stands for the first kind whose words occur', () => {
    const kind = (probe: string) =>
      page.placeholderKinds.find((k) => re(k.source).test(probe))?.kind ?? 'other';
    expect(kind('Google Maps laden')).toBe('maps');
    expect(kind('YouTube Video laden')).toBe('video');
    expect(kind('Inhalt laden')).toBe('other');
  });

  it('component bars are removed before a class is judged page chrome', () => {
    const bar = re(document.componentBar, 'gi');
    expect(' accordion-header'.replace(bar, '$1')).toBe(' ');
    expect(' item-header'.replace(bar, '$1')).toBe(' ');
    expect(' section-footer'.replace(re(document.componentBar, 'gi'), '$1')).toBe(' section-footer');
  });

  it('layout states ending in a part name are told apart from the part', () => {
    expect(re(document.layoutState).test('has-fixed-header')).toBe(true);
    expect(re(document.layoutState).test('site-header')).toBe(false);
    expect(re(document.navWrapper).test('main-menu')).toBe(true);
  });
});
