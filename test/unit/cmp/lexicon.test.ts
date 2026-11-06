import { describe, expect, it } from 'vitest';
import {
  classifyButton,
  classifyLabel,
  isPaidLabel,
  labelTokens,
  lexiconFromData,
  normalizeLabel,
} from '../../../src/cmp/lexicon.ts';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import type { ButtonKind } from '../../../src/cmp/types.ts';
import { loadDataDir } from '../../../src/core/data/load.ts';

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
    for (const src of [
      ...(lexicon.purAbo ?? []),
      ...(lexicon.bannerKeywords ?? []),
      ...(lexicon.cookieKeywords ?? []),
    ]) {
      expect(() => new RegExp(src, 'iu')).not.toThrow();
    }
  });
});

describe('heuristic wording', () => {
  it('acknowledgements are accept phrases that only acknowledge a notice', () => {
    const accepts = new Set(lexicon.accept.map((p) => labelTokens(p).join(' ')));
    expect(lexicon.acknowledgements?.length).toBeGreaterThan(0);
    for (const phrase of lexicon.acknowledgements ?? []) {
      expect(accepts.has(labelTokens(phrase).join(' ')), phrase).toBe(true);
    }
    for (const consent of ['Akzeptieren', 'Zustimmen', 'Einverstanden', 'Accept all']) {
      expect(lexicon.acknowledgements?.map((p) => labelTokens(p).join(' '))).not.toContain(
        labelTokens(consent).join(' '),
      );
    }
  });

  it('cookie keywords are banner keywords that name cookies, not privacy or tracking in general', () => {
    const keywords = new Set(lexicon.bannerKeywords);
    expect(lexicon.cookieKeywords?.length).toBeGreaterThan(0);
    for (const k of lexicon.cookieKeywords ?? []) expect(keywords.has(k), k).toBe(true);
    const cookie = (text: string) =>
      (lexicon.cookieKeywords ?? []).some((k) => new RegExp(k, 'iu').test(text));
    expect(cookie('diese website verwendet cookies')).toBe(true);
    expect(cookie('hinweise zum datenschutz')).toBe(false);
    expect(cookie('lieferung mit sendungsverfolgung (tracking)')).toBe(false);
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

// A click on a decision button must do what its label says: no consent, subscription or purchase by mistake.
describe('classifyLabel: labels a click could turn into consent or a purchase', () => {
  const cases: Array<[label: string, kind: string | null, confidence: string]> = [
    // The reject of newer Shopware versions, also with an accept verb after the restriction.
    ['Nur technisch erforderliche', 'reject', 'high'],
    ['Nur technisch erforderliche Cookies', 'reject', 'high'],
    ['Nur technisch erforderliche Cookies akzeptieren', 'reject', 'high'],
    ['Nur technisch erforderliche Cookies zulassen', 'reject', 'high'],
    ['Nur technisch erforderliche Cookies erlauben', 'reject', 'high'],
    ['Nur technisch notwendige Cookies erlauben', 'reject', 'high'],
    // A negated consent is a refusal.
    ['I do not agree', 'reject', 'high'],
    ["I don't agree", 'reject', 'high'],
    ['I don’t agree', 'reject', 'high'],
    ['Do not accept', 'reject', 'high'],
    ["Don't accept", 'reject', 'high'],
    ['Nicht akzeptieren', 'reject', 'high'],
    ['Nicht zustimmen', 'reject', 'high'],
    ['Nicht einverstanden', 'reject', 'high'],
    ['Ich stimme nicht zu', 'reject', 'high'],
    ['Ich bin nicht einverstanden', 'reject', 'high'],
    ['Cookies nicht akzeptieren', 'reject', 'medium'],
    // A negation before the matched phrase, or a restriction outside it, leaves the meaning open: no decision.
    ['Nicht alle akzeptieren', null, 'low'],
    ['Weiter ohne Akzeptieren', null, 'low'],
    ['Never accept', null, 'low'],
    ['Cookies nie akzeptieren', null, 'low'],
    ['Nicht ablehnen', null, 'low'],
    ["Don't reject", null, 'low'],
    ['Keine optionalen Cookies akzeptieren', null, 'low'],
    ['Keine Tracking-Cookies erlauben', null, 'low'],
    ['Ich bin nicht damit einverstanden', null, 'low'],
    ['I do not want to accept', null, 'low'],
    ['Ne pas accepter', null, 'low'],
    ['No aceptar', null, 'low'],
    // A negation of a cookie category, or one after the decision phrase, does not negate the decision.
    ['Nicht notwendige Cookies ablehnen', 'reject', 'high'],
    ['Nicht essenzielle Cookies ablehnen', 'reject', 'high'],
    ['Reject non-essential cookies', 'reject', 'high'],
    ['Reject non-essential', 'reject', 'high'],
    ['Alle nicht notwendigen Cookies ablehnen', 'reject', 'medium'],
    ['Nicht technisch notwendige Cookies ablehnen', 'reject', 'medium'],
    ['Nicht erforderliche Cookies ablehnen', 'reject', 'medium'],
    ['Ablehnen (keine Statistik)', 'reject', 'medium'],
    ['Reject non-necessary cookies', 'reject', 'medium'],
    ['Refuser les cookies non essentiels', 'reject', 'medium'],
    ['Rechazar cookies no necesarias', 'reject', 'medium'],
    ['Niet-essentiële cookies weigeren', 'reject', 'medium'],
    ['Weigeren niet-noodzakelijke cookies', 'reject', 'medium'],
    ['Afvis ikke-nødvendige cookies', 'reject', 'medium'],
    ['Accept non-essential cookies', 'accept', 'medium'],
    ['Nur Statistik-Cookies akzeptieren', null, 'low'],
    ['Only accept analytics', null, 'low'],
    // Subscription and payment wording is never a reject or accept.
    ['Reject all and subscribe', null, 'low'],
    ['Ablehnen und abonnieren', null, 'low'],
    ['Ablehnen und Pur-Abo abschließen', null, 'low'],
    ['Akzeptieren oder Jahresabo', null, 'low'],
    ['Accept and pay', null, 'low'],
    ['Zustimmen und kaufen', null, 'low'],
    ['Ablehnen und bezahlen', null, 'low'],
    // Counterexamples: the negation or restriction is part of the phrase, or there is none.
    ['Weiter ohne Einwilligung', 'reject', 'high'],
    ['Continue without accepting', 'reject', 'high'],
    ['Nur notwendige Cookies akzeptieren', 'reject', 'high'],
    ['Accept only necessary cookies', 'reject', 'high'],
    ['Alle akzeptieren', 'accept', 'high'],
    ['Akzeptieren und weiter einkaufen', 'accept', 'medium'],
    ['Alle ablehnen', 'reject', 'high'],
  ];
  it.each(cases)('%s → %s (%s)', (label, kind, confidence) => {
    expect(classifyLabel(label, lexicon)).toMatchObject({ kind, confidence });
  });

  it('names why a decision phrase in the label is no decision', () => {
    expect(classifyLabel('Reject all and subscribe', lexicon).qualified).toEqual({
      kind: 'reject',
      by: 'paid',
    });
    expect(classifyLabel('Nicht alle akzeptieren', lexicon).qualified).toEqual({
      kind: 'accept',
      by: 'negation',
    });
    expect(classifyLabel('Nur Statistik akzeptieren', lexicon).qualified).toEqual({
      kind: 'accept',
      by: 'restriction',
    });
    expect(classifyLabel('Alle akzeptieren', lexicon).qualified).toBeUndefined();
    expect(classifyLabel('Abonnieren', lexicon).qualified).toBeUndefined();
  });

  it('subscription and payment wording is recognised on its own, also inside compounds', () => {
    for (const label of [
      'Abonnieren',
      'Subscribe',
      'Abo',
      'Pur-Abo',
      'Digitalabo',
      'Kaufen',
      'Bezahlen',
      'Pay',
    ]) {
      expect(isPaidLabel(label, lexicon), label).toBe(true);
    }
    for (const label of [
      'PayPal-Einstellungen',
      'Weiter einkaufen',
      'Alle akzeptieren',
      'Ablehnen',
      'Zahlungsarten',
    ]) {
      expect(isPaidLabel(label, lexicon), label).toBe(false);
    }
  });
});

describe('classifyButton: the vendor role cannot turn a qualified label into a decision', () => {
  const cases: Array<
    [name: string, role: string, vendorRole: ButtonKind | null, kind: ButtonKind, confidence: string]
  > = [
    ['Ablehnen und abonnieren', 'button', 'reject', 'other', 'low'],
    ['Jetzt abonnieren', 'button', 'accept', 'other', 'low'],
    ['Pur-Abo abschließen', 'link', 'reject', 'link', 'high'],
    ['Nicht alle akzeptieren', 'button', 'accept', 'other', 'low'],
    ['Nur Statistik akzeptieren', 'button', 'accept', 'other', 'low'],
    ['Nicht ablehnen', 'button', 'reject', 'other', 'low'],
    // A restricted or negated accept on the vendor's reject markup is that reject.
    ['Nur technisch benötigte Cookies akzeptieren', 'button', 'reject', 'reject', 'medium'],
    ['Cookies nie akzeptieren', 'button', 'reject', 'reject', 'medium'],
    // A reject that negates a cookie category is the vendor's reject.
    ['Reject non-essential cookies', 'button', 'reject', 'reject', 'high'],
    ['Alle nicht notwendigen Cookies ablehnen', 'button', 'reject', 'reject', 'high'],
    ['Rechazar cookies no necesarias', 'button', 'reject', 'reject', 'high'],
    // Counterexample: an unqualified label with the vendor role.
    ['Weiter', 'button', 'reject', 'reject', 'medium'],
  ];
  it.each(cases)('%s (%s, vendor %s) → %s (%s)', (name, role, vendorRole, kind, kindConfidence) => {
    expect(classifyButton({ name, role, vendorRole }, lexicon)).toEqual({ kind, kindConfidence });
  });
});

describe('lexicon qualifiers', () => {
  it('lists negations, category words, restrictions and payment wording, none of them a decision phrase', () => {
    const decisions = new Set([...lexicon.accept, ...lexicon.reject].map((p) => labelTokens(p).join(' ')));
    for (const key of ['negations', 'necessity', 'restrictions', 'paid'] as const) {
      const list = lexicon[key] ?? [];
      expect(list.length, key).toBeGreaterThan(0);
      for (const word of list)
        expect(decisions.has(labelTokens(word).join(' ')), `${key}: ${word}`).toBe(false);
    }
  });

  it('a lexicon without them is malformed', () => {
    const { paid: _paid, ...withoutPaid } = lexicon;
    expect(() => lexiconFromData(withoutPaid)).toThrow(/lexicon: paid/);
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
