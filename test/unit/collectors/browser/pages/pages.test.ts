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
} from '../../../../../src/collectors/browser/pages/pages.ts';
import { parseRobots } from '../../../../../src/collectors/browser/pages/robots.ts';
import { loadServiceCatalog } from '../../../../../src/derive/catalog.ts';
import { link, plan, START, scope, u } from '../../../../utils/candidate-links.ts';

type LinkFields = Omit<Partial<CandidateLink>, 'raw' | 'text'>;
const siteLink = (path: string, text: string, fields: LinkFields = {}) =>
  link({ raw: u(path), text, ...fields });
const languageSwitch = (path: string, label: string) => siteLink(path, label, { region: 'header' });

const LINKS: CandidateLink[] = [
  siteLink('/leistungen/webdesign', 'Webdesign', { region: 'nav' }),
  siteLink('/ueber-uns', 'Über uns', { region: 'nav' }),
  siteLink('/blog/', 'Blog', { region: 'nav' }),
  siteLink('/blog/post-1', 'Neuer Beitrag', { region: 'main' }),
  siteLink('/kontakt', 'Kontakt', { region: 'nav' }),
  siteLink('/shop/warenkorb', 'Warenkorb', { region: 'header' }),
  siteLink('/team.pdf', 'Team (PDF)', { region: 'main' }),
  siteLink('/impressum', 'Impressum'),
  siteLink('/?page_id=3', 'Datenschutzerklärung'),
  siteLink('/datenschutz-einstellungen', 'Datenschutz-Einstellungen'),
  link({ raw: 'https://other.example/impressum', text: 'Impressum Partner', region: 'main' }),
  link({ raw: 'mailto:info@example.test', text: 'E-Mail', hrefKind: 'mailto' }),
];

const extrasOf = (p: ReturnType<typeof plan>) => p.extras.map((e) => [e.url, e.reasons]);

describe('selectPages', () => {
  it('start, Impressum, Datenschutz, Kontakt and the extras of the first keyword groups, with reasons', () => {
    const p = plan(LINKS);
    expect(p.impressum).toMatchObject({
      status: 'page',
      choice: {
        url: u('/impressum'),
        role: 'impressum',
        reasons: ['footer-link:impressum'],
      },
    });
    // The navigation URL keeps the real query; the planned URL is sanitized.
    expect(p.privacy.choice?.raw).toBe(u('/?page_id=3'));
    expect(p.privacy.choice?.url).toBe(u('/?page_id=[redacted]'));
    expect(p.contact).toMatchObject({
      url: u('/kontakt'),
      reasons: ['nav-link:kontakt'],
    });
    expect(extrasOf(p)).toEqual([
      [u('/ueber-uns'), ['keyword:über uns']],
      [u('/blog/'), ['keyword:blog']],
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
    expect(p.extras.map((e) => e.url)).toEqual([u('/blog/')]);
    expect(p.extras[0]?.robotsAllowed).toBe(true);
  });

  it('falls back to sitemap entries with distinct templates', () => {
    const p = plan([siteLink('/impressum', 'Impressum')], {
      sitemapLocs: [u('/produkte/a'), u('/produkte/b'), 'https://cdn.other.example/x', u('/referenzen')],
    });
    expect(p.extras.map((e) => [e.url, e.source, e.reasons])).toEqual([
      [u('/produkte/a'), 'sitemap', ['sitemap']],
      [u('/referenzen'), 'sitemap', ['sitemap']],
    ]);
    expect(p.privacy.status).toBe('none');
  });

  it('classifies # / javascript: / PDF / offsite legal links', () => {
    const p = plan([
      siteLink('/#', 'Impressum', { hrefKind: 'fragment' }),
      siteLink('/dse.pdf', 'Datenschutz'),
    ]);
    expect(p.impressum.status).toBe('unresolved');
    expect(p.privacy).toMatchObject({
      status: 'pdf',
      choice: { url: u('/dse.pdf') },
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
      siteLink('/rechtliches', 'Rechtliches'),
      siteLink('/ueber-uns', 'Über uns', { region: 'nav' }),
    ]);
    expect(p.hops.map((h) => [h.url, h.reasons])).toEqual([
      [u('/rechtliches'), ['hop:rechtliches']],
      [u('/ueber-uns'), ['hop:über uns']],
    ]);
  });
});

/** The legal links of a site under `prefix`, so that the budget left for extras is the scan's. */
const legal = (prefix = '') => [
  siteLink(`${prefix}/impressum/`, 'Impressum'),
  siteLink(`${prefix}/datenschutz/`, 'Datenschutz'),
];

describe('locale prefixes and language versions', () => {
  it('a /de/ start page leaves its own sections open: history and location pages, never the language roots', () => {
    const p = plan(
      [
        languageSwitch('/de/', 'DE'),
        languageSwitch('/en/', 'EN'),
        languageSwitch('/es/', 'ES'),
        siteLink('/de/kontakt/', 'Kontakt'),
        siteLink('/de/kontakt/anfahrt/', 'Anfahrt'),
        siteLink('/de/unternehmen/geschichte/', 'Unsere Geschichte'),
        siteLink('/de/unternehmen/karriere/', 'Karriere'),
        siteLink('/de/unternehmen/news/', 'News'),
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
      languageSwitch('/en/', 'EN'),
      languageSwitch('/fr/', 'FR'),
      siteLink('/en/products/', 'Products', { region: 'nav' }),
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
        languageSwitch('/en/', 'EN'),
        languageSwitch('/fr/accueil/', 'Français'),
        siteLink('/en/about-us/', 'About us'),
        siteLink('/ueber-uns/', 'Über uns', { region: 'nav' }),
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
          languageSwitch('/de/', label),
          languageSwitch('/en/', 'EN'),
          siteLink('/de/kontakt/', 'Kontakt', { region: 'nav' }),
          siteLink('/de/geschichte/', 'Geschichte', { region: 'nav' }),
          siteLink('/de/anfahrt/', 'Anfahrt', { region: 'nav' }),
          siteLink('/en/history/', 'History', { region: 'nav' }),
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
      languageSwitch('/de-at/', 'DE-AT'),
      languageSwitch('/de/', 'DE'),
    ]);
    expect(ctx.alternatePrefixes).toEqual(new Set(['de-at']));
  });

  it('counterexample: without a locale on the start page, /it/ "IT-Service" is a section and stays eligible', () => {
    const p = plan([
      siteLink('/it/', 'IT-Service', { region: 'nav' }),
      languageSwitch('/en/', 'EN'),
      ...legal(),
    ]);
    expect(extrasOf(p)).toEqual([[u('/it/'), ['keyword:service']]]);
  });

  it('a page marked as another language by one of its links stays out, also as a sitemap entry', () => {
    const p = plan(
      [
        siteLink('/team-en/', 'Team', { hreflang: 'en' }),
        siteLink('/team-en/', 'Our team', { region: 'nav' }),
        ...legal(),
      ],
      { startLang: 'de', sitemapLocs: [u('/team-en/'), u('/leistungen/')] },
    );
    expect(p.extras.map((e) => e.url)).toEqual([u('/leistungen/')]);
  });

  it('a link marked with the hreflang of another language is an alternate, one of the same language is not', () => {
    const p = plan(
      [
        siteLink('/team-en/', 'Team', { hreflang: 'en' }),
        siteLink('/team/', 'Team', { region: 'nav', hreflang: 'de' }),
        ...legal(),
      ],
      { startLang: 'de-DE' },
    );
    expect(extrasOf(p)).toEqual([[u('/team/'), ['keyword:team']]]);
  });

  type AlternateCase = [
    name: string,
    candidate: [path: string, text: string, fields?: LinkFields],
    expected: boolean,
    start?: { path?: string; lang?: string },
  ];
  it.each<AlternateCase>([
    ['another prefix', ['/en/', 'EN'], true, { path: '/de/' }],
    ['another region of the same language', ['/de-at/produkte/', 'Produkte'], true, { path: '/de/' }],
    ['the same prefix', ['/de/produkte/', 'Produkte'], false, { path: '/de/' }],
    ['accessible name only', ['/en/', '', { accessibleName: 'English' }], true, undefined],
    ['a language root without any name', ['/pl/', ''], true, undefined],
    ['a flag named by a sentence', ['/en/', '', { accessibleName: 'Switch to English' }], true, undefined],
    ['a section with a two-letter name', ['/it/', 'IT-Service'], false, undefined],
    ['a language name on a locale root', ['/en/', 'English'], true, undefined],
    ['a language name at the root of a localized site', ['/', 'Deutsch'], true, { path: '/en/' }],
    ['a course page named after a language', ['/kurse/englisch/', 'Englisch'], false, undefined],
    ['a language code as the whole label, any path', ['/home-en.html', 'EN'], true, undefined],
    ['a region form with an underscore', ['/de_de/', 'Deutsch'], true, { path: '/en_gb/' }],
    ['hreflang of another language', ['/team/', 'Team', { hreflang: 'en' }], true, { lang: 'de' }],
    ['hreflang of the start language', ['/team/', 'Team', { hreflang: 'de-at' }], false, { lang: 'de' }],
    ['x-default', ['/team/', 'Team', { hreflang: 'x-default' }], false, { lang: 'de' }],
    [
      'hreflang of the start language on another region prefix',
      ['/de-at/team/', 'Team', { hreflang: 'de-at' }],
      true,
      { path: '/de/', lang: 'de' },
    ],
    ['a language name in its own script', ['/uk/', 'Українська'], true, { lang: 'de' }],
  ])('%s', (_name, fields, expected, { path = '/', lang } = {}) => {
    const candidate = siteLink(...fields);
    const ctx = languageContext({ raw: u(path), ...(lang ? { lang } : {}) }, [candidate]);
    expect(isLanguageAlternate(candidate, ctx)).toBe(expected);
  });
});

describe('extra pages by keyword group', () => {
  it('one page per group, while one section may give pages of different groups', () => {
    const p = plan(
      [
        siteLink('/unternehmen/geschichte', 'Unsere Geschichte', { region: 'main' }),
        siteLink('/unternehmen/team', 'Team', { region: 'main' }),
        siteLink('/blog/a', 'Blog', { region: 'main' }),
        siteLink('/news/b', 'News', { region: 'main' }),
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
      siteLink('/historie/', 'Mehr erfahren', { region: 'footer' }),
      siteLink('/firma/', 'Firmengeschichte', { region: 'nav' }),
      siteLink('/chronik/', 'Chronik', { region: 'main' }),
      ...legal(),
    ]);
    expect(extrasOf(p)).toEqual([[u('/firma/'), ['keyword:geschichte']]]);
  });

  it('a robots.txt refusal passes the group on to its next page', () => {
    const p = plan(
      [
        siteLink('/geschichte/', 'Geschichte', { region: 'nav' }),
        siteLink('/chronik/', 'Chronik', { region: 'main' }),
        ...legal(),
      ],
      { robots: parseRobots('User-agent: *\nDisallow: /geschichte/') },
    );
    expect(extrasOf(p)).toEqual([[u('/chronik/'), ['keyword:chronik']]]);
  });

  it('a menu does not count as a contact page or a map keyword match', () => {
    const p = plan([siteLink('/speisekarte', 'Speisekarte', { region: 'main' }), ...legal()]);
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
      siteLink('/impressum/', 'Impressum'),
      siteLink('/dse.pdf', 'Datenschutz'),
    ]);
    // A PDF link is read without a visit: the start page, the Impressum and 4 extras.
    expect(withPdf.extrasWanted).toBe(4);
  });

  const MANY = [
    siteLink('/kontakt/', 'Kontakt', { region: 'nav' }),
    siteLink('/videos/', 'Videos', { region: 'nav' }),
    siteLink('/anfahrt/', 'Anfahrt', { region: 'nav' }),
    siteLink('/geschichte/', 'Geschichte', { region: 'nav' }),
    siteLink('/ueber-uns/', 'Über uns', { region: 'nav' }),
    siteLink('/team/', 'Team', { region: 'nav' }),
    siteLink('/karriere/', 'Karriere', { region: 'nav' }),
    siteLink('/referenzen/', 'Referenzen', { region: 'nav' }),
    siteLink('/blog/', 'Blog', { region: 'nav' }),
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
      siteLink('/impressum-datenschutz/', 'Impressum'),
      siteLink('/impressum-datenschutz/', 'Datenschutz'),
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
    siteLink('/de/impressum/', 'Impressum'),
    siteLink('/en/privacy/', 'Privacy Policy', { hreflang: 'en' }),
    siteLink('/de/datenschutz/', 'Datenschutz'),
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
  ])('%s is no control signal', (_, frame) => {
    expect(signals({ iframes: [frame] })).toEqual({
      thirdPartyIframes: 0,
      placeholders: 0,
      newThirdPartyHosts: 0,
      embeds: 0,
    });
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
      page(u('/impressum'), 'impressum', 1),
      page(u('/blog/'), 'nav', 2),
      page(u('/kontakt'), 'contact', 3, { thirdPartyIframes: 1, newThirdPartyHosts: 2 }),
      page(u('/video'), 'nav', 4, { placeholders: 1 }),
    ]);
    expect(pages.map((p) => [p.url, p.reasons])).toEqual([
      [u('/kontakt'), ['iframe-signal', 'network-signal', 'role:contact']],
      [u('/video'), ['placeholder-signal']],
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
        page(u('/kontakt'), 'contact', 1, { thirdPartyIframes: 1, embeds: 1 }),
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
      ...page(u('/team'), 'nav', 1),
      finalUrl: 'https://example.test/team',
    };
    const pages = chooseControlPages([page(u('/blog'), 'nav', 2), redirected], {
      max: 1,
      clickOrigin: 'https://example.test',
    });
    expect(pages.map((p) => p.url)).toEqual([u('/team')]);
  });

  it('pages of another origin are taken only when no page of the click origin is left, and are marked', () => {
    const pages = chooseControlPages(
      [
        page(u('/kontakt'), 'contact', 1, { thirdPartyIframes: 1 }),
        page('https://example.test/blog', 'nav', 2),
        page(u('/team'), 'nav', 3),
      ],
      { max: 3, clickOrigin: 'https://example.test' },
    );
    expect(pages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://example.test/blog', ['replication']],
      [u('/kontakt'), ['iframe-signal', 'role:contact', 'other-origin']],
      [u('/team'), ['replication', 'other-origin']],
    ]);
  });
});
