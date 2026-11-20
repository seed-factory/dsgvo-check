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

/** A table of labels and the kind and confidence each is classified as. */
const labelTable = (cases: Array<[label: string, kind: string | null, confidence: string]>) =>
  it.each(cases)('%s → %s (%s)', (label, kind, confidence) => {
    expect(classifyLabel(label, lexicon)).toMatchObject({ kind, confidence });
  });

type ButtonCase = [
  name: string,
  role: string,
  vendorRole: ButtonKind | null,
  kind: ButtonKind,
  confidence: string,
];
const buttonTable = (cases: ButtonCase[]) =>
  it.each(cases)('%s (%s, vendor %s) → %s (%s)', (name, role, vendorRole, kind, kindConfidence) => {
    expect(classifyButton({ name, role, vendorRole }, lexicon)).toEqual({ kind, kindConfidence });
  });

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
  labelTable([
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
    ['Ich akzeptiere', 'accept', 'high'],
    ['Ich akzeptiere alle', 'accept', 'medium'],
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
    // A phrase inside a longer label gives medium confidence.
    ['Cookies jetzt ablehnen', 'reject', 'medium'],
    ['Privatsphäre-Center: Cookieeinstellungen', 'settings', 'medium'],
    // Counterexamples: a close glyph and a hide phrase are never a reject.
    ['✕', 'close', 'high'],
    ['Banner ausblenden', 'hide', 'high'],
    // Word boundaries: "ok" does not match inside "Cookies".
    ['Cookies', null, 'low'],
    ['Datenschutzerklärung', null, 'low'],
    // A tie between two kinds stays unclassified.
    ['Einstellungen oder ablehnen', null, 'low'],
    ['Akzeptieren oder ablehnen', null, 'low'],
    ['Speichern oder ablehnen', null, 'low'],
    // A decision combined with closing ("… und schließen") is the decision, not an unclassified button.
    ['Ablehnen und schließen', 'reject', 'high'],
    ['Ablehnen und weiter', 'reject', 'high'],
    ['Alle ablehnen und schließen', 'reject', 'high'],
    // A tie of reject/accept with close/hide/later goes to the decision (medium).
    ['Ablehnen und verbergen', 'reject', 'medium'],
    ['Schließen und ablehnen', 'reject', 'medium'],
    ['Zustimmen und schließen', 'accept', 'medium'],
    ['Ablehnen (später ändern)', 'reject', 'medium'],
  ]);

  it.each([
    ['Ablehnen und Fenster schließen', 'reject', 'medium'],
    ['Deny and close banner', 'reject', 'medium'],
    ['Akzeptieren und Fenster schließen', 'accept', 'medium'],
    ['Chiudi senza accettare', 'reject', 'high'],
    ['Disagree and close', 'reject', 'high'],
    ['Disagree', 'reject', 'high'],
    // Counterexamples: no decision beside the close phrase, or two of them.
    ['Fenster schließen', 'close', 'high'],
    ['Einstellungen und Banner schließen', 'close', 'medium'],
    ['Akzeptieren oder ablehnen und Fenster schließen', null, 'low'],
  ])('a decision beside a longer close phrase is the decision: %s → %s (%s)', (label, kind, confidence) => {
    expect(classifyLabel(label, lexicon)).toMatchObject({ kind, confidence });
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
  const byLocale = [
    { reject: 'Hylkää kaikki', accept: 'Hyväksy kaikki', settings: 'Evästeasetukset' },
    { reject: 'Avvisa alla', accept: 'Acceptera alla', settings: 'Inställningar' },
    { reject: 'Rechazar todo', accept: 'Aceptar todas', settings: 'Configurar' },
    { reject: 'Rejeitar tudo', accept: 'Aceitar tudo' },
    { reject: 'Tout refuser', accept: 'Tout accepter', settings: 'Personnaliser' },
    { reject: 'Rifiuta tutti', accept: 'Accetta tutti', settings: 'Personalizza' },
    { reject: 'Alles weigeren', accept: 'Alles accepteren', settings: 'Voorkeuren' },
    { reject: 'Afvis alle', accept: 'Accepter alle' },
    { reject: 'Avvis alle', accept: 'Godta alle' },
    { reject: 'Hafna öllu', accept: 'Samþykkja allt' },
    { reject: 'Odrzuć wszystkie', accept: 'Zaakceptuj wszystkie' },
  ];
  // Continue without consent, the reject of Real Cookie Banner.
  const continueWithoutConsent = [
    'Continuer sans consentement',
    'Continuar sin consentimiento',
    'Continua senza consenso',
    'Continuar sem consentimento',
    'Doorgaan zonder toestemming',
    'Fortsæt uden samtykke',
    'Fortsett uten samtykke',
    'Fortsätt utan samtycke',
    'Jatka ilman suostumusta',
    'Kontynuuj bez zgody',
  ];
  const cases = [
    ...byLocale.flatMap((labels) => Object.entries(labels).map(([kind, label]) => [label, kind] as const)),
    ...continueWithoutConsent.map((label) => [label, 'reject'] as const),
  ];
  it.each(cases)('%s → %s', (label, kind) => {
    expect(classifyLabel(label, lexicon).kind).toBe(kind);
  });
});

// A click on a decision button must do what its label says: no consent, subscription or purchase by mistake.
describe('classifyLabel: labels a click could turn into consent or a purchase', () => {
  labelTable([
    // The reject of newer Shopware versions, also with an accept verb after the restriction.
    ['Nur technisch erforderliche', 'reject', 'high'],
    ['Nur technisch erforderliche Cookies', 'reject', 'high'],
    ['Nur technisch erforderliche Cookies akzeptieren', 'reject', 'high'],
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
    ['Keine Cookies akzeptieren', 'reject', 'high'],
    ['Accept no cookies', 'reject', 'high'],
    ['No cookies', 'reject', 'high'],
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
    // After an accept phrase, a negation that starts no cookie category negates the consent: no decision.
    ['Ich akzeptiere keine Cookies', null, 'low'],
    ['Ich akzeptiere keine optionalen Cookies', null, 'low'],
    ['Ich akzeptiere die Cookies nicht', null, 'low'],
    ['Accept no tracking cookies', null, 'low'],
    // Counterexamples: a negation in a clause of its own after the accept phrase does not negate it.
    ['Akzeptieren und nicht mehr anzeigen', 'accept', 'medium'],
    ["Accept and don't show again", 'accept', 'medium'],
    // A negation of a cookie category, or one after a reject phrase, does not negate the decision.
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
    ['Continue without accepting', 'reject', 'high'],
    ['Nur notwendige Cookies akzeptieren', 'reject', 'high'],
    ['Accept only necessary cookies', 'reject', 'high'],
    ['Akzeptieren und weiter einkaufen', 'accept', 'medium'],
  ]);

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

// "nicht notwendige" is one adjective (the optional cookies): a phrase that ends on its negation or starts on its
// necessity word reads only half of it.
describe('classifyLabel: a negated cookie category is read as a whole', () => {
  labelTable([
    // Consent to the optional cookies, although a reject phrase ends with the negation.
    ['Ich akzeptiere nicht notwendige Cookies', 'accept', 'medium'],
    ['Ich akzeptiere nicht erforderliche Cookies', 'accept', 'medium'],
    ['Ich akzeptiere nicht essenzielle Cookies', 'accept', 'medium'],
    ['Ich akzeptiere nicht technisch notwendige Cookies', 'accept', 'medium'],
    // Consent to the optional cookies, although a reject phrase starts with the necessity word.
    ['Nicht notwendige Cookies akzeptieren', 'accept', 'medium'],
    ['Nicht erforderliche Cookies erlauben', 'accept', 'medium'],
    ['Nicht technisch notwendige Cookies zulassen', 'accept', 'medium'],
    ['Niet-noodzakelijke cookies accepteren', 'accept', 'medium'],
    ['Mit nicht notwendigen Cookies einverstanden', 'accept', 'medium'],
    ['Ich stimme nicht notwendigen Cookies zu', null, 'low'],
    ['Acceptera icke-nödvändiga cookies', 'accept', 'medium'],
    ['Godkänn icke nödvändiga kakor', 'accept', 'medium'],
    ['Godkänn ej nödvändiga cookies', 'accept', 'medium'],
    ['Akceptuj pliki cookie inne niż niezbędne', 'accept', 'medium'],
    // Counterexamples: the negation belongs to the decision, a negated category after the phrase stands on its own.
    ['Ich akzeptiere nicht', 'reject', 'high'],
    ['Do not accept non-essential cookies', 'reject', 'medium'],
    ["Don't accept non-essential cookies", 'reject', 'medium'],
    ['I do not accept non-essential cookies', 'reject', 'medium'],
    ['Nicht notwendige Cookies nicht akzeptieren', 'reject', 'medium'],
  ]);

  it('a vendor reject role cannot make half of a negated category a reject', () => {
    const negations = (lexicon.negations ?? []).map(labelTokens);
    const endsWithNegation = (tokens: string[]) =>
      negations.some(
        (n) => n.length <= tokens.length && n.every((t, j) => tokens[tokens.length - n.length + j] === t),
      );
    const phrases = lexicon.reject.filter((p) => endsWithNegation(labelTokens(p)));
    expect(phrases.length).toBeGreaterThan(0);
    for (const phrase of phrases) {
      const name = `${phrase} notwendige Cookies`;
      expect(classifyLabel(name, lexicon).kind, name).not.toBe('reject');
      expect(classifyButton({ name, role: 'button', vendorRole: 'reject' }, lexicon).kind, name).not.toBe(
        'reject',
      );
    }
  });

  it('a vendor role cannot turn half of a negated category into a reject when no other phrase decides', () => {
    const name = 'Ich akzeptiere nicht notwendige Cookies';
    const lone = {
      ...lexicon,
      version: 'test',
      accept: lexicon.accept.filter((p) => p !== 'ich akzeptiere'),
    };
    expect(classifyLabel(name, lone).kind).toBeNull();
    expect(classifyButton({ name, role: 'button', vendorRole: 'reject' }, lone)).toEqual({
      kind: 'other',
      kindConfidence: 'low',
    });
  });
});

// Punctuation ends a clause: a negation in a clause of its own neither negates the decision of the next one ("No,
// reject all") nor its object ("Akzeptieren, nicht mehr anzeigen"), and a phrase does not reach across it.
describe('classifyLabel: punctuation ends a clause', () => {
  labelTable([
    // An answer before the decision.
    ['No, reject all', 'reject', 'medium'],
    ['Non, tout refuser', 'reject', 'medium'],
    ['No, rifiuta tutti', 'reject', 'medium'],
    ['Nie, odrzuć wszystkie', 'reject', 'medium'],
    ['Não, rejeitar todos', 'reject', 'medium'],
    ['Kein Tracking – Ablehnen', 'reject', 'medium'],
    ['Ohne Tracking: alle ablehnen', 'reject', 'medium'],
    ['Kein Tracking, nur notwendige Cookies', 'reject', 'medium'],
    ['No, necessary cookies only', 'reject', 'medium'],
    // A clause of its own after the consent.
    ['Ich akzeptiere – nicht mehr anzeigen', 'accept', 'medium'],
    ['Ich akzeptiere, nicht mehr fragen', 'accept', 'medium'],
    ['Ich akzeptiere. Nicht erneut fragen', 'accept', 'medium'],
    ['Ich akzeptiere (nicht empfohlen)', 'accept', 'medium'],
    ['Akzeptieren & nicht mehr anzeigen', 'accept', 'medium'],
    ['Alle akzeptieren - nicht mehr anzeigen', 'accept', 'medium'],
    ['OK, nicht mehr anzeigen', 'accept', 'medium'],
    ["Accept all & don't ask again", 'accept', 'medium'],
    ["Accept, don't show again", 'accept', 'medium'],
    // Counterexamples: the negation stands in the clause of the phrase, or the label is the phrase.
    ['No, I do not agree', 'reject', 'medium'],
    ["No, I don't accept", 'reject', 'medium'],
    ['Ich akzeptiere nicht, danke', 'reject', 'medium'],
    ['Ich akzeptiere die Cookies nicht.', null, 'low'],
    ['Nicht alle akzeptieren!', null, 'low'],
    ['OK, verstanden', 'accept', 'high'],
    ['Ei, kiitos', 'reject', 'high'],
  ]);

  it.each([
    ['No, reject all', 'reject'],
    ['Ich akzeptiere – nicht mehr anzeigen', 'accept'],
  ] as const)(
    'the vendor role decides a label whose decision a clause of its own does not qualify: %s (vendor %s)',
    (name, vendorRole) => {
      expect(classifyButton({ name, role: 'button', vendorRole }, lexicon)).toEqual({
        kind: vendorRole,
        kindConfidence: 'high',
      });
    },
  );
});

// A bracketed insertion ends the clause for phrases, but not the negation of the consent it interrupts or opens: "Nicht
// (alle Cookies) akzeptieren" is "Nicht alle Cookies akzeptieren".
describe('classifyLabel: a negation reaches a consent across a bracketed insertion', () => {
  const negated = [
    'Nicht (alle Cookies) akzeptieren',
    'Nicht [alle Cookies] akzeptieren',
    'Nicht (alle (auch Statistik)) akzeptieren',
    'Keine (optionalen) Cookies akzeptieren',
    'I do not (want to) accept',
    'Nicht (allen) zustimmen',
    'Do not (accept all cookies)',
    // A negation after the consent reaches it across an insertion as well: at the end of its clause, or before a word
    // for all cookies in the insertion it opens or after it.
    'Ich akzeptiere (die Cookies) nicht',
    'Ich akzeptiere optionale Cookies (z. B. Statistik) nicht',
    'Ich akzeptiere nicht (alle Cookies)',
    'Ich akzeptiere nicht (leider) alle Cookies',
  ];
  it.each(negated)('%s is a negated accept without a decision', (name) => {
    expect(classifyLabel(name, lexicon)).toMatchObject({ kind: null, confidence: 'low' });
  });

  // A negation directly before an insertion reaches the reject phrase directly after it.
  it.each(['Nicht (alle Cookies) ablehnen', 'Nicht [alle] ablehnen', 'Keine (optionalen) Cookies ablehnen'])(
    '%s is a negated reject without a decision',
    (name) => {
      expect(classifyLabel(name, lexicon)).toMatchObject({ kind: null, confidence: 'low' });
    },
  );

  it('vendor reject can resolve a negated accept across brackets, while negated reject blocks either role', () => {
    const vendor = (name: string, vendorRole: 'accept' | 'reject') =>
      classifyButton({ name, role: 'button', vendorRole }, lexicon);
    const negatedAccept = 'Nicht (alle Cookies) akzeptieren';
    const negatedReject = 'Nicht (alle Cookies) ablehnen';
    expect(vendor(negatedAccept, 'reject')).toEqual({ kind: 'reject', kindConfidence: 'medium' });
    expect(vendor(negatedAccept, 'accept')).toEqual({ kind: 'other', kindConfidence: 'low' });
    expect(vendor(negatedReject, 'reject')).toEqual({ kind: 'other', kindConfidence: 'low' });
    expect(vendor(negatedReject, 'accept')).toEqual({ kind: 'other', kindConfidence: 'low' });
  });

  labelTable([
    // Counterexamples: a negation inside the insertion, or after it, or in a clause of its own, does not negate.
    ['OK (nicht empfohlen)', 'accept', 'medium'],
    ['Ich akzeptiere (empfohlen) nicht mehr fragen', 'accept', 'medium'],
    ['Ich akzeptiere (die Cookies) nicht mehr fragen', 'accept', 'medium'],
    ['Akzeptieren (alle Cookies), nicht mehr anzeigen', 'accept', 'medium'],
    ['Nicht jetzt (alle akzeptieren)', 'accept', 'medium'],
    ['Kein Problem (alle akzeptieren)', 'accept', 'medium'],
    ['Nein, (alle) akzeptieren', 'accept', 'medium'],
    ['(Empfohlen) Alle akzeptieren', 'accept', 'medium'],
    // Counterexamples: an insertion beside an unnegated consent.
    ['Alle akzeptieren (empfohlen)', 'accept', 'medium'],
    ['Akzeptieren (alle Cookies) und weiter', 'accept', 'medium'],
    ['Alle akzeptieren (Statistik und Marketing)', 'accept', 'medium'],
    // Counterexamples: a reject stays a reject around an insertion.
    ['Kein Tracking (nur notwendige Cookies)', 'reject', 'medium'],
    ['Nicht zustimmen (nur notwendige)', 'reject', 'medium'],
    ['No (reject all)', 'reject', 'medium'],
    ['Nein danke (alle ablehnen)', 'reject', 'medium'],
    ['Kein Tracking (Statistik) – alle ablehnen', 'reject', 'medium'],
    ['Ohne Tracking (empfohlen): alle ablehnen', 'reject', 'medium'],
    ['Kein Tracking (empfohlen) alle ablehnen', 'reject', 'medium'],
    ['Nicht (technisch) notwendige Cookies ablehnen', 'reject', 'medium'],
    ['Ich akzeptiere nicht (empfohlen)', 'reject', 'medium'],
    ['I do not accept (cookies from all partners)', 'reject', 'medium'],
    ['Optionale Cookies (Statistik, Marketing) ablehnen', 'reject', 'medium'],
    ['Nicht (akzeptieren)', 'reject', 'high'],
    ['Ablehnen)', 'reject', 'high'],
    ['Ablehnen (nicht empfohlen', 'reject', 'medium'],
    // Counterexample: without a decision phrase the label stays no decision.
    ['Nicht (mehr) anzeigen', null, 'low'],
  ]);
});

// "Not all" is consent to part of the cookies, however the negation is placed.
describe('classifyLabel: a negated consent to all cookies is no decision', () => {
  labelTable([
    ['Ich akzeptiere nicht alle Cookies', null, 'low'],
    ['Do not accept all', null, 'low'],
    ['Do not accept all cookies', null, 'low'],
    ["I don't accept all cookies", null, 'low'],
    ["I don't agree to all", null, 'low'],
    ['Nie zgadzam się na wszystkie', null, 'low'],
    // Counterexamples: the negation refuses the cookies, "all" only stresses it.
    ['Accept no cookies at all', 'reject', 'medium'],
    ['No cookies at all', 'reject', 'medium'],
    ['I do not accept cookies from all partners', 'reject', 'medium'],
  ]);

  it('reads like "Nicht alle akzeptieren": a negated accept, the vendor role decides only as reject or settings', () => {
    const name = 'Ich akzeptiere nicht alle Cookies';
    const vendor = (vendorRole: ButtonKind) => classifyButton({ name, role: 'button', vendorRole }, lexicon);
    expect(vendor('reject')).toEqual({ kind: 'reject', kindConfidence: 'medium' });
    expect(vendor('settings')).toEqual({ kind: 'settings', kindConfidence: 'medium' });
    expect(vendor('accept')).toEqual({ kind: 'other', kindConfidence: 'low' });
  });
});

// Consent to the necessary cookies alone refuses all others, also without "nur" or "only".
describe('classifyLabel: an accept of the necessary cookies only', () => {
  labelTable([
    ['Notwendige Cookies akzeptieren', 'reject', 'high'],
    ['Erforderliche Cookies erlauben', 'reject', 'high'],
    ['Essenzielle Cookies akzeptieren', 'reject', 'high'],
    ['Essentielle Cookies erlauben', 'reject', 'high'],
    ['Technisch notwendige Cookies akzeptieren', 'reject', 'high'],
    ['Technisch erforderliche Cookies zulassen', 'reject', 'high'],
    ['Accept necessary', 'reject', 'high'],
    ['Accept necessary cookies', 'reject', 'high'],
    ['Accept required cookies', 'reject', 'high'],
    ['Accept essential cookies', 'reject', 'high'],
    ['Allow essential cookies', 'reject', 'high'],
    ['Use necessary cookies', 'reject', 'high'],
    // Without a phrase of its own, a necessity word outside the accept phrase still makes it no accept.
    ['Accept strictly necessary cookies', null, 'low'],
    ['Alle notwendigen Cookies akzeptieren', null, 'low'],
    ['Accept all necessary cookies', null, 'low'],
    ['Accepter les cookies nécessaires', null, 'low'],
    ['Aceptar cookies necesarias', null, 'low'],
    ['Accetta i cookie necessari', null, 'low'],
    ['Noodzakelijke cookies accepteren', null, 'low'],
    ['Technische Cookies akzeptieren', null, 'low'],
    ['Ich akzeptiere technische Cookies', null, 'low'],
    ['Notwendiges akzeptieren', null, 'low'],
    ['Erforderliches akzeptieren', null, 'low'],
    ['Nötige Cookies akzeptieren', null, 'low'],
    ['Accept essentials', null, 'low'],
    ['Accept technical cookies', null, 'low'],
    ['Accetta i cookie tecnici', null, 'low'],
    ['Aceptar cookies técnicas', null, 'low'],
    ['Aceitar cookies técnicos', null, 'low'],
    ['Accepter les cookies techniques', null, 'low'],
    // Beside other wording such a phrase does not decide, and the accept phrase stays restricted to the necessary
    // cookies: a further category is consent to more than them, a further verb is not read.
    ['Accept necessary and analytics cookies', null, 'low'],
    ['Accept necessary + statistics', null, 'low'],
    ['Statistik und notwendige Cookies akzeptieren', null, 'low'],
    ['Accept necessary cookies and continue', null, 'low'],
    ['Notwendige Cookies akzeptieren und schließen', null, 'low'],
    // A further category in a clause of its own is consent to more than the necessary cookies as well.
    ['Accept necessary & analytics cookies', null, 'low'],
    ['Accept necessary, analytics and marketing cookies', null, 'low'],
    ['Accept necessary cookies, analytics cookies', null, 'low'],
    ['Notwendige Cookies akzeptieren / Statistik', null, 'low'],
    ['Statistik, notwendige Cookies akzeptieren', null, 'low'],
    ['Accept necessary (and analytics) cookies', null, 'low'],
    ['Accept necessary cookies (incl. analytics)', null, 'low'],
    ['Notwendige Cookies akzeptieren (inkl. Statistik)', null, 'low'],
    ['Notwendige Cookies akzeptieren – Statistik erlauben', null, 'low'],
    // A word that only recommends counts, other wording around it is not read.
    ['Notwendige Cookies akzeptieren (nicht empfohlen)', null, 'low'],
    // Beside cookie and necessity words and a recommendation only, the phrase decides.
    ['Accept essential cookies (strictly necessary)', 'reject', 'medium'],
    ['Unbedingt erforderliche Cookies akzeptieren', 'reject', 'medium'],
    ['Mit notwendigen Cookies fortfahren (empfohlen)', 'reject', 'medium'],
    ['Mit notwendigen Cookies fortfahren, empfohlen', 'reject', 'medium'],
    ['Essenzielle Cookies akzeptieren (Empfehlung)', 'reject', 'medium'],
    ['Accept necessary cookies (recommended)', 'reject', 'medium'],
    ['Nur notwendige Cookies (empfohlen)', 'reject', 'medium'],
    ['Mit notwendigen Cookies fortfahren (empfohlene Einstellung)', 'reject', 'medium'],
    ['Mit notwendigen Cookies fortfahren (sehr empfohlen)', 'reject', 'medium'],
    ['Mit notwendigen Cookies fortfahren (von uns empfohlen)', 'reject', 'medium'],
    ['Notwendige Cookies akzeptieren (empfohlene)', 'reject', 'medium'],
    ['Essenzielle Cookies akzeptieren (unsere Empfehlung)', 'reject', 'medium'],
    ['Erforderliche Cookies zulassen (Standard)', 'reject', 'medium'],
    ['Accept necessary cookies (highly recommended)', 'reject', 'medium'],
    ['Allow essential cookies (our recommendation)', 'reject', 'medium'],
    ['Use necessary cookies (default)', 'reject', 'medium'],
    // A tie with an accept phrase that the label restricts: the reject phrase decides.
    ['Ich akzeptiere nur notwendige', 'reject', 'medium'],
    ['Ich akzeptiere nur essenzielle', 'reject', 'medium'],
    // The negated consent decides, not the necessary cookies it names.
    ['Do not accept necessary cookies', 'reject', 'medium'],
    // Counterexamples: all cookies, or the optional ones.
    ['Alle Cookies akzeptieren', 'accept', 'high'],
    ['Allow all', 'accept', 'high'],
    ['Aceptar cookies no necesarias', 'accept', 'medium'],
    ['Alle Cookies akzeptieren, auch technisch notwendige', 'accept', 'medium'],
    ['Accept all cookies, including strictly necessary', 'accept', 'medium'],
  ]);

  it('a reject phrase that names the necessary cookies without a restriction decides only beside cookie and necessity words', () => {
    const words = (list: string[] | undefined) => new Set((list ?? []).flatMap(labelTokens));
    const necessity = words(lexicon.necessity);
    const unrestricted = words([...(lexicon.negations ?? []), ...(lexicon.restrictions ?? [])]);
    const phrases = lexicon.reject.filter((p) => {
      const tokens = labelTokens(p);
      return tokens.some((t) => necessity.has(t)) && !tokens.some((t) => unrestricted.has(t));
    });
    expect(phrases.length).toBeGreaterThan(0);
    for (const phrase of phrases) {
      expect(classifyLabel(phrase, lexicon).kind, phrase).toBe('reject');
      const name = `${phrase} and analytics`;
      expect(classifyLabel(name, lexicon).kind, name).toBeNull();
      expect(classifyButton({ name, role: 'button', vendorRole: 'accept' }, lexicon).kind, name).not.toBe(
        'accept',
      );
    }
  });
});

describe('classifyButton: the vendor role cannot turn a qualified label into a decision', () => {
  buttonTable([
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
    // An accept restricted to the necessary cookies is the vendor's reject, never its accept.
    ['Accept strictly necessary cookies', 'button', 'reject', 'reject', 'medium'],
    ['Accept strictly necessary cookies', 'button', 'accept', 'other', 'low'],
    ['Accept necessary cookies (incl. analytics)', 'button', 'reject', 'reject', 'medium'],
    ['Accept necessary cookies (incl. analytics)', 'button', 'accept', 'other', 'low'],
    ['Technische Cookies akzeptieren', 'button', 'reject', 'reject', 'medium'],
    // A consent negated after its phrase is the vendor's reject, never its accept.
    ['Ich akzeptiere keine Cookies', 'button', 'reject', 'reject', 'medium'],
    ['Ich akzeptiere keine Cookies', 'button', 'accept', 'other', 'low'],
    // Consent to the optional cookies stays an accept on the vendor's reject markup.
    ['Ich akzeptiere nicht notwendige Cookies', 'button', 'accept', 'accept', 'high'],
    ['Ich akzeptiere nicht notwendige Cookies', 'button', 'reject', 'accept', 'low'],
    // Counterexample: an unqualified label with the vendor role.
    ['Weiter', 'button', 'reject', 'reject', 'medium'],
  ]);
});

describe('lexicon qualifiers', () => {
  it('lists negations, category words, restrictions and payment wording, none of them a decision phrase', () => {
    const decisions = new Set([...lexicon.accept, ...lexicon.reject].map((p) => labelTokens(p).join(' ')));
    for (const key of [
      'negations',
      'necessity',
      'restrictions',
      'paid',
      'allWords',
      'neutralWords',
    ] as const) {
      const list = lexicon[key] ?? [];
      expect(list.length, key).toBeGreaterThan(0);
      for (const word of list)
        expect(decisions.has(labelTokens(word).join(' ')), `${key}: ${word}`).toBe(false);
    }
  });

  it('no accept phrase names a necessity word: consent to the necessary cookies alone is a reject phrase', () => {
    const necessity = new Set((lexicon.necessity ?? []).map((w) => labelTokens(w).join(' ')));
    for (const phrase of lexicon.accept) {
      for (const token of labelTokens(phrase)) expect(necessity.has(token), phrase).toBe(false);
    }
  });

  it('a lexicon without them is malformed', () => {
    const { paid: _paid, ...withoutPaid } = lexicon;
    expect(() => lexiconFromData(withoutPaid)).toThrow(/lexicon: paid/);
  });

  it('without neutral words a recommendation beside a reject phrase that names the necessary cookies leaves no decision', () => {
    const { neutralWords: _neutralWords, ...rest } = lexicon;
    const withoutNeutralWords = lexiconFromData({ ...rest, version: 'test' });
    expect(
      classifyLabel('Mit notwendigen Cookies fortfahren (empfohlen)', withoutNeutralWords).kind,
    ).toBeNull();
    expect(classifyLabel('Mit notwendigen Cookies fortfahren', withoutNeutralWords).kind).toBe('reject');
  });

  it('without words for all cookies every necessity word beside an accept phrase restricts it', () => {
    const { allWords: _allWords, ...rest } = lexicon;
    const withoutAllWords = lexiconFromData({ ...rest, version: 'test' });
    expect(
      classifyLabel('Alle Cookies akzeptieren, auch technisch notwendige', withoutAllWords).kind,
    ).toBeNull();
    expect(classifyLabel('Alle Cookies akzeptieren', withoutAllWords).kind).toBe('accept');
  });
});

describe('classifyButton: label, role and vendor role', () => {
  buttonTable([
    // Label and vendor role agree → high.
    ['Cookies ablehnen', 'button', 'reject', 'reject', 'high'],
    ['Ausgewählte Cookies akzeptieren', 'button', 'save', 'save', 'high'],
    // The label wins over a conflicting vendor role ("Verbergen" on the decline button), with medium confidence.
    ['Verbergen', 'button', 'reject', 'hide', 'medium'],
    // A link without a lexicon label is a plain link; an unknown button is "other".
    ['Datenschutzerklärung', 'link', null, 'link', 'high'],
    ['Weiter', 'button', null, 'other', 'low'],
    // A reject rendered as a link keeps kind reject (the role tells it is a link).
    ['Ablehnen', 'link', null, 'reject', 'high'],
  ]);
});
