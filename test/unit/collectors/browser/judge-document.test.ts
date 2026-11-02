/**
 * Pure: the verdict on a fetched page. The document type is decided by the title, the h1 and the section
 * headings of the whole document with localised markers from data/legal/links.yaml, not by one keyword in the
 * first 20 000 characters. A substantive page without a marker is `unconfirmed` (neither soft-404 nor found); the
 * language of the markers is recorded for PRIV-01 (the lang attribute alone does not decide).
 */
import { describe, expect, it } from 'vitest';
import {
  documentLang,
  judgeDocument,
  judgeDocumentDetail,
} from '../../../../src/collectors/browser/documents.ts';

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

  it('a substantive page without any marker is unconfirmed, not soft-404 and not found', () => {
    expect(
      judgeDocument('privacy', { title: 'Start', h1: 'Willkommen', sections: [], textLength: 5_000 }),
    ).toBe('unconfirmed');
  });

  it('German and English markers (title, h1 or heading)', () => {
    expect(
      judgeDocument('privacy', { title: 'Datenschutzerklärung', h1: '', sections: [], textLength: 900 }),
    ).toBe('ok');
    expect(
      judgeDocument('privacy', { title: 'x', h1: 'Privacy Policy', sections: [], textLength: 900 }),
    ).toBe('ok');
    expect(
      judgeDocument('impressum', {
        title: 'x',
        h1: '',
        sections: ['Angaben gemäß § 5 DDG'],
        textLength: 400,
      }),
    ).toBe('ok');
    expect(judgeDocument('impressum', { title: 'Legal Notice', h1: '', sections: [], textLength: 400 })).toBe(
      'ok',
    );
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

describe('judgeDocument: counterexamples', () => {
  it('a short page with 404 markers is soft-404', () => {
    expect(
      judgeDocument('privacy', { title: 'Seite nicht gefunden', h1: '', sections: [], textLength: 1 }),
    ).toBe('soft-404');
    expect(
      judgeDocument('impressum', { title: 'Error 404', h1: 'Not Found', sections: [], textLength: 300 }),
    ).toBe('soft-404');
    expect(
      judgeDocument('privacy', { title: 'Page introuvable', h1: '', sections: [], textLength: 200 }),
    ).toBe('soft-404');
  });

  it('a nearly empty page without a marker is soft-404 (no recognisable content)', () => {
    expect(judgeDocument('privacy', { title: 'Start', h1: '', sections: [], textLength: 20 })).toBe(
      'soft-404',
    );
  });

  it('a long error template with a 404 title is still soft-404', () => {
    expect(
      judgeDocument('privacy', {
        title: '404 – Seite nicht gefunden',
        h1: '',
        sections: [],
        textLength: 6_000,
      }),
    ).toBe('soft-404');
  });

  it('an unrelated page is never "ok"', () => {
    expect(
      judgeDocument('impressum', {
        title: 'Blog',
        h1: 'Neuigkeiten',
        sections: ['Ein Artikel über Steuern'],
        textLength: 9_000,
      }),
    ).not.toBe('ok');
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
