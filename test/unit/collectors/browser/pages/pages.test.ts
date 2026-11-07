/** Pure: deterministic page selection with reasons and B/C control pages. */
import { describe, expect, it } from 'vitest';
import {
  type CandidateLink,
  type ControlCandidate,
  type ControlFacts,
  catalogCategoryOf,
  chooseControlPages,
  controlSignals,
  findLegalLink,
  isLanguageAlternate,
  languageContext,
  type SelectInput,
  selectPages,
} from '../../../../../src/collectors/browser/pages/pages.ts';
import { parseRobots } from '../../../../../src/collectors/browser/pages/robots.ts';
import { loadPageRules } from '../../../../../src/collectors/browser/rules.ts';
import { loadServiceCatalog } from '../../../../../src/derive/catalog.ts';

const START = 'https://www.example.test/';
let n = 0;
const link = (p: Partial<CandidateLink> & { raw: string; text: string }): CandidateLink => ({
  hrefKind: p.raw.startsWith('https:') ? 'https' : 'http',
  region: 'footer',
  visible: true,
  order: n++,
  ...p,
});
const u = (path: string) => `https://www.example.test${path}`;

const LINKS: CandidateLink[] = [
  link({ raw: 'https://www.example.test/leistungen/webdesign', text: 'Webdesign', region: 'nav' }),
  link({ raw: 'https://www.example.test/ueber-uns', text: 'Über uns', region: 'nav' }),
  link({ raw: 'https://www.example.test/blog/', text: 'Blog', region: 'nav' }),
  link({ raw: 'https://www.example.test/blog/post-1', text: 'Neuer Beitrag', region: 'main' }),
  link({ raw: 'https://www.example.test/kontakt', text: 'Kontakt', region: 'nav' }),
  link({ raw: 'https://www.example.test/shop/warenkorb', text: 'Warenkorb', region: 'header' }),
  link({ raw: 'https://www.example.test/team.pdf', text: 'Team (PDF)', region: 'main' }),
  link({ raw: 'https://www.example.test/impressum', text: 'Impressum' }),
  link({ raw: 'https://www.example.test/?page_id=3', text: 'Datenschutzerklärung' }),
  link({ raw: 'https://www.example.test/datenschutz-einstellungen', text: 'Datenschutz-Einstellungen' }),
  link({ raw: 'https://other.example/impressum', text: 'Impressum Partner', region: 'main' }),
  link({ raw: 'mailto:info@example.test', text: 'E-Mail', hrefKind: 'mailto' }),
];

const scope = { startRaw: START, finalHost: 'www.example.test', etld1: 'example.test' };

/** selectPages on www.example.test with the defaults of a scan (6 pages, no robots.txt, no sitemap). */
const plan = (links: CandidateLink[], o: Partial<SelectInput> = {}) =>
  selectPages({ links, ...scope, maxPages: 6, robots: null, token: 'dsgvo-check', sitemapLocs: [], ...o });

const extrasOf = (p: ReturnType<typeof plan>) => p.extras.map((e) => [e.url, e.reasons]);

describe('selectPages', () => {
  it('start, Impressum, Datenschutz, Kontakt and the extras of the first keyword groups, with reasons', () => {
    const p = plan(LINKS);
    expect(p.impressum).toMatchObject({
      status: 'page',
      choice: {
        url: 'https://www.example.test/impressum',
        role: 'impressum',
        reasons: ['footer-link:impressum'],
      },
    });
    // The navigation URL keeps the real query; the planned URL is sanitized.
    expect(p.privacy.choice?.raw).toBe('https://www.example.test/?page_id=3');
    expect(p.privacy.choice?.url).toBe('https://www.example.test/?page_id=[redacted]');
    expect(p.contact).toMatchObject({
      url: 'https://www.example.test/kontakt',
      reasons: ['nav-link:kontakt'],
    });
    expect(extrasOf(p)).toEqual([
      ['https://www.example.test/ueber-uns', ['keyword:über uns']],
      ['https://www.example.test/blog/', ['keyword:blog']],
    ]);
  });

  it('is deterministic and independent of duplicate links', () => {
    const a = plan(LINKS);
    const b = plan([...LINKS, ...LINKS.map((l) => ({ ...l, order: l.order + 100 }))]);
    expect(b).toEqual(a);
  });

  it('respects maxPages for extras and robots.txt for additional pages only', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /ueber-uns\nDisallow: /impressum');
    const p = plan(LINKS, { maxPages: 5, robots });
    expect(p.impressum.status).toBe('page'); // legal pages are always visited
    expect(p.extras.map((e) => e.url)).toEqual(['https://www.example.test/blog/']);
    expect(p.extras[0]?.robotsAllowed).toBe(true);
  });

  it('falls back to sitemap entries with distinct templates', () => {
    const p = plan([link({ raw: 'https://www.example.test/impressum', text: 'Impressum' })], {
      sitemapLocs: [
        'https://www.example.test/produkte/a',
        'https://www.example.test/produkte/b',
        'https://cdn.other.example/x',
        'https://www.example.test/referenzen',
      ],
    });
    expect(p.extras.map((e) => [e.url, e.source, e.reasons])).toEqual([
      ['https://www.example.test/produkte/a', 'sitemap', ['sitemap']],
      ['https://www.example.test/referenzen', 'sitemap', ['sitemap']],
    ]);
    expect(p.privacy.status).toBe('none');
  });

  it('classifies # / javascript: / PDF / offsite legal links', () => {
    const p = plan([
      link({ raw: 'https://www.example.test/#', text: 'Impressum', hrefKind: 'fragment' }),
      link({ raw: 'https://www.example.test/dse.pdf', text: 'Datenschutz' }),
    ]);
    expect(p.impressum.status).toBe('unresolved');
    expect(p.privacy).toMatchObject({
      status: 'pdf',
      choice: { url: 'https://www.example.test/dse.pdf' },
    });
    expect(
      findLegalLink(
        [link({ raw: 'https://www.other.example/impressum', text: 'Impressum' })],
        'impressum',
        scope,
      ).status,
    ).toBe('offsite');
  });

  it('proposes hop pages (Rechtliches, Über uns) when a legal link is missing', () => {
    const p = plan([
      link({ raw: 'https://www.example.test/rechtliches', text: 'Rechtliches' }),
      link({ raw: 'https://www.example.test/ueber-uns', text: 'Über uns', region: 'nav' }),
    ]);
    expect(p.hops.map((h) => [h.url, h.reasons])).toEqual([
      ['https://www.example.test/rechtliches', ['hop:rechtliches']],
      ['https://www.example.test/ueber-uns', ['hop:über uns']],
    ]);
  });
});

/** The legal links of a site under `prefix`, so that the budget left for extras is the scan's. */
const legal = (prefix = '') => [
  link({ raw: u(`${prefix}/impressum/`), text: 'Impressum' }),
  link({ raw: u(`${prefix}/datenschutz/`), text: 'Datenschutz' }),
];

describe('locale prefixes and language versions', () => {
  it('a /de/ start page leaves its own sections open: history and location pages, never the language roots', () => {
    const p = plan(
      [
        link({ raw: u('/de/'), text: 'DE', region: 'header' }),
        link({ raw: u('/en/'), text: 'EN', region: 'header' }),
        link({ raw: u('/es/'), text: 'ES', region: 'header' }),
        link({ raw: u('/de/kontakt/'), text: 'Kontakt' }),
        link({ raw: u('/de/kontakt/anfahrt/'), text: 'Anfahrt' }),
        link({ raw: u('/de/unternehmen/geschichte/'), text: 'Unsere Geschichte' }),
        link({ raw: u('/de/unternehmen/karriere/'), text: 'Karriere' }),
        link({ raw: u('/de/unternehmen/news/'), text: 'News' }),
        ...legal('/de'),
      ],
      { startRaw: u('/de/') },
    );

    expect(p.contact?.url).toBe(u('/de/kontakt/'));
    expect(extrasOf(p)).toEqual([
      [u('/de/kontakt/anfahrt/'), ['keyword:anfahrt']],
      [u('/de/unternehmen/geschichte/'), ['keyword:geschichte']],
    ]);
  });

  it('links that only switch the language never fill the budget, so the sitemap is asked', () => {
    const links = [
      link({ raw: u('/en/'), text: 'EN', region: 'header' }),
      link({ raw: u('/fr/'), text: 'FR', region: 'header' }),
      link({ raw: u('/en/products/'), text: 'Products', region: 'nav' }),
      ...legal('/de'),
    ];
    const fromLinks = plan(links, { startRaw: u('/de/') });
    expect(fromLinks.extras).toEqual([]);
    expect(fromLinks.extrasWanted).toBe(3);

    const withSitemap = plan(links, {
      startRaw: u('/de/'),
      sitemapLocs: [u('/en/services/'), u('/de/leistungen/'), u('/fr/'), u('/de/team/')],
    });
    expect(withSitemap.extras.map((e) => [e.url, e.source])).toEqual([
      [u('/de/leistungen/'), 'sitemap'],
      [u('/de/team/'), 'sitemap'],
    ]);
  });

  it('without a locale on the start page, labelled language switches and their sections are alternates', () => {
    const p = plan(
      [
        link({ raw: u('/en/'), text: 'EN', region: 'header' }),
        link({ raw: u('/fr/accueil/'), text: 'Français', region: 'header' }),
        link({ raw: u('/en/about-us/'), text: 'About us' }),
        link({ raw: u('/ueber-uns/'), text: 'Über uns', region: 'nav' }),
        ...legal(),
      ],
      { sitemapLocs: [u('/en/team/'), u('/fr/equipe/')] },
    );
    expect(p.extras.map((e) => e.url)).toEqual([u('/ueber-uns/')]);
  });

  it.each(['DE', 'Deutsch'])(
    'a start page without a locale whose switch "%s" leads to /de/ of its own language keeps the /de/ sections',
    (label) => {
      const p = plan(
        [
          link({ raw: u('/de/'), text: label, region: 'header' }),
          link({ raw: u('/en/'), text: 'EN', region: 'header' }),
          link({ raw: u('/de/kontakt/'), text: 'Kontakt', region: 'nav' }),
          link({ raw: u('/de/geschichte/'), text: 'Geschichte', region: 'nav' }),
          link({ raw: u('/de/anfahrt/'), text: 'Anfahrt', region: 'nav' }),
          link({ raw: u('/en/history/'), text: 'History', region: 'nav' }),
          ...legal('/de'),
        ],
        { startLang: 'de-DE', sitemapLocs: [u('/de/team/')] },
      );
      expect(p.language.alternatePrefixes).toEqual(new Set(['en']));
      expect(p.contact?.url).toBe(u('/de/kontakt/'));
      expect(extrasOf(p)).toEqual([
        [u('/de/anfahrt/'), ['keyword:anfahrt']],
        [u('/de/geschichte/'), ['keyword:geschichte']],
      ]);
    },
  );

  it('counterexample: a region of the start language behind its switch stays another version', () => {
    const ctx = languageContext({ raw: START, lang: 'de-DE' }, [
      link({ raw: u('/de-at/'), text: 'DE-AT', region: 'header' }),
      link({ raw: u('/de/'), text: 'DE', region: 'header' }),
    ]);
    expect(ctx.alternatePrefixes).toEqual(new Set(['de-at']));
  });

  it('counterexample: without a locale on the start page, /it/ "IT-Service" is a section and stays eligible', () => {
    const p = plan([
      link({ raw: u('/it/'), text: 'IT-Service', region: 'nav' }),
      link({ raw: u('/en/'), text: 'EN', region: 'header' }),
      ...legal(),
    ]);
    expect(extrasOf(p)).toEqual([[u('/it/'), ['keyword:service']]]);
  });

  it('a page marked as another language by one of its links stays out, also as a sitemap entry', () => {
    const p = plan(
      [
        link({ raw: u('/team-en/'), text: 'Team', hreflang: 'en' }),
        link({ raw: u('/team-en/'), text: 'Our team', region: 'nav' }),
        ...legal(),
      ],
      { startLang: 'de', sitemapLocs: [u('/team-en/'), u('/leistungen/')] },
    );
    expect(p.extras.map((e) => e.url)).toEqual([u('/leistungen/')]);
  });

  it('a link marked with the hreflang of another language is an alternate, one of the same language is not', () => {
    const p = plan(
      [
        link({ raw: u('/team-en/'), text: 'Team', hreflang: 'en' }),
        link({ raw: u('/team/'), text: 'Team', region: 'nav', hreflang: 'de' }),
        ...legal(),
      ],
      { startLang: 'de-DE' },
    );
    expect(extrasOf(p)).toEqual([[u('/team/'), ['keyword:team']]]);
  });

  const ALTERNATES: Array<[string, string, Partial<CandidateLink>, string | undefined, boolean]> = [
    ['another prefix than the start page', '/de/', { raw: u('/en/'), text: 'EN' }, undefined, true],
    [
      'another region of the same language',
      '/de/',
      { raw: u('/de-at/produkte/'), text: 'Produkte' },
      undefined,
      true,
    ],
    ['the prefix of the start page', '/de/', { raw: u('/de/produkte/'), text: 'Produkte' }, undefined, false],
    ['a language root named by its code', '/', { raw: u('/en/'), text: 'EN' }, undefined, true],
    [
      'a language root named only by its accessible name',
      '/',
      { raw: u('/en/'), text: '', accessibleName: 'English' },
      undefined,
      true,
    ],
    ['a language root without any name', '/', { raw: u('/pl/'), text: '' }, undefined, true],
    [
      'a language root shown as a flag named by a sentence',
      '/',
      { raw: u('/en/'), text: '', accessibleName: 'Switch to English' },
      undefined,
      true,
    ],
    ['a section with a two-letter name', '/', { raw: u('/it/'), text: 'IT-Service' }, undefined, false],
    ['a language name on a locale root', '/', { raw: u('/en/'), text: 'English' }, undefined, true],
    [
      'a language name on the root of a localized site',
      '/en/',
      { raw: u('/'), text: 'Deutsch' },
      undefined,
      true,
    ],
    [
      'a course page named after a language',
      '/',
      { raw: u('/kurse/englisch/'), text: 'Englisch' },
      undefined,
      false,
    ],
    [
      'a language code as the whole label, any path',
      '/',
      { raw: u('/home-en.html'), text: 'EN' },
      undefined,
      true,
    ],
    ['a region form with an underscore', '/en_gb/', { raw: u('/de_de/'), text: 'Deutsch' }, undefined, true],
    ['hreflang of another language', '/', { raw: u('/team/'), text: 'Team', hreflang: 'en' }, 'de', true],
    [
      'hreflang of the start language',
      '/',
      { raw: u('/team/'), text: 'Team', hreflang: 'de-at' },
      'de',
      false,
    ],
    ['x-default', '/', { raw: u('/team/'), text: 'Team', hreflang: 'x-default' }, 'de', false],
    [
      'hreflang of the start language on another region prefix',
      '/de/',
      { raw: u('/de-at/team/'), text: 'Team', hreflang: 'de-at' },
      'de',
      true,
    ],
    ['a language name in its own script', '/', { raw: u('/uk/'), text: 'Українська' }, 'de', true],
  ];
  it.each(ALTERNATES)('%s (start page %s)', (_, startPath, l, startLang, expected) => {
    const candidate = link({ text: '', ...l, raw: l.raw as string });
    const ctx = languageContext({ raw: u(startPath), ...(startLang ? { lang: startLang } : {}) }, [
      candidate,
    ]);
    expect(isLanguageAlternate(candidate, ctx)).toBe(expected);
  });
});

describe('the language dictionary', () => {
  const rules = loadPageRules().languages;
  const start = languageContext({ raw: u('/'), lang: 'de' }, []);

  it.each([...rules.localePrefixes])('a root /%s/ labelled with its code is a language switch', (code) => {
    expect(isLanguageAlternate({ raw: u(`/${code}/`), text: code.toUpperCase() }, start)).toBe(true);
  });

  it.each([...rules.switchLabels])('a link "%s" into a locale prefix is a language switch', (label) => {
    expect(isLanguageAlternate({ raw: u('/en/start/'), text: label }, start)).toBe(true);
  });
});

describe('extra pages by keyword group', () => {
  it('one page per group, while one section may give pages of different groups', () => {
    const p = plan(
      [
        link({ raw: u('/unternehmen/geschichte'), text: 'Unsere Geschichte', region: 'main' }),
        link({ raw: u('/unternehmen/team'), text: 'Team', region: 'main' }),
        link({ raw: u('/blog/a'), text: 'Blog', region: 'main' }),
        link({ raw: u('/news/b'), text: 'News', region: 'main' }),
        ...legal(),
      ],
      { maxPages: 10 },
    );
    expect(extrasOf(p)).toEqual([
      [u('/unternehmen/geschichte'), ['keyword:geschichte']],
      [u('/unternehmen/team'), ['keyword:team']],
      [u('/blog/a'), ['keyword:blog']],
    ]);
  });

  it('within a group a text match beats a path match, then the region decides', () => {
    const p = plan([
      link({ raw: u('/historie/'), text: 'Mehr erfahren', region: 'footer' }),
      link({ raw: u('/firma/'), text: 'Firmengeschichte', region: 'nav' }),
      link({ raw: u('/chronik/'), text: 'Chronik', region: 'main' }),
      ...legal(),
    ]);
    expect(extrasOf(p)).toEqual([[u('/firma/'), ['keyword:geschichte']]]);
  });

  it('a robots.txt refusal passes the group on to its next page', () => {
    const p = plan(
      [
        link({ raw: u('/geschichte/'), text: 'Geschichte', region: 'nav' }),
        link({ raw: u('/chronik/'), text: 'Chronik', region: 'main' }),
        ...legal(),
      ],
      { robots: parseRobots('User-agent: *\nDisallow: /geschichte/') },
    );
    expect(extrasOf(p)).toEqual([[u('/chronik/'), ['keyword:chronik']]]);
  });

  it.each([
    ['Speisekarte', '/speisekarte'],
    ['Kontaktlinsen', '/kontaktlinsen'],
  ])('counterexample: "%s" is no contact page and gives no keyword page', (text, path) => {
    const p = plan([link({ raw: u(path), text, region: 'main' }), ...legal()]);
    expect(p.contact).toBeNull();
    expect(p.extras).toEqual([]);
  });
});

describe('the extras budget follows --max-pages', () => {
  it('without legal links the probes of the conventional paths take their place in the budget', () => {
    const groups = ['/video/', '/chronik/', '/team/', '/jobs/', '/shop/'].map((path) =>
      link({ raw: u(path), text: path.replace(/\//g, ''), region: 'main' }),
    );
    const p = plan(groups);
    expect([p.impressum.status, p.privacy.status]).toEqual(['none', 'none']);
    // The start page, 3 extras and the probes of /impressum and /datenschutz: 6 pages.
    expect(p.extrasWanted).toBe(3);
    expect(p.extras).toHaveLength(3);

    const withPdf = plan([
      ...groups,
      link({ raw: u('/impressum/'), text: 'Impressum' }),
      link({ raw: u('/dse.pdf'), text: 'Datenschutz' }),
    ]);
    // A PDF link is read without a visit: the start page, the Impressum and 4 extras.
    expect(withPdf.extrasWanted).toBe(4);
  });

  const MANY = [
    link({ raw: u('/kontakt/'), text: 'Kontakt', region: 'nav' }),
    link({ raw: u('/videos/'), text: 'Videos', region: 'nav' }),
    link({ raw: u('/anfahrt/'), text: 'Anfahrt', region: 'nav' }),
    link({ raw: u('/geschichte/'), text: 'Geschichte', region: 'nav' }),
    link({ raw: u('/ueber-uns/'), text: 'Über uns', region: 'nav' }),
    link({ raw: u('/team/'), text: 'Team', region: 'nav' }),
    link({ raw: u('/karriere/'), text: 'Karriere', region: 'nav' }),
    link({ raw: u('/referenzen/'), text: 'Referenzen', region: 'nav' }),
    link({ raw: u('/blog/'), text: 'Blog', region: 'nav' }),
    ...legal(),
  ];

  it.each([
    [10, 6],
    [6, 2],
    [4, 0],
  ])(
    '--max-pages %i gives %i extras; legal pages and the contact page are chosen regardless',
    (maxPages, extras) => {
      const p = plan(MANY, { maxPages });
      expect(p.extrasWanted).toBe(extras);
      expect(p.extras).toHaveLength(extras);
      expect([p.impressum.status, p.privacy.status, p.contact?.url]).toEqual([
        'page',
        'page',
        u('/kontakt/'),
      ]);
    },
  );

  it.each<[string, string[], string | undefined, number]>([
    ['with a contact page', [], u('/kontakt/'), 3],
    ['without a contact page', ['/kontakt/', '/anfahrt/'], undefined, 4],
  ])('a page both legal links lead to is one visit of the budget, %s', (_name, without, contact, extras) => {
    const pages = MANY.filter(
      (l) => !/\/(impressum|datenschutz)\/$/.test(l.raw) && !without.some((w) => l.raw === u(w)),
    );
    const p = plan([
      ...pages,
      link({ raw: u('/impressum-datenschutz/'), text: 'Impressum' }),
      link({ raw: u('/impressum-datenschutz/'), text: 'Datenschutz' }),
    ]);
    expect(p.impressum.choice?.url).toBe(u('/impressum-datenschutz/'));
    expect(p.privacy.choice?.url).toBe(u('/impressum-datenschutz/'));
    expect(p.contact?.url).toBe(contact);
    expect(p.extrasWanted).toBe(extras);
    expect(p.extras).toHaveLength(extras);
  });
});

describe('legal links of another language version', () => {
  const links = [
    link({ raw: u('/de/impressum/'), text: 'Impressum' }),
    link({ raw: u('/en/privacy/'), text: 'Privacy Policy', hreflang: 'en' }),
    link({ raw: u('/de/datenschutz/'), text: 'Datenschutz' }),
  ];

  it('the policy of the start page language is chosen before an English one linked first', () => {
    const p = plan(links, { startRaw: u('/de/'), startLang: 'de' });
    expect(p.privacy.choice?.url).toBe(u('/de/datenschutz/'));
    expect(p.privacy.candidates?.map((c) => c.url)).toEqual([u('/de/datenschutz/'), u('/en/privacy/')]);
  });

  it('counterexample: an English policy that is the only privacy link is still chosen', () => {
    const p = plan([links[0]!, links[1]!], { startRaw: u('/de/'), startLang: 'de' });
    expect(p.privacy.choice?.url).toBe(u('/en/privacy/'));
  });
});

describe('control-page signals', () => {
  const catalog = loadServiceCatalog();
  const categoryOf = catalogCategoryOf(catalog);
  const facts = (f: Partial<ControlFacts>): ControlFacts => ({
    iframes: [],
    placeholders: 0,
    requests: [],
    startRequests: [],
    ...f,
  });
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const signals = (f: Partial<ControlFacts>) => controlSignals(facts(f), 'example.test', categoryOf);
  const candidate = (path: string, f: Partial<ControlFacts>, order = 1): ControlCandidate => ({
    raw: u(path),
    url: u(path),
    role: 'nav',
    order,
    signals: signals(f),
  });

  it.each([
    [
      'a consent-provider frame',
      { src: 'https://consentcdn.cookiebot.com/sdk/bc-v4.min.html', box: box(0, 0, 300, 200), depth: 1 },
    ],
    [
      'a 4x4 frame above the page',
      { src: 'https://consent.example.net/frame', box: box(0, -9999, 4, 4), depth: 1 },
    ],
    [
      'a frame left of the page',
      { src: 'https://consent.example.net/frame', box: box(-9999, 10, 4, 4), depth: 1 },
    ],
    ['a nested frame', { src: 'https://www.google.com/maps/embed?pb=x', box: box(0, 0, 600, 300), depth: 2 }],
    ['a first-party frame', { src: u('/widget'), box: box(0, 0, 600, 300), depth: 1 }],
  ])('%s is no control signal: the page is chosen only for replication', (_, frame) => {
    const page = candidate('/a', { iframes: [frame] });
    expect(page.signals).toEqual({ thirdPartyIframes: 0, placeholders: 0, newThirdPartyHosts: 0, embeds: 0 });
    expect(chooseControlPages([page]).map((p) => p.reasons)).toEqual([['replication']]);
  });

  it('a map frame is an iframe signal and a catalog embed', () => {
    const page = candidate('/kontakt', {
      iframes: [
        { src: 'https://www.google.com/maps/embed?pb=[redacted]', box: box(0, 300, 600, 300), depth: 1 },
      ],
    });
    expect(chooseControlPages([page]).map((p) => p.reasons)).toEqual([['iframe-signal', 'embed-signal']]);
  });

  it('a video thumbnail new on the page is a network signal and a catalog embed; a CMP host is neither', () => {
    const page = candidate('/geschichte', {
      requests: [
        { url: 'https://i1.ytimg.com/vi/x/hqdefault.jpg', host: 'i1.ytimg.com' },
        { url: 'https://consent.cookiebot.com/uc.js', host: 'consent.cookiebot.com' },
      ],
    });
    expect(page.signals).toEqual({ thirdPartyIframes: 0, placeholders: 0, newThirdPartyHosts: 1, embeds: 1 });
  });

  it('a host already seen on the start page is not new', () => {
    const fonts = { url: 'https://fonts.googleapis.com/css2?family=x', host: 'fonts.googleapis.com' };
    expect(signals({ requests: [fonts], startRequests: [fonts] }).newThirdPartyHosts).toBe(0);
  });

  it('one catalog embed ranks above three unknown new hosts', () => {
    const unknown = candidate(
      '/partner',
      {
        requests: ['a', 'b', 'c'].map((h) => ({
          url: `https://${h}.cdn.example.net/x.js`,
          host: `${h}.cdn.example.net`,
        })),
      },
      1,
    );
    const video = candidate(
      '/geschichte',
      { requests: [{ url: 'https://i1.ytimg.com/vi/x/0.jpg', host: 'i1.ytimg.com' }] },
      2,
    );
    expect(chooseControlPages([unknown, video], { max: 1 }).map((p) => p.url)).toEqual([u('/geschichte')]);
  });
});

describe('chooseControlPages', () => {
  const page = (
    raw: string,
    role: ControlCandidate['role'],
    order: number,
    signals: Partial<ControlCandidate['signals']> = {},
  ): ControlCandidate => ({
    raw,
    url: raw,
    role,
    order,
    signals: { thirdPartyIframes: 0, placeholders: 0, newThirdPartyHosts: 0, embeds: 0, ...signals },
  });

  it('prefers pages with embeds, placeholders and new third parties; then other non-legal pages', () => {
    const pages = chooseControlPages([
      page('https://www.example.test/impressum', 'impressum', 1),
      page('https://www.example.test/blog/', 'nav', 2),
      page('https://www.example.test/kontakt', 'contact', 3, { thirdPartyIframes: 1, newThirdPartyHosts: 2 }),
      page('https://www.example.test/video', 'nav', 4, { placeholders: 1 }),
    ]);
    expect(pages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://www.example.test/kontakt', ['iframe-signal', 'network-signal', 'role:contact']],
      ['https://www.example.test/video', ['placeholder-signal']],
    ]);
  });

  it('takes as many pages as the setting allows', () => {
    const candidates = [1, 2, 3, 4].map((i) => page(u(`/p${i}`), 'nav', i));
    expect(chooseControlPages(candidates, { max: 3 })).toHaveLength(3);
    expect(chooseControlPages(candidates, { max: 0 })).toEqual([]);
  });

  it('pages on the origin of the click page come first, even with weaker signals', () => {
    const pages = chooseControlPages(
      [
        page('https://www.example.test/kontakt', 'contact', 1, { thirdPartyIframes: 1, embeds: 1 }),
        page('https://example.test/team', 'nav', 2),
        page('https://example.test/impressum', 'impressum', 3),
      ],
      { max: 2, clickOrigin: 'https://example.test' },
    );
    expect(pages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://example.test/team', ['replication']],
      ['https://example.test/impressum', ['replication']],
    ]);
  });

  it('the origin is the one the page was shown on, after redirects', () => {
    const redirected = {
      ...page('https://www.example.test/team', 'nav', 1),
      finalUrl: 'https://example.test/team',
    };
    const pages = chooseControlPages([page('https://www.example.test/blog', 'nav', 2), redirected], {
      max: 1,
      clickOrigin: 'https://example.test',
    });
    expect(pages.map((p) => p.url)).toEqual(['https://www.example.test/team']);
  });

  it('pages of another origin are taken only when no page of the click origin is left, and are marked', () => {
    const pages = chooseControlPages(
      [
        page('https://www.example.test/kontakt', 'contact', 1, { thirdPartyIframes: 1 }),
        page('https://example.test/blog', 'nav', 2),
        page('https://www.example.test/team', 'nav', 3),
      ],
      { max: 3, clickOrigin: 'https://example.test' },
    );
    expect(pages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://example.test/blog', ['replication']],
      ['https://www.example.test/kontakt', ['iframe-signal', 'role:contact', 'other-origin']],
      ['https://www.example.test/team', ['replication', 'other-origin']],
    ]);
  });
});
