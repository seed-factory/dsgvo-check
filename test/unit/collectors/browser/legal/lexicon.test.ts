/**
 * The shared legal-link lexicon (test/data/legal/links.yaml) is consistent: every canonical label wins only for its own
 * kind, every language has markers, normalisation folds supported characters, a malformed file is rejected readably.
 */
import { describe, expect, it } from 'vitest';
import {
  type LegalKind,
  legalLexiconFromData,
  markerLanguages,
  matchLegalLink,
  matchLegalLinks,
  matchNav,
  normalizeLegalText,
} from '../../../../../src/collectors/browser/legal/lexicon.ts';
import { loadLegalLexicon } from '../../../../../src/collectors/browser/legal/lexicon-file.ts';
import { loadDataDir } from '../../../../../src/core/data/load.ts';

const lex = loadLegalLexicon();
const raw = (
  loadDataDir('legal') as {
    legal: { kinds: Record<LegalKind, { languages: Record<string, { labels?: string[] }> }> };
  }
).legal;
const labelsOf = (kind: LegalKind) =>
  Object.entries(raw.kinds[kind].languages).flatMap(([lang, e]) =>
    (e.labels ?? []).map((l) => [lang, l] as const),
  );

describe('legal lexicon data', () => {
  it('has a version and both kinds in at least ten languages', () => {
    expect(lex.version).toMatch(/^\d{4}\.\d+\.\d+$/);
    for (const kind of ['impressum', 'privacy'] as const) {
      expect(Object.keys(raw.kinds[kind].languages).length).toBeGreaterThanOrEqual(10);
    }
  });

  it.each(labelsOf('privacy'))(
    'privacy label (%s) "%s" is an exact match of the privacy kind',
    (_, label) => {
      expect(matchLegalLink(lex, 'privacy', { text: label, path: '' })).toMatchObject({
        tier: 0,
        byText: true,
      });
    },
  );

  it.each(labelsOf('impressum'))(
    'impressum label (%s) "%s" is an exact match of the impressum kind',
    (_, label) => {
      expect(matchLegalLink(lex, 'impressum', { text: label, path: '' })).toMatchObject({
        tier: 0,
        byText: true,
      });
    },
  );

  it('a label of one kind is not a link of the other kind', () => {
    for (const [, label] of labelsOf('privacy'))
      expect(matchLegalLink(lex, 'impressum', { text: label, path: '' }), label).toBeNull();
    for (const [, label] of labelsOf('impressum'))
      expect(matchLegalLink(lex, 'privacy', { text: label, path: '' }), label).toBeNull();
  });

  it('every canonical label is also a marker of its kind (so a page under that title is a document)', () => {
    for (const kind of ['impressum', 'privacy'] as const)
      for (const [lang, label] of labelsOf(kind))
        expect(markerLanguages(lex, kind, [label]), `${kind}/${lang}/${label}`).not.toEqual([]);
  });

  it('navigation: contact and hop keys exist, "legal" and "about" are strict', () => {
    expect(lex.contact.length).toBeGreaterThan(5);
    expect(lex.hop.filter((p) => p.strict).map((p) => p.norm)).toEqual(['legal', 'about']);
    expect(matchNav(lex.contact, { text: 'Kontaktlinsen', path: '' })).toBeNull();
    expect(matchNav(lex.contact, { text: 'Kontakt', path: '' })).toMatchObject({
      tier: 0,
      keyword: 'kontakt',
    });
  });
});

describe('normalizeLegalText', () => {
  it.each([
    ['Datenschutzerklärung', 'datenschutzerklaerung'],
    ['Straße Ünder', 'strasse uender'],
    ['Politique de confidentialité', 'politique de confidentialite'],
    ['Persónuvernd', 'personuvernd'],
    ['Polityka prywatności', 'polityka prywatnosci'],
    ['personvernerklæring', 'personvernerklaering'],
    ['Impressum – Kontakt/Anfahrt', 'impressum kontakt anfahrt'],
    ['Ｉｍｐｒｅｓｓｕｍ', 'impressum'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeLegalText(input)).toBe(expected);
  });
});

describe('legalLexiconFromData', () => {
  it('rejects a malformed file with a readable message', () => {
    expect(() => legalLexiconFromData({ legal: { version: '1' } })).toThrow(/legal lexicon: .*kinds/);
    expect(() => legalLexiconFromData(null)).toThrow(/legal lexicon/);
  });

  it('accepts the merged data directory and the bare lexicon object alike', () => {
    const merged = loadDataDir('legal');
    const bare = (merged as { legal: unknown }).legal;
    expect(legalLexiconFromData(bare).version).toBe(legalLexiconFromData(merged).version);
  });
});

describe('a weak key of one kind loses against an exact label of the other kind', () => {
  const imp = (input: { text: string; accessibleName?: string; path: string }) =>
    matchLegalLink(lex, 'impressum', input);
  const pri = (input: { text: string; accessibleName?: string; path: string }) =>
    matchLegalLink(lex, 'privacy', input);

  it('text "Privacy Policy" with the accessible name "Legal Information" is the privacy policy, not the Impressum', () => {
    const link = { text: 'Privacy Policy', accessibleName: 'Legal Information', path: '/privacy' };
    expect(imp(link)).toBeNull();
    expect(pri(link)).toMatchObject({ tier: 0, byText: true });
  });

  it('the accessible name of a link with a new-tab hint ("Legal Information, opens in a new tab") is no Impressum key either', () => {
    const link = {
      text: 'Privacy Policy',
      accessibleName: 'Legal Information, opens in a new tab',
      path: '/privacy',
    };
    expect(imp(link)).toBeNull();
    expect(pri(link)).toMatchObject({ tier: 0 });
  });

  it('the weak key of the path loses against the exact label too', () => {
    expect(imp({ text: 'Privacy Policy', path: '/legal-information' })).toBeNull();
    expect(pri({ text: 'Privacy Policy', path: '/legal-information' })).toMatchObject({ tier: 0 });
  });

  it('counterexamples: a genuine "Legal information" link is the Impressum, and so is one with a privacy-free name', () => {
    expect(imp({ text: 'Legal information', path: '' })).toMatchObject({ tier: 4, byText: true });
    expect(imp({ text: 'Legal information', path: '/impressum' })).not.toBeNull();
    expect(
      imp({ text: 'Legal Information', accessibleName: 'Legal Information, opens in a new tab', path: '' }),
    ).toMatchObject({ tier: 4, byText: true });
    expect(
      imp({ text: 'Legal Information', accessibleName: 'Legal Information', path: '/info' }),
    ).toMatchObject({
      tier: 4,
    });
    expect(pri({ text: 'Legal information', path: '' })).toBeNull();
  });

  it('counterexample: a non-weak match of the Impressum survives an exact privacy label on the same link', () => {
    // "Imprint" is exact for the Impressum, "Privacy Policy" for the policy: a combined link points to both.
    const link = { text: 'Imprint', accessibleName: 'Privacy Policy', path: '/legal' };
    expect(imp(link)).toMatchObject({ tier: 0 });
    expect(pri(link)).toMatchObject({ tier: 0 });
  });

  it('the same rule holds the other way round: a weak privacy key loses against an exact Impressum label', () => {
    expect(pri({ text: 'Impressum', accessibleName: 'GDPR', path: '/impressum' })).toBeNull();
    expect(imp({ text: 'Impressum', accessibleName: 'GDPR', path: '/impressum' })).toMatchObject({ tier: 0 });
  });

  describe('matchLegalLinks: links to one page', () => {
    const page = 'https://www.example.test/privacy';
    const refs = [
      { input: { text: 'Privacy Policy', path: '/privacy' }, page },
      { input: { text: 'View our policy', accessibleName: 'Legal Information', path: '/privacy' }, page },
    ];

    it('the weak Impressum match of the second link is dropped because another link to the page is exact privacy', () => {
      expect(matchLegalLinks(lex, 'impressum', refs).map((m) => m?.tier ?? null)).toEqual([null, null]);
      // The second link still names the page by its path (privacy).
      expect(matchLegalLinks(lex, 'privacy', refs).map((m) => m?.tier ?? null)).toEqual([0, 3]);
    });

    it('counterexample: the same two links to different pages keep their own kinds', () => {
      const other = [refs[0]!, { ...refs[1]!, page: 'https://www.example.test/legal-info' }];
      expect(matchLegalLinks(lex, 'impressum', other).map((m) => m?.tier ?? null)).toEqual([null, 4]);
    });

    it('counterexample: links without a page identity are not merged', () => {
      const none = refs.map((r) => ({ ...r, page: '' }));
      expect(matchLegalLinks(lex, 'impressum', none).map((m) => m?.tier ?? null)).toEqual([null, 4]);
    });

    it('counterexample: two exact labels of different kinds on one page both stay (combined page)', () => {
      const both = [
        { input: { text: 'Datenschutzerklärung', path: '/recht' }, page },
        { input: { text: 'Impressum', path: '/recht' }, page },
      ];
      expect(matchLegalLinks(lex, 'privacy', both).map((m) => m?.tier ?? null)).toEqual([0, null]);
      expect(matchLegalLinks(lex, 'impressum', both).map((m) => m?.tier ?? null)).toEqual([null, 0]);
    });

    it('counterexample: a non-weak Impressum key on a page that also has an exact privacy label stays', () => {
      const mixed = [
        { input: { text: 'Datenschutzerklärung', path: '/recht' }, page },
        { input: { text: 'Kontakt und Impressum', path: '/recht' }, page },
      ];
      expect(matchLegalLinks(lex, 'impressum', mixed).map((m) => m?.tier ?? null)).toEqual([null, 2]);
    });
  });
});
