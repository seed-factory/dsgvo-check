/**
 * Pure: ranking and lexicon of legal links on the start page.
 * Labels are matched on word boundaries after normalisation (NFKC, case, ä/ae); an exact canonical label beats a
 * label that starts with the key, and that beats a key inside the label; the generic "rechtliche Hinweise" and
 * "DSGVO" are the last resort. Localised labels come from test/data/legal/links.yaml.
 */
import { describe, expect, it } from 'vitest';
import { matchLegalLink } from '../../../../src/collectors/browser/legal-lexicon.ts';
import { loadLegalLexicon } from '../../../../src/collectors/browser/legal-lexicon-file.ts';
import { type CandidateLink, findLegalLink, selectPages } from '../../../../src/collectors/browser/pages.ts';

const START = 'https://www.example.test/';
const scope = { startRaw: START, finalHost: 'www.example.test', etld1: 'example.test' };
let n = 0;
const link = (p: Partial<CandidateLink> & { raw: string; text: string }): CandidateLink => ({
  hrefKind: p.raw.startsWith('https:') ? 'https' : 'http',
  region: 'footer',
  visible: true,
  order: n++,
  ...p,
});
const u = (path: string) => `https://www.example.test${path}`;
const select = (links: CandidateLink[]) =>
  selectPages({ links, ...scope, maxPages: 6, robots: null, token: 'dsgvo-check', sitemapLocs: [] });

describe('exact labels outrank generic and topical ones', () => {
  it('"Rechtliche Hinweise" (first in the DOM) loses against "Impressum"', () => {
    const r = findLegalLink(
      [
        link({ raw: u('/hinweise'), text: 'Rechtliche Hinweise' }),
        link({ raw: u('/anbieter'), text: 'Impressum' }),
      ],
      'impressum',
      scope,
    );
    expect(r.status).toBe('page');
    expect(r.choice?.raw).toBe(u('/anbieter'));
  });

  it.each([
    [
      '"DSGVO konform" loses against "Hinweise zum Datenschutz"',
      'Webdesign DSGVO konform',
      'Hinweise zum Datenschutz',
    ],
    [
      'a topical "Datenschutz-…" loses against "Datenschutz"',
      'Datenschutz-Grundverordnung erklärt',
      'Datenschutz',
    ],
    [
      '"Datenschutz vergleichen" loses against "Datenschutzrichtlinie"',
      'Datenschutz vergleichen',
      'Datenschutzrichtlinie',
    ],
  ])('privacy: %s', (_, weak, good) => {
    const r = findLegalLink(
      [link({ raw: u('/erstens'), text: weak }), link({ raw: u('/zweitens'), text: good })],
      'privacy',
      scope,
    );
    expect(r.choice?.raw).toBe(u('/zweitens'));
  });

  it('region does not outrank label precision: a nav "Datenschutz" beats a footer "Datenschutz vergleichen"', () => {
    const r = findLegalLink(
      [
        link({ raw: u('/vergleich'), text: 'Datenschutz vergleichen', region: 'footer' }),
        link({ raw: u('/dse'), text: 'Datenschutz', region: 'nav' }),
      ],
      'privacy',
      scope,
    );
    expect(r.choice?.raw).toBe(u('/dse'));
  });

  it('on equal precision an href with the legal slug wins, then region and DOM order', () => {
    const a = findLegalLink(
      [
        link({ raw: u('/seite-7'), text: 'Datenschutz', order: 1 }),
        link({ raw: u('/datenschutz'), text: 'Datenschutz', order: 2 }),
      ],
      'privacy',
      scope,
    );
    expect(a.choice?.raw).toBe(u('/datenschutz'));
    const b = findLegalLink(
      [
        link({ raw: u('/x'), text: 'Impressum', region: 'nav', order: 1 }),
        link({ raw: u('/y'), text: 'Impressum', region: 'footer', order: 2 }),
      ],
      'impressum',
      scope,
    );
    expect(b.choice?.raw).toBe(u('/y'));
  });

  it('returns the ranked candidates (chosen first) and the plan records the alternatives', () => {
    const links = [
      link({ raw: u('/b'), text: 'Datenschutz vergleichen' }),
      link({ raw: u('/a'), text: 'Datenschutz' }),
      link({ raw: u('/c'), text: 'DSGVO' }),
      link({ raw: u('/a'), text: 'Datenschutz', region: 'nav' }),
    ];
    const r = findLegalLink(links, 'privacy', scope);
    expect(r.candidates?.map((c) => c.raw)).toEqual([u('/a'), u('/b'), u('/c')]);
    expect(r.choice?.raw).toBe(u('/a'));
    const plan = select(links);
    expect(plan.privacy.choice?.reasons).toEqual([
      'footer-link:datenschutz',
      'alt:footer-link:datenschutz',
      'alt:footer-link:dsgvo',
    ]);
  });

  it('a single candidate keeps the plain reason', () => {
    const plan = select([link({ raw: u('/impressum'), text: 'Impressum' })]);
    expect(plan.impressum.choice?.reasons).toEqual(['footer-link:impressum']);
  });
});

describe('hop and contact keys use word boundaries', () => {
  it('"legal" and "about" count only as the exact label or the first path segment', () => {
    const plan = select([
      link({ raw: u('/illegale-praktiken'), text: 'Illegale Praktiken' }),
      link({ raw: u('/about'), text: 'About' }),
    ]);
    expect(plan.hops.map((h) => h.raw)).toEqual([u('/about')]);
  });

  it('a first path segment "legal" is a hop; "illegal…" in the path is not', () => {
    const hop = select([link({ raw: u('/legal/info'), text: 'Mehr' })]);
    expect(hop.hops.map((h) => h.raw)).toEqual([u('/legal/info')]);
    const none = select([link({ raw: u('/illegale-inhalte'), text: 'Mehr' })]);
    expect(none.hops).toEqual([]);
  });

  it('contact: "Kontaktlinsen" is no contact page, "Kontakt" is', () => {
    const plan = select([
      link({ raw: u('/kontaktlinsen'), text: 'Kontaktlinsen', region: 'nav' }),
      link({ raw: u('/kontakt'), text: 'Kontakt', region: 'nav' }),
    ]);
    expect(plan.contact?.raw).toBe(u('/kontakt'));
  });

  it('contact labels keep "Kontakt & Anfahrt" and reject "Kontaktlinsen"', () => {
    const plan = select([
      link({ raw: u('/kontakt'), text: 'Kontakt & Anfahrt', region: 'nav' }),
      link({ raw: u('/kontaktlinsen'), text: 'Kontaktlinsen', region: 'nav' }),
    ]);
    expect(plan.contact?.raw).toBe(u('/kontakt'));
    expect(plan.contact?.reasons).toEqual(['nav-link:kontakt']);
    // The unrelated page is no contact and no hop page (the hop budget is not spent on it).
    expect(plan.hops.map((c) => c.raw)).not.toContain(u('/kontaktlinsen'));
  });

  it('contact: a lone "Kontakt & Anfahrt" or "Kontakt / Impressum" is chosen, not only the exact label', () => {
    expect(select([link({ raw: u('/k'), text: 'Kontakt & Anfahrt' })]).contact?.raw).toBe(u('/k'));
    const plan = select([
      link({ raw: u('/k'), text: 'Kontakt / Impressum' }),
      link({ raw: u('/i'), text: 'Impressum' }),
    ]);
    expect(plan.impressum.choice?.raw).toBe(u('/i'));
    expect(plan.contact?.raw).toBe(u('/k'));
  });

  it('contact: the path segment is matched on word boundaries as well', () => {
    expect(select([link({ raw: u('/kontaktlinsen/'), text: 'Mehr' })]).contact).toBeNull();
    expect(select([link({ raw: u('/de/kontakt-anfahrt'), text: 'Mehr' })]).contact?.raw).toBe(
      u('/de/kontakt-anfahrt'),
    );
  });

  it('contact: an exact label outranks one that merely starts with the key', () => {
    const plan = select([
      link({ raw: u('/a'), text: 'Kontakt & Anfahrt', region: 'nav', order: 1 }),
      link({ raw: u('/b'), text: 'Kontakt', region: 'nav', order: 2 }),
    ]);
    expect(plan.contact?.raw).toBe(u('/b'));
  });
});

describe('localised labels', () => {
  const privacy: Array<[string, string]> = [
    ['fr', 'Politique de confidentialité'],
    ['fr', 'Protection des données personnelles'],
    ['es', 'Política de privacidad'],
    ['it', 'Informativa privacy'],
    ['it', 'Protezione dati'],
    ['pt', 'Aviso de Privacidade'],
    ['nl', 'Privacyverklaring'],
    ['no', 'Personvern'],
    ['da', 'Privatlivspolitik'],
    ['sv', 'Integritetspolicy'],
    ['sv', 'Personuppgifter'],
    ['fi', 'Tietosuoja'],
    ['is', 'Persónuvernd'],
    ['pl', 'Polityka prywatności'],
  ];
  it.each(privacy)('privacy (%s): "%s"', (_, label) => {
    const r = findLegalLink([link({ raw: u('/p1'), text: label })], 'privacy', scope);
    expect(r.status).toBe('page');
    expect(r.choice?.raw).toBe(u('/p1'));
  });

  const impressum: Array<[string, string]> = [
    ['fr', 'Mentions légales'],
    ['es', 'Aviso legal'],
    ['it', 'Note legali'],
    ['pt', 'Aviso legal'],
    ['nl', 'Colofon'],
    ['pl', 'Nota prawna'],
  ];
  it.each(impressum)('impressum (%s): "%s"', (_, label) => {
    const r = findLegalLink([link({ raw: u('/i1'), text: label })], 'impressum', scope);
    expect(r.status).toBe('page');
  });

  it('localised path slugs find the link when the label is an icon', () => {
    expect(
      findLegalLink([link({ raw: u('/politique-de-confidentialite'), text: '' })], 'privacy', scope).status,
    ).toBe('page');
    expect(findLegalLink([link({ raw: u('/mentions-legales'), text: '' })], 'impressum', scope).status).toBe(
      'page',
    );
  });

  it('a localised policy that mentions cookies is not dropped as a settings link', () => {
    const r = findLegalLink(
      [link({ raw: u('/p'), text: 'Polityka prywatności i plików cookies' })],
      'privacy',
      scope,
    );
    expect(r.status).toBe('page');
    const de = findLegalLink(
      [link({ raw: u('/q'), text: 'Datenschutzerklärung und Cookie-Richtlinie' })],
      'privacy',
      scope,
    );
    expect(de.status).toBe('page');
  });

  it('counterexamples: settings links and topical headlines are no privacy link', () => {
    const settings = findLegalLink(
      [
        link({ raw: u('/s1'), text: 'Cookie-Einstellungen' }),
        link({ raw: u('/s2'), text: 'Datenschutz-Einstellungen' }),
        link({ raw: u('/s3'), text: 'Privacy settings' }),
        link({ raw: u('/s4'), text: 'Datenschutz & Cookies' }),
      ],
      'privacy',
      scope,
    );
    expect(settings.status).toBe('none');
    const headline = findLegalLink(
      [
        link({
          raw: u('/ratgeber/artikel-17'),
          text: 'Datenschutz im Alltag: So schützen Sie Ihre persönlichen Daten online richtig',
          region: 'main',
        }),
      ],
      'privacy',
      scope,
    );
    expect(headline.status).toBe('none');
  });
});

describe('hidden vendor links of the consent banner', () => {
  const vendor = 'https://consent-vendor.example/privacy-policy';

  it('only a hidden banner link to another registrable domain → none', () => {
    const r = findLegalLink(
      [link({ raw: vendor, text: 'Privacy Policy', region: 'banner', visible: false })],
      'privacy',
      scope,
    );
    expect(r.status).toBe('none');
  });

  it('a same-site "Datenschutz" link is chosen next to it', () => {
    const r = findLegalLink(
      [
        link({ raw: vendor, text: 'Privacy Policy', region: 'banner', visible: false, order: 0 }),
        link({ raw: u('/datenschutz'), text: 'Datenschutz', order: 1 }),
      ],
      'privacy',
      scope,
    );
    expect(r.choice?.raw).toBe(u('/datenschutz'));
  });

  it('counterexample: a hidden same-site banner link still counts', () => {
    const r = findLegalLink(
      [link({ raw: u('/datenschutz'), text: 'Datenschutz', region: 'banner', visible: false })],
      'privacy',
      scope,
    );
    expect(r.status).toBe('page');
  });

  it('counterexample: a visible offsite link is still reported as offsite', () => {
    const r = findLegalLink(
      [link({ raw: 'https://konzern.example/impressum', text: 'Impressum', region: 'footer' })],
      'impressum',
      scope,
    );
    expect(r.status).toBe('offsite');
  });
});

const lex = loadLegalLexicon();
const privacyMatch = (text: string, path = '') => matchLegalLink(lex, 'privacy', { text, path });

describe('hyphenated and spaced spellings of a canonical label keep the exact rank', () => {
  it.each([
    'Datenschutz-Hinweise',
    'Datenschutz-Hinweis',
    'Datenschutz-Erklärung',
    'Datenschutz-Information',
    'Datenschutz-Informationen',
    'Datenschutz-Richtlinie',
    'Datenschutz-Bestimmungen',
    'Datenschutz Erklärung',
    'Privacy-Policy',
  ])('"%s" is an exact canonical label (tier 0)', (label) => {
    expect(privacyMatch(label)).toMatchObject({ tier: 0, byText: true });
  });

  it('a topical "Datenschutz-Garten" (first in the DOM) loses against "Datenschutz-Hinweise"', () => {
    const r = findLegalLink(
      [
        link({ raw: u('/garten'), text: 'Datenschutz-Garten', order: 1 }),
        link({ raw: u('/hinweise'), text: 'Datenschutz-Hinweise', order: 2 }),
      ],
      'privacy',
      scope,
    );
    expect(r.choice?.raw).toBe(u('/hinweise'));
  });

  it('"Datenschutzbeauftragter" (first in the DOM) loses against "Datenschutz-Erklärung"', () => {
    const r = findLegalLink(
      [
        link({ raw: u('/dsb'), text: 'Datenschutzbeauftragter', order: 1 }),
        link({ raw: u('/erklaerung'), text: 'Datenschutz-Erklärung', order: 2 }),
      ],
      'privacy',
      scope,
    );
    expect(r.choice?.raw).toBe(u('/erklaerung'));
  });

  it('counterexamples: a lone topical "Datenschutz-Garten" stays a generic candidate, settings stay rejected', () => {
    expect(privacyMatch('Datenschutz-Garten')).toMatchObject({ tier: 1 });
    expect(privacyMatch('Datenschutz-Einstellungen')).toBeNull();
    expect(privacyMatch('Datenschutz-Grundverordnung erklärt')).toMatchObject({ tier: 1 });
  });
});

describe('weak keys count as a whole label or in a short label, not inside a long one', () => {
  it.each(['Webdesign DSGVO konform', 'Alles zur DSGVO', 'Unsere Leistungen sind DSGVO-konform und sicher'])(
    'privacy: "%s" is no privacy link',
    (label) => {
      expect(privacyMatch(label, '/leistungen/webdesign')).toBeNull();
      expect(
        findLegalLink([link({ raw: u('/leistungen/webdesign'), text: label })], 'privacy', scope).status,
      ).toBe('none');
    },
  );

  it('counterexamples: the whole label "DSGVO", a short label and the href slug still find the weak link', () => {
    expect(privacyMatch('DSGVO')).toMatchObject({ tier: 4, byText: true });
    expect(privacyMatch('DSGVO Hinweise')).toMatchObject({ tier: 4, byText: true });
    expect(privacyMatch('Webdesign DSGVO konform', '/dsgvo')).toMatchObject({ tier: 4, byText: false });
    expect(findLegalLink([link({ raw: u('/dsgvo'), text: 'DSGVO' })], 'privacy', scope).status).toBe('page');
  });

  it('impressum: a weak key inside a long label is no Impressum link, the whole label is', () => {
    const imp = (text: string) => matchLegalLink(lex, 'impressum', { text, path: '' });
    expect(imp('Der Herausgeber im Interview')).toBeNull();
    expect(imp('Herausgeber')).toMatchObject({ tier: 4 });
    expect(imp('Legal Information')).toMatchObject({ tier: 4 });
    expect(imp('Rechtliche Hinweise')).toMatchObject({ tier: 4 });
  });

  it('a weak link still loses against a real label next to it', () => {
    const r = findLegalLink(
      [
        link({ raw: u('/dsgvo'), text: 'DSGVO', order: 1 }),
        link({ raw: u('/dse'), text: 'Datenschutzerklärung', order: 2 }),
      ],
      'privacy',
      scope,
    );
    expect(r.choice?.raw).toBe(u('/dse'));
  });
});

describe('one URL with an exact privacy label does not go to the Impressum through a weak key', () => {
  const PRIVACY_URL = 'https://www.example.test/privacy';
  // A consent banner link to the policy whose accessible name is a generic label, and the footer link with its own text.
  const footerPrivacy = (o: Partial<CandidateLink> = {}) =>
    link({ raw: PRIVACY_URL, text: 'Privacy Policy', region: 'footer', order: 10, ...o });
  const bannerPrivacy = (name: string, o: Partial<CandidateLink> = {}) =>
    link({
      raw: PRIVACY_URL,
      text: 'View our Privacy Policy',
      accessibleName: name,
      region: 'banner',
      order: 1,
      ...o,
    });

  it.each([
    ['the accessible name with the new-tab hint', 'Legal Information, opens in a new tab'],
    ['the short accessible name', 'Legal Information'],
  ])('%s: the policy link in the banner and in the footer is privacy only', (_, name) => {
    const links = [bannerPrivacy(name), footerPrivacy()];
    const sel = select(links);
    expect(sel.privacy.status).toBe('page');
    expect(sel.privacy.choice?.raw).toBe(PRIVACY_URL);
    expect(sel.impressum.status).toBe('none');
    // The URL is planned once, under the role privacy.
    const roles = [sel.impressum, sel.privacy].flatMap((r) =>
      r.status === 'page' && r.choice ? [[r.choice.role, r.choice.raw]] : [],
    );
    expect(roles).toEqual([['privacy', PRIVACY_URL]]);
  });

  it('the link of the banner alone (text and name on one link) is privacy, with the exact label', () => {
    const only = bannerPrivacy('Legal Information', { text: 'Privacy Policy' });
    expect(findLegalLink([only], 'impressum', scope).status).toBe('none');
    const p = findLegalLink([only], 'privacy', scope);
    expect(p.choice?.raw).toBe(PRIVACY_URL);
    expect(p.choice?.reasons[0]).toMatch(/^banner-link:privacy/);
  });

  it('the DOM order does not matter: the footer link first, the banner link after it', () => {
    const sel = select([footerPrivacy({ order: 1 }), bannerPrivacy('Legal Information', { order: 20 })]);
    expect(sel.impressum.status).toBe('none');
    expect(sel.privacy.choice?.raw).toBe(PRIVACY_URL);
  });

  it('counterexample: a genuine "Legal information" link to an Impressum page stays the Impressum next to the policy', () => {
    const IMP = u('/legal-notice');
    const sel = select([
      bannerPrivacy('Legal Information, opens in a new tab'),
      footerPrivacy(),
      link({ raw: IMP, text: 'Legal information', region: 'footer', order: 11 }),
    ]);
    expect(sel.impressum.status).toBe('page');
    expect(sel.impressum.choice?.raw).toBe(IMP);
    expect(sel.privacy.choice?.raw).toBe(PRIVACY_URL);
  });

  it('counterexample: a "Legal information" link to a page of its own is the Impressum when no policy link shares its URL', () => {
    const IMP = u('/legal-info');
    const sel = select([
      footerPrivacy(),
      link({ raw: IMP, text: 'Legal Information', accessibleName: 'Legal Information', order: 11 }),
    ]);
    expect(sel.impressum.choice?.raw).toBe(IMP);
    expect(sel.privacy.choice?.raw).toBe(PRIVACY_URL);
  });

  it('counterexample: an exact Impressum label and an exact privacy label on one URL both keep the page', () => {
    const URL_BOTH = u('/recht');
    const sel = select([
      link({ raw: URL_BOTH, text: 'Impressum', order: 1 }),
      link({ raw: URL_BOTH, text: 'Datenschutzerklärung', order: 2 }),
    ]);
    expect(sel.impressum.choice?.raw).toBe(URL_BOTH);
    expect(sel.privacy.choice?.raw).toBe(URL_BOTH);
  });

  it('a weak candidate of the Impressum on the policy URL does not hide another weak candidate on a different URL', () => {
    const OTHER = u('/rechtliches');
    const sel = select([
      footerPrivacy(),
      bannerPrivacy('Legal Information'),
      link({ raw: OTHER, text: 'Rechtliche Hinweise', order: 12 }),
    ]);
    expect(sel.impressum.choice?.raw).toBe(OTHER);
    expect(sel.impressum.candidates?.map((c) => c.raw)).toEqual([OTHER]);
  });
});
