/** Pure: deterministic page selection with reasons and B/C control pages. */
import { describe, expect, it } from 'vitest';
import {
  type CandidateLink,
  chooseControlPages,
  findLegalLink,
  selectPages,
} from '../../../../src/collectors/browser/pages.ts';
import { parseRobots } from '../../../../src/collectors/browser/robots.ts';

const START = 'https://www.example.test/';
let n = 0;
const link = (p: Partial<CandidateLink> & { raw: string; text: string }): CandidateLink => ({
  hrefKind: p.raw.startsWith('https:') ? 'https' : 'http',
  region: 'footer',
  visible: true,
  order: n++,
  ...p,
});

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

describe('selectPages', () => {
  it('start, Impressum, Datenschutz, Kontakt and ≤ 2 extras from different templates, with reasons', () => {
    const plan = selectPages({
      links: LINKS,
      ...scope,
      maxPages: 6,
      robots: null,
      token: 'dsgvo-check',
      sitemapLocs: [],
    });
    expect(plan.impressum).toMatchObject({
      status: 'page',
      choice: {
        url: 'https://www.example.test/impressum',
        role: 'impressum',
        reasons: ['footer-link:impressum'],
      },
    });
    // The navigation URL keeps the real query; the planned URL is sanitized.
    expect(plan.privacy.choice?.raw).toBe('https://www.example.test/?page_id=3');
    expect(plan.privacy.choice?.url).toBe('https://www.example.test/?page_id=[redacted]');
    expect(plan.contact).toMatchObject({
      url: 'https://www.example.test/kontakt',
      reasons: ['nav-link:kontakt'],
    });
    expect(plan.extras.map((e) => [e.url, e.reasons])).toEqual([
      ['https://www.example.test/ueber-uns', ['keyword:über uns']],
      ['https://www.example.test/blog/', ['keyword:blog']],
    ]);
  });

  it('is deterministic and independent of duplicate links', () => {
    const a = selectPages({
      links: LINKS,
      ...scope,
      maxPages: 6,
      robots: null,
      token: 'dsgvo-check',
      sitemapLocs: [],
    });
    const b = selectPages({
      links: [...LINKS, ...LINKS.map((l) => ({ ...l, order: l.order + 100 }))],
      ...scope,
      maxPages: 6,
      robots: null,
      token: 'dsgvo-check',
      sitemapLocs: [],
    });
    expect(b).toEqual(a);
  });

  it('respects maxPages for extras and robots.txt for additional pages only', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /ueber-uns\nDisallow: /impressum');
    const plan = selectPages({
      links: LINKS,
      ...scope,
      maxPages: 5,
      robots,
      token: 'dsgvo-check',
      sitemapLocs: [],
    });
    expect(plan.impressum.status).toBe('page'); // legal pages are always visited
    expect(plan.extras.map((e) => e.url)).toEqual(['https://www.example.test/blog/']);
    expect(plan.extras[0]?.robotsAllowed).toBe(true);
  });

  it('falls back to sitemap entries with distinct templates', () => {
    const plan = selectPages({
      links: [link({ raw: 'https://www.example.test/impressum', text: 'Impressum' })],
      ...scope,
      maxPages: 6,
      robots: null,
      token: 'dsgvo-check',
      sitemapLocs: [
        'https://www.example.test/produkte/a',
        'https://www.example.test/produkte/b',
        'https://cdn.other.example/x',
        'https://www.example.test/referenzen',
      ],
    });
    expect(plan.extras.map((e) => [e.url, e.source, e.reasons])).toEqual([
      ['https://www.example.test/produkte/a', 'sitemap', ['sitemap']],
      ['https://www.example.test/referenzen', 'sitemap', ['sitemap']],
    ]);
    expect(plan.privacy.status).toBe('none');
  });

  it('classifies # / javascript: / PDF / offsite legal links', () => {
    const l = [
      link({ raw: 'https://www.example.test/#', text: 'Impressum', hrefKind: 'fragment' }),
      link({ raw: 'https://www.example.test/dse.pdf', text: 'Datenschutz' }),
    ];
    const plan = selectPages({
      links: l,
      ...scope,
      maxPages: 6,
      robots: null,
      token: 'dsgvo-check',
      sitemapLocs: [],
    });
    expect(plan.impressum.status).toBe('unresolved');
    expect(plan.privacy).toMatchObject({
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
    const plan = selectPages({
      links: [
        link({ raw: 'https://www.example.test/rechtliches', text: 'Rechtliches' }),
        link({ raw: 'https://www.example.test/ueber-uns', text: 'Über uns', region: 'nav' }),
      ],
      ...scope,
      maxPages: 6,
      robots: null,
      token: 'dsgvo-check',
      sitemapLocs: [],
    });
    expect(plan.hops.map((h) => [h.url, h.reasons])).toEqual([
      ['https://www.example.test/rechtliches', ['hop:rechtliches']],
      ['https://www.example.test/ueber-uns', ['hop:über uns']],
    ]);
  });
});

describe('chooseControlPages', () => {
  it('prefers pages with embeds, placeholders and new third parties; then other non-legal pages', () => {
    const pages = chooseControlPages([
      {
        raw: 'https://www.example.test/impressum',
        url: 'https://www.example.test/impressum',
        role: 'impressum',
        order: 1,
        signals: { thirdPartyIframes: 0, placeholders: 0, newThirdPartyHosts: 0 },
      },
      {
        raw: 'https://www.example.test/blog/',
        url: 'https://www.example.test/blog/',
        role: 'nav',
        order: 2,
        signals: { thirdPartyIframes: 0, placeholders: 0, newThirdPartyHosts: 0 },
      },
      {
        raw: 'https://www.example.test/kontakt',
        url: 'https://www.example.test/kontakt',
        role: 'contact',
        order: 3,
        signals: { thirdPartyIframes: 1, placeholders: 0, newThirdPartyHosts: 2 },
      },
      {
        raw: 'https://www.example.test/video',
        url: 'https://www.example.test/video',
        role: 'nav',
        order: 4,
        signals: { thirdPartyIframes: 0, placeholders: 1, newThirdPartyHosts: 0 },
      },
    ]);
    expect(pages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://www.example.test/kontakt', ['iframe-signal', 'network-signal', 'role:contact']],
      ['https://www.example.test/video', ['placeholder-signal']],
    ]);
  });
});
