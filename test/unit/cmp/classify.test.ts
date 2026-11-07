/**
 * The pure table `classifyFirstLayer(facts, lexicon)`: every variant plus counterexamples (hide/× is no reject, a
 * link instead of a button, reject only on the second layer).
 */
import { describe, expect, it } from 'vitest';
import { isBlocking } from '../../../src/cmp/classify.ts';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import type { BlockingFacts, CmpButton, CmpDetection, CmpFacts } from '../../../src/cmp/types.ts';
import { classifyFirstLayer, DEFAULT_CLASSIFY } from '../../utils/classify.ts';
import { makeCmpFacts } from '../../utils/snapshot-builder.ts';

const lexicon = loadLexicon();
const DEFAULT_RATIO = DEFAULT_CLASSIFY.blockingCoveredRatio;

function btn(name: string, p: Partial<CmpButton> = {}): CmpButton {
  return {
    role: 'button',
    name,
    tag: 'button',
    kind: 'other',
    kindConfidence: 'low',
    layer: 1,
    box: { x: 100, y: 600, width: 160, height: 40 },
    visibleAtFirstScreen: true,
    actionableAtFirstScreen: true,
    contrast: 7,
    selector: `#${name.replace(/\W+/g, '-')}`,
    ...p,
  };
}

const detected: CmpDetection = {
  cmpId: 'cookiebot',
  method: 'adapter',
  version: null,
  versionSupported: null,
  recognitionConfidence: 'high',
  signals: ['global:Cookiebot', 'dom:#CybotCookiebotDialog'],
};

const blocking: BlockingFacts = {
  overlay: true,
  scrollLock: true,
  inert: false,
  coveredRatio: 1,
  method: ['overlay-grid', 'overflow-hidden'],
};
const nonBlocking: BlockingFacts = {
  overlay: false,
  scrollLock: false,
  inert: false,
  coveredRatio: 0.18,
  method: ['overlay-grid'],
};

/** Facts of a recognised, visible, non-blocking first layer with `buttons`; `p.firstLayer` changes single fields. */
function facts(
  buttons: CmpButton[],
  p: Omit<Partial<CmpFacts>, 'firstLayer'> & { firstLayer?: Partial<CmpFacts['firstLayer']> } = {},
): CmpFacts {
  const { firstLayer, ...rest } = p;
  return makeCmpFacts({
    detection: detected,
    firstLayer: {
      bannerPresent: true,
      bannerVisible: true,
      buttons,
      purAbo: false,
      closeMeansAccept: null,
      ...firstLayer,
    },
    blocking: nonBlocking,
    ...rest,
  });
}

const classify = (...args: Parameters<typeof facts>) => classifyFirstLayer(facts(...args), lexicon);

describe('isBlocking', () => {
  it('overlay, scroll lock, inert or coveredRatio ≥ 0.85', () => {
    expect(DEFAULT_RATIO).toBe(0.85);
    expect(isBlocking(nonBlocking, DEFAULT_RATIO)).toBe(false);
    expect(isBlocking(blocking, DEFAULT_RATIO)).toBe(true);
    expect(isBlocking({ ...nonBlocking, inert: true }, DEFAULT_RATIO)).toBe(true);
    expect(isBlocking({ ...nonBlocking, scrollLock: true }, DEFAULT_RATIO)).toBe(true);
    expect(isBlocking({ ...nonBlocking, coveredRatio: 0.9 }, DEFAULT_RATIO)).toBe(true);
    expect(isBlocking({ ...nonBlocking, ariaModal: true }, DEFAULT_RATIO)).toBe(false);
  });

  it.each([
    // [coveredRatio, threshold, blocking]
    [0.84, 0.85, false],
    [0.85, 0.85, true],
    [0.6, 0.5, true],
    [0.5, 0.5, true],
    [0.49, 0.5, false],
    [0.9, 0.95, false],
    [1, 1, true],
    [null, 0.5, false],
  ] as const)('covered share %s with threshold %s → %s', (coveredRatio, threshold, expected) => {
    expect(isBlocking({ ...nonBlocking, coveredRatio }, threshold)).toBe(expected);
  });

  it('overlay, scroll lock and inert stay blocking whatever the threshold', () => {
    expect(isBlocking({ ...nonBlocking, overlay: true }, 1)).toBe(true);
    expect(isBlocking({ ...nonBlocking, scrollLock: true }, 1)).toBe(true);
    expect(isBlocking({ ...nonBlocking, inert: true }, 1)).toBe(true);
  });

  it('classifyFirstLayer applies the threshold of the settings to the first layer', () => {
    const covering = facts([btn('Alle akzeptieren'), btn('Einstellungen')], {
      blocking: { ...nonBlocking, coveredRatio: 0.6 },
    });
    expect(classifyFirstLayer(covering, lexicon).variant).toBe('nonblocking-no-reject');
    const strict = classifyFirstLayer(covering, lexicon, { blockingCoveredRatio: 0.5 });
    expect(strict.variant).toBe('blocking-no-reject');
    expect(strict.blocking).toBe(true);
  });
});

describe('classifyFirstLayer: variants', () => {
  it('ok: actionable reject and accept buttons', () => {
    const r = classify([btn('Ablehnen'), btn('Alle akzeptieren'), btn('Einstellungen')]);
    expect(r.variant).toBe('ok');
    expect(r.confidence).toBe('high');
    expect(r.acceptAvailableAtFirstLayer).toBe(true);
    expect(r.targets?.reject?.name).toBe('Ablehnen');
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
    expect(r.lexiconVersion).toBe(lexicon.version);
  });

  it('ok also for a blocking banner that offers a reject', () => {
    const r = classify([btn('Nur essenzielle Cookies akzeptieren'), btn('Alle akzeptieren')], { blocking });
    expect(r.variant).toBe('ok');
    expect(r.blocking).toBe(true);
  });

  it('blocking-no-reject: blocking, accept available, only settings', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Einstellungen')], { blocking });
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.confidence).toBe('high');
    expect(r.targets?.reject).toBeNull();
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
  });

  it('blocking-no-reject: "Verbergen" instead of a reject is not a reject (catalog example)', () => {
    const r = classify([btn('Zustimmen'), btn('Verbergen')], { blocking });
    expect(r.variant).toBe('blocking-no-reject');
  });

  it('blocking-no-reject: "×" and "Später" are not a reject', () => {
    const r = classify([btn('Alle akzeptieren'), btn('×', { kind: 'close' }), btn('Später')], { blocking });
    expect(r.variant).toBe('blocking-no-reject');
  });

  it('blocking-no-reject: a reject only on the second layer (hidden settings panel) does not count', () => {
    const r = classify(
      [
        btn('Alle akzeptieren'),
        btn('Einstellungen'),
        btn('Alle ablehnen', { layer: 2, visibleAtFirstScreen: false, actionableAtFirstScreen: false }),
      ],
      { blocking },
    );
    expect(r.variant).toBe('blocking-no-reject');
  });

  // Warning/critical only with an unambiguous first layer; an unknown button might be the reject.
  it('blocking, accept, an unclassified button and no reject → banner-not-recognized (5.5), not blocking-no-reject', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Weiter')], { blocking });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toEqual(['unclassified-buttons:1', 'ambiguous-first-layer:blocking-no-reject']);
    expect(r.targets?.reject).toBeNull();
    // The accept itself is unambiguous: phase C may still click it.
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
    expect(r.acceptAvailableAtFirstLayer).toBe(true);
  });

  it('"Ablehnen und schließen" on a blocking banner is a working reject → ok, and it is the reject target', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Ablehnen und schließen')], { blocking });
    expect(r.variant).toBe('ok');
    expect(r.confidence).toBe('high');
    expect(r.targets?.reject?.name).toBe('Ablehnen und schließen');
  });

  it('every no-reject or broken-reject variant with an unclassified button becomes banner-not-recognized', () => {
    const cases: Array<[string, CmpFacts]> = [
      ['nonblocking-no-reject', facts([btn('Alle akzeptieren'), btn('Weiter')])],
      ['no-choice-at-first-layer', facts([btn('Einstellungen'), btn('Weiter')], { blocking })],
      [
        'reject-not-actionable',
        facts([
          btn('Alle akzeptieren'),
          btn('Ablehnen', { actionableAtFirstScreen: false, hitTestOk: false }),
          btn('Weiter'),
        ]),
      ],
      [
        'reject-as-link',
        facts([btn('Alle akzeptieren'), btn('Ablehnen', { role: 'link', tag: 'a' }), btn('Weiter')]),
      ],
    ];
    for (const [was, f] of cases) {
      const r = classifyFirstLayer(f, lexicon);
      expect(r.variant, was).toBe('banner-not-recognized');
      expect(r.confidence, was).toBe('low');
      expect(r.reasons, was).toContain(`ambiguous-first-layer:${was}`);
      expect(r.targets?.reject ?? null, was).toBeNull();
    }
  });

  it('counterexample: an unclassified button next to a working reject keeps ok (it changes nothing)', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Ablehnen'), btn('Weiter')], { blocking });
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
    expect(r.reasons).toContain('unclassified-buttons:1');
  });

  it('a vendor reject button relabelled "Verbergen" gives medium confidence', () => {
    const r = classify(
      [btn('Alle akzeptieren', { vendorRole: 'accept' }), btn('Verbergen', { vendorRole: 'reject' })],
      { blocking },
    );
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.confidence).toBe('medium');
  });

  it('no-choice-at-first-layer: blocking with neither accept nor reject (settings only)', () => {
    const r = classify([btn('Einstellungen')], { blocking });
    expect(r.variant).toBe('no-choice-at-first-layer');
    expect(r.acceptAvailableAtFirstLayer).toBe(false);
  });

  it('close-means-accept: × present and the CMP config says × = accept', () => {
    const r = classify([btn('Ablehnen'), btn('Alle akzeptieren'), btn('×', { name: '×' })], {
      firstLayer: { closeMeansAccept: true },
    });
    expect(r.variant).toBe('close-means-accept');
  });

  it('counterexample: × without config is not close-means-accept', () => {
    const r = classify([btn('Ablehnen'), btn('Alle akzeptieren'), btn('×')]);
    expect(r.variant).toBe('ok');
  });

  it('counterexample: closeMeansAccept config without a visible × is not close-means-accept', () => {
    const r = classify([btn('Ablehnen'), btn('Alle akzeptieren')], {
      firstLayer: { closeMeansAccept: true },
    });
    expect(r.variant).toBe('ok');
  });

  it('reject-not-actionable: reject rendered but covered / outside the viewport', () => {
    const r = classify(
      [btn('Ablehnen', { actionableAtFirstScreen: false, hitTestOk: false }), btn('Alle akzeptieren')],
      { blocking },
    );
    expect(r.variant).toBe('reject-not-actionable');
    expect(r.targets?.reject).toBeNull();
  });

  it('reject-as-link: reject is a text link while accept is a button', () => {
    const r = classify([btn('Ablehnen', { role: 'link', tag: 'a' }), btn('Alle akzeptieren')], { blocking });
    expect(r.variant).toBe('reject-as-link');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
  });

  it.each([
    'Nicht notwendige Cookies ablehnen',
    'Reject non-essential cookies',
    'Ablehnen (keine Statistik)',
  ])(
    'a reject that negates a cookie category ("%s") is the reject target, as a link and as a button',
    (label) => {
      const asLink = classify([btn(label, { role: 'link', tag: 'a' }), btn('Alle akzeptieren')], {
        blocking,
      });
      expect(asLink.variant).toBe('reject-as-link');
      expect(asLink.targets?.reject?.name).toBe(label);

      const asButton = classify([btn(label), btn('Alle akzeptieren')], { blocking });
      expect(asButton.variant).toBe('ok');
      expect(asButton.targets?.reject?.name).toBe(label);
    },
  );

  it.each([undefined, 'accept', 'reject'] as const)(
    'consent to the optional cookies ("Ich akzeptiere nicht notwendige Cookies", vendor role %s) is never the reject target',
    (vendorRole) => {
      const consent = btn('Ich akzeptiere nicht notwendige Cookies', vendorRole ? { vendorRole } : {});

      const withReject = classify([consent, btn('Alle ablehnen')], { blocking });
      expect(withReject.buttons?.[0]?.kind).toBe('accept');
      expect(withReject.variant).toBe('ok');
      expect(withReject.targets?.reject?.name).toBe('Alle ablehnen');

      const withoutReject = classify([consent, btn('Einstellungen')], { blocking });
      expect(withoutReject.variant).toBe('blocking-no-reject');
      expect(withoutReject.targets?.reject).toBeNull();
      expect(withoutReject.targets?.accept?.name).toBe('Ich akzeptiere nicht notwendige Cookies');
    },
  );

  it.each([
    ['Accept necessary', 'Accept all'],
    ['Erforderliche Cookies erlauben', 'Alle akzeptieren'],
    ['Keine Cookies akzeptieren', 'Alle akzeptieren'],
    ['Mit notwendigen Cookies fortfahren (empfohlen)', 'Alle akzeptieren'],
    ['Accept necessary cookies (recommended)', 'Accept all'],
    ['Mit notwendigen Cookies fortfahren (empfohlene Einstellung)', 'Alle akzeptieren'],
  ])('a refusal worded as consent ("%s") is the reject target next to "%s"', (refusal, acceptAll) => {
    const r = classify([btn(refusal), btn(acceptAll)], { blocking });
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe(refusal);
    expect(r.targets?.accept?.name).toBe(acceptAll);
  });

  it.each([
    ['restricted to the necessary cookies', 'Accept strictly necessary cookies'],
    ['to the necessary cookies and another category', 'Accept necessary and analytics cookies'],
    ['negated after its phrase', 'Ich akzeptiere keine Cookies'],
    [
      'to the necessary cookies and another category in brackets',
      'Accept necessary cookies (incl. analytics)',
    ],
    ['to not all cookies, these in brackets', 'Ich akzeptiere nicht (alle Cookies)'],
    ['as a reject negated across brackets', 'Nicht (alle Cookies) ablehnen'],
  ])('a consent %s ("%s") beside an accept leaves the first layer without a verdict', (_case, label) => {
    const r = classify([btn(label), btn('Accept all')], { blocking });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('ambiguous-first-layer:blocking-no-reject');
    expect(r.targets?.reject).toBeNull();
    expect(r.targets?.accept?.name).toBe('Accept all');
  });

  it.each([
    ['an answer before the decision', 'No, reject all', 'Yes, accept all'],
    ['a longer close phrase', 'Ablehnen und Fenster schließen', 'Alle zulassen'],
    ['a synonym of the necessary cookies', 'Technische Cookies akzeptieren', 'Alle zulassen'],
  ])('the vendor reject with %s ("%s") is the reject target', (_case, refusal, acceptAll) => {
    const r = classify([btn(refusal, { vendorRole: 'reject' }), btn(acceptAll, { vendorRole: 'accept' })], {
      blocking,
    });
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe(refusal);
    expect(r.targets?.accept?.name).toBe(acceptAll);
  });

  it.each(['Ich akzeptiere – nicht mehr anzeigen', 'Akzeptieren & nicht mehr anzeigen'])(
    'a consent with a clause of its own ("%s") stays the accept target: no reject is reported missing',
    (consent) => {
      const r = classify(
        [btn(consent, { vendorRole: 'accept' }), btn('Einstellungen', { vendorRole: 'settings' })],
        { blocking },
      );
      expect(r.variant).toBe('blocking-no-reject');
      expect(r.targets?.reject).toBeNull();
      expect(r.targets?.accept?.name).toBe(consent);
    },
  );

  it.each([
    ['Nicht (alle Cookies) akzeptieren', 'Einstellungen', null],
    ['Nicht (alle Cookies) akzeptieren', 'Alle akzeptieren', 'Alle akzeptieren'],
    ['Do not (accept all cookies)', 'Settings', null],
    ['Do not (accept all cookies)', 'Accept all', 'Accept all'],
    ['Ich akzeptiere (die Cookies) nicht', 'Einstellungen', null],
    ['Ich akzeptiere (die Cookies) nicht', 'Alle akzeptieren', 'Alle akzeptieren'],
  ])(
    'the vendor reject negated across a bracketed insertion ("%s", beside "%s") is the reject target, never the accept',
    (refusal, other, accept) => {
      const r = classify([btn(refusal, { vendorRole: 'reject' }), btn(other)], { blocking });
      expect(r.variant).toBe('ok');
      expect(r.targets?.reject?.name).toBe(refusal);
      expect(r.targets?.accept?.name ?? null).toBe(accept);
    },
  );

  it('a settings button that refuses not all cookies ("Ich akzeptiere nicht alle Cookies") is no reject target', () => {
    const r = classify(
      [
        btn('Alle akzeptieren', { vendorRole: 'accept' }),
        btn('Ich akzeptiere nicht alle Cookies', { vendorRole: 'settings' }),
      ],
      { blocking },
    );
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.targets?.reject).toBeNull();
  });

  it('counterexample: a reject that negates the decision ("Nicht ablehnen") is no reject target', () => {
    const r = classify([btn('Nicht ablehnen', { vendorRole: 'reject' }), btn('Alle akzeptieren')], {
      blocking,
    });
    expect(r.targets?.reject).toBeNull();
  });

  it('counterexample: reject and accept both rendered as links (same element type) is ok', () => {
    const r = classify([
      btn('Nur notwendige Cookies', { role: 'link', tag: 'a' }),
      btn('Alle akzeptieren', { role: 'link', tag: 'a' }),
    ]);
    expect(r.variant).toBe('ok');
  });

  it('nonblocking-no-reject: non-blocking bar with accept and settings only', () => {
    const r = classify([btn('Akzeptieren'), btn('Mehr Optionen')]);
    expect(r.variant).toBe('nonblocking-no-reject');
  });

  it('pur-abo: flag set, primary variant still from the table (flag does not switch off other variants)', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Pur-Abo abschließen')], {
      blocking,
      firstLayer: { purAbo: true },
    });
    expect(r.flags).toEqual(['pur-abo']);
    expect(r.variant).toBe('blocking-no-reject');
    // The subscription button is the known paid alternative, not an unclassified button.
    expect(r.reasons).not.toContain('unclassified-buttons:1');
  });

  it('counterexample: without the pur-abo flag the same button is unknown → banner-not-recognized', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Pur-Abo abschließen')], { blocking });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('unclassified-buttons:1');
  });

  it('in a pay-or-OK banner a button with subscription wording is the known paid alternative', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Jetzt abonnieren')], {
      blocking,
      firstLayer: { purAbo: true },
    });
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.reasons).not.toContain('unclassified-buttons:1');
    expect(r.targets?.reject).toBeNull();
  });

  it('a reject that also subscribes is no reject target, even on the vendor reject markup', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Reject all and subscribe', { vendorRole: 'reject' })]);
    expect(r.targets?.reject).toBeNull();
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('unclassified-buttons:1');
  });

  it('an accept that also pays is no accept target', () => {
    const r = classify([btn('Ablehnen'), btn('Accept and pay')]);
    expect(r.targets?.reject?.name).toBe('Ablehnen');
    expect(r.targets?.accept).toBeNull();
    expect(r.acceptAvailableAtFirstLayer).toBe(false);
  });

  it('pur-abo becomes the primary variant when the table gives ok', () => {
    const r = classify([btn('Ablehnen'), btn('Alle akzeptieren')], { firstLayer: { purAbo: true } });
    expect(r.variant).toBe('pur-abo');
    expect(r.flags).toEqual(['pur-abo']);
  });

  it('banner-not-recognized: heuristic detection never gives a verdict', () => {
    const r = classify([btn('Alle akzeptieren')], {
      blocking,
      detection: { ...detected, cmpId: null, method: 'heuristic', recognitionConfidence: 'medium' },
    });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.targets).toEqual({ reject: null, accept: null });
  });

  it('banner-not-recognized: adapter with medium recognition (one signal) only', () => {
    const r = classify([btn('Alle akzeptieren')], {
      blocking,
      detection: { ...detected, recognitionConfidence: 'medium', signals: ['dom:#CybotCookiebotDialog'] },
    });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('recognition-medium');
  });

  it('banner-not-recognized: nothing detected', () => {
    const r = classifyFirstLayer(makeCmpFacts(), lexicon);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('no-banner-detected');
  });

  it('banner-not-recognized: CMP recognized but no banner visible (stored consent, geo or bot branch)', () => {
    const r = classify([], { firstLayer: { bannerVisible: false } });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('banner-not-visible');
  });

  it('cmp-not-supported: version outside the tested range', () => {
    const r = classify([btn('Alle akzeptieren')], {
      blocking,
      detection: { ...detected, cmpId: 'borlabs', version: '1.9.8', versionSupported: false },
    });
    expect(r.variant).toBe('cmp-not-supported');
    expect(r.reasons).toContain('version-out-of-range:1.9.8');
  });

  it('ambiguous targets: two visible reject buttons with the same confidence → no click target', () => {
    const r = classify([
      btn('Ablehnen', { selector: '#a' }),
      btn('Alle ablehnen', { selector: '#b' }),
      btn('Alle akzeptieren'),
    ]);
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject).toBeNull();
    expect(r.reasons).toContain('reject-target-ambiguous');
  });

  it('is pure: same input → same output, input not mutated', () => {
    const f = facts([btn('Alle akzeptieren', { kind: 'reject' }), btn('Einstellungen')], { blocking });
    const copy = structuredClone(f);
    expect(classifyFirstLayer(f, lexicon)).toEqual(classifyFirstLayer(f, lexicon));
    expect(f).toEqual(copy);
  });

  it('re-classifies stored kinds with the given lexicon (kind in snapshot is not trusted)', () => {
    const f = facts(
      [btn('Alle akzeptieren', { kind: 'reject', kindConfidence: 'high' }), btn('Einstellungen')],
      { blocking },
    );
    const r = classifyFirstLayer(f, lexicon);
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.buttons?.[0]?.kind).toBe('accept');
  });

  it('a changed lexicon changes the outcome (basis for lexicon-changed-since-scan)', () => {
    const f = facts([btn('Weiter mit Basis'), btn('Alle akzeptieren')], { blocking });
    // An unknown button might be the reject: no verdict until the lexicon knows it.
    expect(classifyFirstLayer(f, lexicon).variant).toBe('banner-not-recognized');
    const extended = { ...lexicon, version: 'test', reject: [...lexicon.reject, 'weiter mit basis'] };
    expect(classifyFirstLayer(f, extended).variant).toBe('ok');
  });
});

// the probe keeps at most N buttons. When first-layer candidates were dropped, "no reject" is not a finding.
describe('classifyFirstLayer: truncated button set', () => {
  const truncated = (buttons: CmpButton[], p: { blocking?: BlockingFacts } = {}) =>
    classify(buttons, { ...p, firstLayer: { buttonsTruncated: true } });

  it('non-blocking bar without a found reject → banner-not-recognized / buttons-truncated, not nonblocking-no-reject', () => {
    const r = truncated([btn('Alle akzeptieren'), btn('Einstellungen')]);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('buttons-truncated');
    expect(r.targets?.reject).toBeNull();
  });

  it('blocking banner without a found reject → no blocking-no-reject (critical) on an incomplete set', () => {
    const r = truncated([btn('Alle akzeptieren'), btn('Einstellungen')], { blocking });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('buttons-truncated');
  });

  it('a reject that is not actionable in the kept set does not prove the absence of an actionable one', () => {
    const r = truncated([
      btn('Ablehnen', { actionableAtFirstScreen: false, hitTestOk: false }),
      btn('Alle akzeptieren'),
    ]);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('buttons-truncated');
  });

  it('no-choice-at-first-layer and reject-as-link are also not concluded from an incomplete set', () => {
    expect(truncated([btn('Einstellungen')], { blocking }).reasons).toContain('buttons-truncated');
    expect(truncated([btn('Ablehnen', { role: 'link', tag: 'a' }), btn('Alle akzeptieren')]).variant).toBe(
      'banner-not-recognized',
    );
  });

  it('counterexample: the full, untruncated set without a reject keeps nonblocking-no-reject', () => {
    const r = classify([btn('Alle akzeptieren'), btn('Einstellungen')]);
    expect(r.variant).toBe('nonblocking-no-reject');
    expect(r.reasons).not.toContain('buttons-truncated');
  });

  it('counterexample: truncated, but an actionable reject was found → ok with its click target', () => {
    const r = truncated([btn('Ablehnen'), btn('Alle akzeptieren')]);
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
  });

  it('the accept stays a click target of the incomplete set (phase C is not affected)', () => {
    const r = truncated([btn('Alle akzeptieren'), btn('Einstellungen')]);
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
  });
});

// geometry measured during the appearance animation says nothing about reachability.
describe('classifyFirstLayer: unsettled geometry', () => {
  const rejectBelowViewport = (firstLayer: { geometryUnsettled?: boolean }) =>
    classify(
      [
        btn('Ablehnen', { actionableAtFirstScreen: false, inViewport: false, visibleAtFirstScreen: false }),
        btn('Alle akzeptieren'),
      ],
      { firstLayer },
    );

  it('reject outside the viewport while the geometry was unsettled → banner-not-recognized / geometry-unsettled', () => {
    const r = rejectBelowViewport({ geometryUnsettled: true });
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('geometry-unsettled');
    expect(r.targets?.reject).toBeNull();
  });

  it('counterexample: a settled container with the reject outside the viewport stays reject-not-actionable', () => {
    for (const geometryUnsettled of [false, undefined]) {
      const r = rejectBelowViewport({ geometryUnsettled });
      expect(r.variant).toBe('reject-not-actionable');
      expect(r.reasons).toContain('reject-not-actionable:outside-viewport');
    }
  });

  it('unsettled geometry does not touch variants that do not depend on geometry', () => {
    const r = classify([btn('Ablehnen'), btn('Alle akzeptieren')], {
      firstLayer: { geometryUnsettled: true },
    });
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
  });
});

// the only actionable "accept" is a save-selection button → no accept target (phase C must not click it).
describe('classifyFirstLayer: save-selection button', () => {
  it('a lone "Ausgewählte Cookies akzeptieren" with vendor role save is no accept', () => {
    const r = classify([
      btn('Ausgewählte Cookies akzeptieren', { vendorRole: 'save' }),
      btn('Einstellungen'),
    ]);
    expect(r.buttons?.[0]).toMatchObject({ kind: 'save', kindConfidence: 'high' });
    expect(r.acceptAvailableAtFirstLayer).toBe(false);
    expect(r.targets?.accept).toBeNull();
  });

  it('counterexample: "Alle Cookies akzeptieren" next to it is the accept target', () => {
    const r = classify([
      btn('Ausgewählte Cookies akzeptieren', { vendorRole: 'save' }),
      btn('Alle Cookies akzeptieren', { vendorRole: 'accept' }),
    ]);
    expect(r.acceptAvailableAtFirstLayer).toBe(true);
    expect(r.targets?.accept?.name).toBe('Alle Cookies akzeptieren');
  });
});
