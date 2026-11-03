import { describe, expect, it } from 'vitest';
import {
  classifyButton,
  classifyLabel,
  labelTokens,
  lexiconFromData,
  normalizeLabel,
} from '../../../src/cmp/lexicon.ts';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import { loadDataDir } from '../../../src/core/data.ts';

const lexicon = loadLexicon();

describe('test/data/cmp/lexicon.yaml', () => {
  it('loads through the generic data loader (ctx.data.cmp for checks)', () => {
    const fromData = lexiconFromData(loadDataDir('cmp'));
    expect(fromData).toEqual(lexicon);
    expect(lexicon.version).toMatch(/^\d{4}\.\d+\.\d+$/);
  });

  it('accepts the bare lexicon object as well', () => {
    expect(lexiconFromData(lexicon)).toEqual(lexicon);
  });

  it('rejects malformed data', () => {
    expect(() => lexiconFromData({ lexicon: { version: '1', reject: 'ablehnen' } })).toThrow(/lexicon/);
  });

  it('has no phrase in two kinds', () => {
    const seen = new Map<string, string>();
    for (const kind of ['accept', 'reject', 'settings', 'save', 'close', 'later', 'hide'] as const) {
      for (const phrase of lexicon[kind]) {
        const key = phrase.startsWith('*') ? phrase : labelTokens(phrase).join(' ');
        expect(seen.get(key), `${phrase} in ${kind} and ${seen.get(key)}`).toBeUndefined();
        seen.set(key, kind);
      }
    }
  });

  it('every regex source compiles', () => {
    for (const src of [...(lexicon.purAbo ?? []), ...(lexicon.bannerKeywords ?? [])]) {
      expect(() => new RegExp(src, 'iu')).not.toThrow();
    }
  });
});

describe('normalizeLabel / labelTokens', () => {
  it('normalizes case, whitespace and close glyphs', () => {
    expect(normalizeLabel('  Alle ABLEHNEN \n')).toBe('alle ablehnen');
    expect(normalizeLabel('✕')).toBe('×');
    expect(labelTokens('Cookie-Einstellungen')).toEqual(['cookie', 'einstellungen']);
    expect(labelTokens('Akzeptieren & schließen!')).toEqual(['akzeptieren', 'schließen']);
    expect(labelTokens('✖')).toEqual(['×']);
  });
});

describe('classifyLabel: lexicon de/en', () => {
  const cases: Array<[string, string | null, string]> = [
    ['Ablehnen', 'reject', 'high'],
    ['Alle ablehnen', 'reject', 'high'],
    ['Nur notwendige Cookies', 'reject', 'high'],
    ['Nur essenzielle Cookies akzeptieren', 'reject', 'high'],
    ['Nur technisch notwendige Cookies', 'reject', 'high'],
    ['Weiter ohne Einwilligung', 'reject', 'high'],
    ['Reject all', 'reject', 'high'],
    ['Alle akzeptieren', 'accept', 'high'],
    ['Zustimmen', 'accept', 'high'],
    ['Akzeptieren', 'accept', 'high'],
    ['Einverstanden', 'accept', 'high'],
    ['Accept all cookies', 'accept', 'high'],
    ['Einstellungen', 'settings', 'high'],
    ['Mehr Optionen', 'settings', 'high'],
    ['Individuelle Einstellungen', 'settings', 'high'],
    ['Individuelle Datenschutzeinstellungen', 'settings', 'high'],
    ['Auswahl speichern', 'save', 'high'],
    ['Verbergen', 'hide', 'high'],
    ['Schließen', 'close', 'high'],
    ['×', 'close', 'high'],
    ['X', 'close', 'high'],
    ['Später', 'later', 'high'],
  ];
  it.each(cases)('%s → %s (%s)', (label, kind, confidence) => {
    const r = classifyLabel(label, lexicon);
    expect(r.kind).toBe(kind);
    expect(r.confidence).toBe(confidence);
  });

  it('a phrase inside a longer label gives medium confidence', () => {
    expect(classifyLabel('Cookies jetzt ablehnen', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'medium',
    });
    expect(classifyLabel('Privatsphäre-Center: Cookieeinstellungen', lexicon)).toMatchObject({
      kind: 'settings',
      confidence: 'medium',
    });
  });

  it('the longest phrase wins: "Nur notwendige Cookies akzeptieren" is a reject, not an accept', () => {
    expect(classifyLabel('Nur notwendige Cookies akzeptieren', lexicon).kind).toBe('reject');
    expect(classifyLabel('Nicht einverstanden', lexicon).kind).toBe('reject');
    expect(classifyLabel('Ich stimme nicht zu', lexicon).kind).toBe('reject');
  });

  it('counterexamples: Verbergen, ×, Später, Einstellungen are never a reject', () => {
    for (const label of [
      'Verbergen',
      '×',
      '✕',
      'Schließen',
      'Später',
      'Einstellungen',
      'Banner ausblenden',
    ]) {
      expect(classifyLabel(label, lexicon).kind, label).not.toBe('reject');
    }
  });

  it('word boundaries: "ok" does not match inside "Cookies"', () => {
    expect(classifyLabel('Cookies', lexicon).kind).toBeNull();
    expect(classifyLabel('Datenschutzerklärung', lexicon).kind).toBeNull();
  });

  it('a tie between two kinds stays unclassified', () => {
    expect(classifyLabel('Einstellungen oder ablehnen', lexicon)).toMatchObject({
      kind: null,
      confidence: 'low',
    });
    expect(classifyLabel('Akzeptieren oder ablehnen', lexicon)).toMatchObject({ kind: null });
    expect(classifyLabel('Speichern oder ablehnen', lexicon)).toMatchObject({ kind: null });
  });

  // a decision combined with closing ("… und schließen") is the decision, not an unclassified button.
  it('"Ablehnen und schließen" / "Ablehnen und weiter" are rejects (lexicon phrases → high)', () => {
    expect(classifyLabel('Ablehnen und schließen', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'high',
    });
    expect(classifyLabel('Ablehnen und weiter', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'high',
    });
    expect(classifyLabel('Alle ablehnen und schließen', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'high',
    });
  });

  it('a tie of reject/accept with close/hide/later goes to the decision (medium)', () => {
    expect(classifyLabel('Ablehnen und verbergen', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'medium',
    });
    expect(classifyLabel('Schließen und ablehnen', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'medium',
    });
    expect(classifyLabel('Zustimmen und schließen', lexicon)).toMatchObject({
      kind: 'accept',
      confidence: 'medium',
    });
    expect(classifyLabel('Ablehnen (später ändern)', lexicon)).toMatchObject({
      kind: 'reject',
      confidence: 'medium',
    });
  });
});

// "save the selection" phrased with accept/allow verbs is a save button, not "accept all".
describe('classifyLabel: save-selection phrasing', () => {
  const saves = [
    'Ausgewählte Cookies akzeptieren',
    'Ausgewählte akzeptieren',
    'Ausgewählte Cookies erlauben',
    'Ausgewählte Cookies zulassen',
    'Accept selected',
  ];
  it.each(saves)('%s → save', (label) => {
    const r = classifyLabel(label, lexicon);
    expect(r.kind).toBe('save');
    expect(r.confidence).toBe('high');
  });

  it('with the vendor role "save" the button stays a save with high confidence', () => {
    expect(
      classifyButton(
        { name: 'Ausgewählte Cookies akzeptieren', role: 'button', vendorRole: 'save' },
        lexicon,
      ),
    ).toEqual({ kind: 'save', kindConfidence: 'high' });
  });

  it('counterexamples: "all" phrasing stays accept', () => {
    for (const label of [
      'Alle Cookies akzeptieren',
      'Cookies akzeptieren',
      'Alle akzeptieren',
      'Accept all',
    ]) {
      expect(classifyLabel(label, lexicon).kind, label).toBe('accept');
    }
  });
});

// the generic heuristic and the button kinds must also work for non-de/en banners (facts only, info).
describe('classifyLabel: further languages', () => {
  const cases: Array<[string, string]> = [
    ['Hylkää kaikki', 'reject'],
    ['Hyväksy kaikki', 'accept'],
    ['Evästeasetukset', 'settings'],
    ['Avvisa alla', 'reject'],
    ['Acceptera alla', 'accept'],
    ['Inställningar', 'settings'],
    ['Rechazar todo', 'reject'],
    ['Aceptar todas', 'accept'],
    ['Configurar', 'settings'],
    ['Rejeitar tudo', 'reject'],
    ['Aceitar tudo', 'accept'],
    ['Tout refuser', 'reject'],
    ['Tout accepter', 'accept'],
    ['Personnaliser', 'settings'],
    ['Rifiuta tutti', 'reject'],
    ['Accetta tutti', 'accept'],
    ['Personalizza', 'settings'],
    ['Alles weigeren', 'reject'],
    ['Alles accepteren', 'accept'],
    ['Voorkeuren', 'settings'],
    ['Afvis alle', 'reject'],
    ['Accepter alle', 'accept'],
    ['Avvis alle', 'reject'],
    ['Godta alle', 'accept'],
    ['Hafna öllu', 'reject'],
    ['Samþykkja allt', 'accept'],
    ['Odrzuć wszystkie', 'reject'],
    ['Zaakceptuj wszystkie', 'accept'],
  ];
  it.each(cases)('%s → %s', (label, kind) => {
    expect(classifyLabel(label, lexicon).kind).toBe(kind);
  });

  it('the version of the lexicon is raised with the data', () => {
    expect(lexicon.version).not.toBe('2026.10.1');
  });
});

describe('classifyButton: label, role and vendor role', () => {
  it('label and vendor role agree → high', () => {
    expect(
      classifyButton({ name: 'Cookies ablehnen', role: 'button', vendorRole: 'reject' }, lexicon),
    ).toEqual({
      kind: 'reject',
      kindConfidence: 'high',
    });
  });

  it('the label wins over a conflicting vendor role ("Verbergen" on the decline button), with medium confidence', () => {
    expect(classifyButton({ name: 'Verbergen', role: 'button', vendorRole: 'reject' }, lexicon)).toEqual({
      kind: 'hide',
      kindConfidence: 'medium',
    });
  });

  it('unknown label falls back to the vendor role with medium confidence', () => {
    expect(classifyButton({ name: 'Weiter', role: 'button', vendorRole: 'reject' }, lexicon)).toEqual({
      kind: 'reject',
      kindConfidence: 'medium',
    });
  });

  it('a link without a lexicon label is a plain link; an unknown button is "other"', () => {
    expect(classifyButton({ name: 'Datenschutzerklärung', role: 'link' }, lexicon)).toEqual({
      kind: 'link',
      kindConfidence: 'high',
    });
    expect(classifyButton({ name: 'Weiter', role: 'button' }, lexicon)).toEqual({
      kind: 'other',
      kindConfidence: 'low',
    });
  });

  it('a reject rendered as a link keeps kind reject (role tells it is a link)', () => {
    expect(classifyButton({ name: 'Ablehnen', role: 'link' }, lexicon)).toEqual({
      kind: 'reject',
      kindConfidence: 'high',
    });
  });
});
