/**
 * The verdict on a fetched page (pure): the type is decided by title, h1 and section headings with the localised
 * markers of test/data/legal/links.yaml; a substantive page without marker is `unconfirmed`, the marker language is recorded.
 */
import { describe, expect, it } from 'vitest';
import {
  documentLang,
  judgeDocument,
  judgeDocumentDetail,
} from '../../../../../src/collectors/browser/legal/documents.ts';

const filler = (n: number) => 'Fließtext ohne Überschrift. '.repeat(Math.ceil(n / 28)).slice(0, n);

describe('judgeDocument: markers in title, h1 and headings of the whole document', () => {
  it('a Portuguese policy of 57 000 characters with the heading "Aviso de Privacidade" is a document', () => {
    const d = judgeDocumentDetail('privacy', {
      title: 'Empresa Exemplo',
      h1: 'Aviso de Privacidade',
      sections: ['Aviso de Privacidade', 'Dados recolhidos'],
      textLength: 57_000,
    });
    expect(d.verdict).toBe('ok');
    expect(d.languages).toEqual(['pt']);
    expect(
      judgeDocument('privacy', { title: '', h1: '', sections: ['Aviso de Privacidade'], textLength: 57_000 }),
    ).toBe('ok');
  });

  it('a marker in a section heading far beyond the 20 000th character still counts', () => {
    const sections = Array.from({ length: 60 }, (_, i) => `Abschnitt ${i + 1}`);
    sections.push('Impressum');
    expect(
      judgeDocument('impressum', { title: 'Muster GmbH', h1: 'Über uns', sections, textLength: 80_000 }),
    ).toBe('ok');
  });

  it('a home page that mentions "Impressum" only in its footer text is unconfirmed', () => {
    const d = judgeDocumentDetail('impressum', {
      title: 'Muster GmbH – Startseite',
      h1: 'Willkommen',
      sections: ['Leistungen', 'Referenzen'],
      text: `${filler(4_000)} Impressum | Datenschutz | AGB`,
      textLength: 4_050,
    });
    expect(d.verdict).toBe('unconfirmed');
    expect(d.languages).toEqual([]);
  });

  it.each([
    ['fr', 'privacy', 'Politique de confidentialité'],
    ['es', 'privacy', 'Política de privacidad'],
    ['it', 'privacy', 'Informativa sulla privacy'],
    ['nl', 'privacy', 'Privacyverklaring'],
    ['da', 'privacy', 'Privatlivspolitik'],
    ['sv', 'privacy', 'Integritetspolicy'],
    ['fi', 'privacy', 'Tietosuojaseloste'],
    ['pl', 'privacy', 'Polityka prywatności'],
    ['fr', 'impressum', 'Mentions légales'],
    ['es', 'impressum', 'Aviso legal'],
  ] as const)('localised marker (%s, %s): "%s"', (lang, kind, heading) => {
    const d = judgeDocumentDetail(kind, { title: 'Firma', h1: heading, sections: [], textLength: 3_000 });
    expect(d.verdict).toBe('ok');
    expect(d.languages).toContain(lang);
  });

  it('German markers next to foreign ones: the languages list both', () => {
    const d = judgeDocumentDetail('privacy', {
      title: 'Datenschutzerklärung / Privacy Policy',
      h1: '',
      sections: [],
      textLength: 3_000,
    });
    expect(d.languages).toEqual(expect.arrayContaining(['de', 'en']));
  });
});

describe('judgeDocument: a marker in title, h1 or a heading decides; without one, the length', () => {
  const doc = (title: string, h1: string, textLength: number, sections: string[] = [], text?: string) => ({
    title,
    h1,
    sections,
    textLength,
    ...(text === undefined ? {} : { text }),
  });
  const footer = `Angaben gemäß § 5 DDG ${'Text. '.repeat(100)}`;
  const blog = doc('Blog', 'Neuigkeiten', 9_000, ['Ein Artikel über Steuern']);

  it.each([
    // German and English markers.
    ['a German title', 'privacy', 'ok', doc('Datenschutzerklärung', '', 900)],
    ['an English h1', 'privacy', 'ok', doc('x', 'Privacy Policy', 900)],
    ['title and h1', 'impressum', 'ok', doc('Impressum', 'Impressum', 600)],
    ['an English title', 'impressum', 'ok', doc('Legal Notice', '', 400)],
    ['the statutory phrase as a heading', 'impressum', 'ok', doc('x', '', 400, ['Angaben gemäß § 5 DDG'])],
    // In the body text alone the statutory phrase proves nothing (footer small print).
    ['the phrase only in the body text', 'impressum', 'unconfirmed', doc('Kontakt', '', 700, [], footer)],
    // A substantive page without a marker is neither found nor an error page.
    ['no marker on a long page', 'privacy', 'unconfirmed', doc('Start', 'Willkommen', 5_000)],
    ['an unrelated page', 'impressum', 'unconfirmed', blog],
    // Counterexamples: 404 markers on a short page, a long error template, a page without recognisable content.
    ['"Seite nicht gefunden" on a short page', 'privacy', 'soft-404', doc('Seite nicht gefunden', '', 1)],
    ['"Error 404" and "Not Found", short page', 'impressum', 'soft-404', doc('Error 404', 'Not Found', 300)],
    ['"Page introuvable" on a short page', 'privacy', 'soft-404', doc('Page introuvable', '', 200)],
    ['a long error template, 404 title', 'privacy', 'soft-404', doc('404 – Seite nicht gefunden', '', 6_000)],
    ['a nearly empty page without a marker', 'privacy', 'soft-404', doc('Start', '', 20)],
  ] as const)('%s (%s) → %s', (_what, kind, verdict, d) => {
    expect(judgeDocument(kind, d)).toBe(verdict);
  });
});

describe('documentLang: the markers decide, the lang attribute does not', () => {
  it('Portuguese markers with lang="en" → pt (PRIV-01 then reports language-unsupported)', () => {
    expect(documentLang('en', ['pt'])).toBe('pt');
    expect(documentLang(null, ['fr'])).toBe('fr');
  });

  it('German markers keep a de/en attribute and override a foreign one', () => {
    expect(documentLang('en', ['de'])).toBe('en');
    expect(documentLang('de-DE', ['de'])).toBe('de-de');
    expect(documentLang('pt', ['de'])).toBe('de');
    expect(documentLang(null, ['en'])).toBe('en');
  });

  it('without a decisive marker the attribute stays', () => {
    expect(documentLang('fr', [])).toBe('fr');
    expect(documentLang(null, [])).toBeNull();
  });

  it('both German and foreign markers: German/English win (the policy is evaluated)', () => {
    expect(documentLang('pt', ['pt', 'de'])).toBe('de');
  });
});
