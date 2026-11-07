/** Pure: which further privacy notices of a site phase A reads after the policy, and which language versions it notes. */
import { describe, expect, it } from 'vitest';
import {
  type CandidateLink,
  findLegalLink,
  languageContext,
  pageKey,
  privacySupplements,
} from '../../../../../src/collectors/browser/pages/pages.ts';

const START = 'https://www.example.test/';
const u = (path: string) => `https://www.example.test${path}`;
let n = 0;
const link = (p: Partial<CandidateLink> & { raw: string; text: string }): CandidateLink => ({
  hrefKind: p.raw.startsWith('https:') ? 'https' : 'http',
  region: 'footer',
  visible: true,
  order: n++,
  ...p,
});
const scope = { startRaw: START, finalHost: 'www.example.test', etld1: 'example.test' };

/** The supplements beside the policy the links lead to, as `selectPages` would have chosen it. */
function supplements(links: CandidateLink[], max = 1, start = START, lang?: string) {
  const s = { ...scope, startRaw: start };
  const policy = findLegalLink(links, 'privacy', s);
  const main = policy.choice ? pageKey(policy.choice.raw) : '';
  const sel = privacySupplements(links, s, {
    language: languageContext({ raw: start, ...(lang ? { lang } : {}) }, links),
    max,
    skip: (key) => key === main,
  });
  return {
    notices: sel.notices.map((c) => c.url),
    languages: sel.languages.map((c) => c.url),
    reasons: sel.notices.map((c) => c.reasons),
  };
}

const POLICY = link({ raw: u('/datenschutz/'), text: 'Datenschutz' });
const COURSES = link({ raw: u('/datenschutzhinweise-kurse/'), text: 'Datenschutz Kurse' });

describe('privacySupplements', () => {
  it('a second privacy link of the footer is a further notice; the policy itself is not', () => {
    expect(supplements([POLICY, COURSES])).toEqual({
      notices: [u('/datenschutzhinweise-kurse/')],
      languages: [],
      reasons: [['footer-link:datenschutz', 'supplement']],
    });
  });

  it('a start page without a locale that switches to /de/ of its own language reads a notice under /de/', () => {
    const links = [
      link({ raw: u('/de/'), text: 'DE', region: 'header' }),
      link({ raw: u('/en/'), text: 'EN', region: 'header' }),
      link({ raw: u('/de/datenschutz/'), text: 'Datenschutz' }),
      link({ raw: u('/de/datenschutz-kurse/'), text: 'Datenschutz Kurse' }),
      link({ raw: u('/en/privacy/'), text: 'Privacy', region: 'nav' }),
    ];
    expect(supplements(links, 1, START, 'de-DE')).toMatchObject({
      notices: [u('/de/datenschutz-kurse/')],
      languages: [u('/en/privacy/')],
    });
  });

  it('with the limit 0 nothing is chosen and no language version is noted', () => {
    const en = link({ raw: u('/en/datenschutz/'), text: 'EN', region: 'nav' });
    expect(supplements([POLICY, COURSES, en], 0)).toEqual({ notices: [], languages: [], reasons: [] });
  });

  it('with three candidates and the limit 1 only the best-ranked one is chosen', () => {
    const links = [
      link({ raw: u('/datenschutz/'), text: 'Datenschutz', order: 1 }),
      link({ raw: u('/datenschutz-newsletter/'), text: 'Datenschutz Newsletter', region: 'nav', order: 2 }),
      link({ raw: u('/datenschutz-bewerbung/'), text: 'Datenschutzhinweise Bewerbung', order: 3 }),
      link({ raw: u('/datenschutzhinweise-kurse/'), text: 'Datenschutz Kurse', order: 4 }),
    ];
    // Same rank of the label: the footer goes before the navigation, then the order on the page.
    expect(supplements(links).notices).toEqual([u('/datenschutz-bewerbung/')]);
    expect(supplements(links, 3).notices).toEqual([
      u('/datenschutz-bewerbung/'),
      u('/datenschutzhinweise-kurse/'),
      u('/datenschutz-newsletter/'),
    ]);
  });

  it('two labels of one URL are one page: no further notice', () => {
    const same = link({ raw: u('/datenschutz'), text: 'Datenschutzerklärung', region: 'nav' });
    expect(supplements([POLICY, same])).toEqual({ notices: [], languages: [], reasons: [] });
  });

  it.each([
    ['a language code as label', link({ raw: u('/en/datenschutz/'), text: 'EN', region: 'nav' })],
    ['a language name into a locale prefix', link({ raw: u('/en/privacy-policy/'), text: 'English' })],
    [
      'an hreflang of another language',
      link({ raw: u('/privacy-policy/'), text: 'Privacy Policy', hreflang: 'en' }),
    ],
  ])('a language version (%s) is noted, not read, and takes no slot', (_, alt) => {
    expect(supplements([POLICY, alt, COURSES], 1, START, 'de')).toMatchObject({
      notices: [u('/datenschutzhinweise-kurse/')],
      languages: [alt.raw],
    });
  });

  it('on a start page under /de/ the notices of the same prefix count, those under /en/ are language versions', () => {
    const links = [
      link({ raw: u('/de/datenschutz/'), text: 'Datenschutz' }),
      link({ raw: u('/de/datenschutz-kurse/'), text: 'Datenschutz Kurse' }),
      link({ raw: u('/en/privacy/'), text: 'Privacy' }),
    ];
    expect(supplements(links, 1, u('/de/'))).toEqual({
      notices: [u('/de/datenschutz-kurse/')],
      languages: [u('/en/privacy/')],
      reasons: [['footer-link:datenschutz', 'supplement']],
    });
  });

  it.each([
    ['a settings dialog', link({ raw: u('/cookie-settings/'), text: 'Datenschutz-Einstellungen' })],
    ['another site', link({ raw: 'https://kurse.example.net/datenschutz/', text: 'Datenschutz Kurse' })],
    [
      'a link without a page',
      link({ raw: 'javascript:void(0)', text: 'Datenschutz Kurse', hrefKind: 'javascript' }),
    ],
    ['only the path names it', link({ raw: u('/datenschutz-kurse/'), text: 'Kurse' })],
    ['a weak umbrella label', link({ raw: u('/dsgvo/'), text: 'DSGVO' })],
    ['the key inside a longer label', link({ raw: u('/news/datenschutz/'), text: 'Neues zum Datenschutz' })],
    [
      'an article in the content',
      link({ raw: u('/blog/datenschutz-im-verein/'), text: 'Datenschutz im Verein', region: 'main' }),
    ],
    [
      'a box beside the content',
      link({ raw: u('/datenschutz-kurse/'), text: 'Datenschutz Kurse', region: 'aside' }),
    ],
  ])('no further notice: %s', (_, l) => {
    expect(supplements([POLICY, l]).notices).toEqual([]);
  });

  it('counterexample: the same label in the footer is a further notice', () => {
    const l = link({ raw: u('/blog/datenschutz-im-verein/'), text: 'Datenschutz im Verein' });
    expect(supplements([POLICY, l]).notices).toEqual([u('/blog/datenschutz-im-verein/')]);
  });

  it('pages already read or tried are skipped by the caller', () => {
    const links = [POLICY, COURSES];
    const sel = privacySupplements(links, scope, {
      language: languageContext({ raw: START }, links),
      max: 1,
      skip: (key) => key === pageKey(POLICY.raw) || key === pageKey(COURSES.raw),
    });
    expect(sel.notices).toEqual([]);
  });

  it('a PDF notice is chosen like a page; the caller records it without a navigation', () => {
    const pdf = link({
      raw: u('/files/datenschutzhinweise-kurse.pdf'),
      text: 'Datenschutzhinweise Kurse (PDF)',
    });
    expect(supplements([POLICY, pdf]).notices).toEqual([pdf.raw]);
  });
});
