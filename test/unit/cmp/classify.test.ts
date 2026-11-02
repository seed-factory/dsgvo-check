/**
 * the pure table `classifyFirstLayer(facts, lexicon)` — every variant plus counterexamples
 * (Verbergen / × are not a reject, a link instead of a button, reject only on the second layer…).
 */
import { describe, expect, it } from 'vitest';
import { classifyFirstLayer, isBlocking } from '../../../src/cmp/classify.ts';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import type { BlockingFacts, CmpButton, CmpDetection, CmpFacts } from '../../../src/cmp/types.ts';
import { makeCmpFacts } from '../../utils/snapshot-builder.ts';

const lexicon = loadLexicon();

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

function facts(
  buttons: CmpButton[],
  p: Partial<CmpFacts> & { closeMeansAccept?: boolean | null } = {},
): CmpFacts {
  const { closeMeansAccept = null, ...rest } = p;
  return makeCmpFacts({
    detection: detected,
    firstLayer: { bannerPresent: true, bannerVisible: true, buttons, purAbo: false, closeMeansAccept },
    blocking: nonBlocking,
    ...rest,
  });
}

describe('isBlocking', () => {
  it('overlay, scroll lock, inert or coveredRatio ≥ 0.85', () => {
    expect(isBlocking(nonBlocking)).toBe(false);
    expect(isBlocking(blocking)).toBe(true);
    expect(isBlocking({ ...nonBlocking, inert: true })).toBe(true);
    expect(isBlocking({ ...nonBlocking, scrollLock: true })).toBe(true);
    expect(isBlocking({ ...nonBlocking, coveredRatio: 0.9 })).toBe(true);
    expect(isBlocking({ ...nonBlocking, ariaModal: true })).toBe(false);
  });
});

describe('classifyFirstLayer: variants', () => {
  it('ok: actionable reject and accept buttons', () => {
    const r = classifyFirstLayer(
      facts([btn('Ablehnen'), btn('Alle akzeptieren'), btn('Einstellungen')]),
      lexicon,
    );
    expect(r.variant).toBe('ok');
    expect(r.confidence).toBe('high');
    expect(r.acceptAvailableAtFirstLayer).toBe(true);
    expect(r.targets?.reject?.name).toBe('Ablehnen');
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
    expect(r.lexiconVersion).toBe(lexicon.version);
  });

  it('ok also for a blocking banner that offers a reject', () => {
    const r = classifyFirstLayer(
      facts([btn('Nur essenzielle Cookies akzeptieren'), btn('Alle akzeptieren')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('ok');
    expect(r.blocking).toBe(true);
  });

  it('blocking-no-reject: blocking, accept available, only settings', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren'), btn('Einstellungen')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.confidence).toBe('high');
    expect(r.targets?.reject).toBeNull();
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
  });

  it('blocking-no-reject: "Verbergen" instead of a reject is not a reject (catalog example)', () => {
    const r = classifyFirstLayer(facts([btn('Zustimmen'), btn('Verbergen')], { blocking }), lexicon);
    expect(r.variant).toBe('blocking-no-reject');
  });

  it('blocking-no-reject: "×" and "Später" are not a reject', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren'), btn('×', { kind: 'close' }), btn('Später')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('blocking-no-reject');
  });

  it('blocking-no-reject: a reject only on the second layer (hidden settings panel) does not count', () => {
    const r = classifyFirstLayer(
      facts(
        [
          btn('Alle akzeptieren'),
          btn('Einstellungen'),
          btn('Alle ablehnen', { layer: 2, visibleAtFirstScreen: false, actionableAtFirstScreen: false }),
        ],
        { blocking },
      ),
      lexicon,
    );
    expect(r.variant).toBe('blocking-no-reject');
  });

  // / 5.5: warning/critical only with an unambiguous first layer; an unknown button might be the reject.
  it('blocking, accept, an unclassified button and no reject → banner-not-recognized (5.5), not blocking-no-reject', () => {
    const r = classifyFirstLayer(facts([btn('Alle akzeptieren'), btn('Weiter')], { blocking }), lexicon);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toEqual(['unclassified-buttons:1', 'ambiguous-first-layer:blocking-no-reject']);
    expect(r.targets?.reject).toBeNull();
    // The accept itself is unambiguous: phase C may still click it.
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
    expect(r.acceptAvailableAtFirstLayer).toBe(true);
  });

  it('"Ablehnen und schließen" on a blocking banner is a working reject → ok, and it is the reject target', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren'), btn('Ablehnen und schließen')], { blocking }),
      lexicon,
    );
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
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren'), btn('Ablehnen'), btn('Weiter')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
    expect(r.reasons).toContain('unclassified-buttons:1');
  });

  it('a vendor reject button relabelled "Verbergen" gives medium confidence', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren', { vendorRole: 'accept' }), btn('Verbergen', { vendorRole: 'reject' })], {
        blocking,
      }),
      lexicon,
    );
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.confidence).toBe('medium');
  });

  it('no-choice-at-first-layer: blocking with neither accept nor reject (settings only)', () => {
    const r = classifyFirstLayer(facts([btn('Einstellungen')], { blocking }), lexicon);
    expect(r.variant).toBe('no-choice-at-first-layer');
    expect(r.acceptAvailableAtFirstLayer).toBe(false);
  });

  it('close-means-accept: × present and the CMP config says × = accept', () => {
    const r = classifyFirstLayer(
      facts([btn('Ablehnen'), btn('Alle akzeptieren'), btn('×', { name: '×' })], { closeMeansAccept: true }),
      lexicon,
    );
    expect(r.variant).toBe('close-means-accept');
  });

  it('counterexample: × without config is not close-means-accept', () => {
    const r = classifyFirstLayer(facts([btn('Ablehnen'), btn('Alle akzeptieren'), btn('×')]), lexicon);
    expect(r.variant).toBe('ok');
  });

  it('counterexample: closeMeansAccept config without a visible × is not close-means-accept', () => {
    const r = classifyFirstLayer(
      facts([btn('Ablehnen'), btn('Alle akzeptieren')], { closeMeansAccept: true }),
      lexicon,
    );
    expect(r.variant).toBe('ok');
  });

  it('reject-not-actionable: reject rendered but covered / outside the viewport', () => {
    const r = classifyFirstLayer(
      facts(
        [btn('Ablehnen', { actionableAtFirstScreen: false, hitTestOk: false }), btn('Alle akzeptieren')],
        {
          blocking,
        },
      ),
      lexicon,
    );
    expect(r.variant).toBe('reject-not-actionable');
    expect(r.targets?.reject).toBeNull();
  });

  it('reject-as-link: reject is a text link while accept is a button', () => {
    const r = classifyFirstLayer(
      facts([btn('Ablehnen', { role: 'link', tag: 'a' }), btn('Alle akzeptieren')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('reject-as-link');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
  });

  it('counterexample: reject and accept both rendered as links (same element type) is ok', () => {
    const r = classifyFirstLayer(
      facts([
        btn('Nur notwendige Cookies', { role: 'link', tag: 'a' }),
        btn('Alle akzeptieren', { role: 'link', tag: 'a' }),
      ]),
      lexicon,
    );
    expect(r.variant).toBe('ok');
  });

  it('nonblocking-no-reject: non-blocking bar with accept and settings only', () => {
    const r = classifyFirstLayer(facts([btn('Akzeptieren'), btn('Mehr Optionen')]), lexicon);
    expect(r.variant).toBe('nonblocking-no-reject');
  });

  it('pur-abo: flag set, primary variant still from the table (flag does not switch off other variants)', () => {
    const base = facts([btn('Alle akzeptieren'), btn('Pur-Abo abschließen')], { blocking });
    const r = classifyFirstLayer({ ...base, firstLayer: { ...base.firstLayer, purAbo: true } }, lexicon);
    expect(r.flags).toEqual(['pur-abo']);
    expect(r.variant).toBe('blocking-no-reject');
    // The subscription button is the known paid alternative, not an unclassified button.
    expect(r.reasons).not.toContain('unclassified-buttons:1');
  });

  it('counterexample: without the pur-abo flag the same button is unknown → banner-not-recognized', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren'), btn('Pur-Abo abschließen')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('unclassified-buttons:1');
  });

  it('pur-abo becomes the primary variant when the table gives ok', () => {
    const base = facts([btn('Ablehnen'), btn('Alle akzeptieren')]);
    const r = classifyFirstLayer({ ...base, firstLayer: { ...base.firstLayer, purAbo: true } }, lexicon);
    expect(r.variant).toBe('pur-abo');
    expect(r.flags).toEqual(['pur-abo']);
  });

  it('banner-not-recognized: heuristic detection never gives a verdict', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren')], {
        blocking,
        detection: { ...detected, cmpId: null, method: 'heuristic', recognitionConfidence: 'medium' },
      }),
      lexicon,
    );
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.targets).toEqual({ reject: null, accept: null });
  });

  it('banner-not-recognized: adapter with medium recognition (one signal) only', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren')], {
        blocking,
        detection: { ...detected, recognitionConfidence: 'medium', signals: ['dom:#CybotCookiebotDialog'] },
      }),
      lexicon,
    );
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('recognition-medium');
  });

  it('banner-not-recognized: nothing detected', () => {
    const r = classifyFirstLayer(makeCmpFacts(), lexicon);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('no-banner-detected');
  });

  it('banner-not-recognized: CMP recognized but no banner visible (stored consent, geo or bot branch)', () => {
    const f = facts([]);
    const r = classifyFirstLayer({ ...f, firstLayer: { ...f.firstLayer, bannerVisible: false } }, lexicon);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('banner-not-visible');
  });

  it('cmp-not-supported: version outside the tested range', () => {
    const r = classifyFirstLayer(
      facts([btn('Alle akzeptieren')], {
        blocking,
        detection: { ...detected, cmpId: 'borlabs', version: '1.9.8', versionSupported: false },
      }),
      lexicon,
    );
    expect(r.variant).toBe('cmp-not-supported');
    expect(r.reasons).toContain('version-out-of-range:1.9.8');
  });

  it('ambiguous targets: two visible reject buttons with the same confidence → no click target', () => {
    const r = classifyFirstLayer(
      facts([
        btn('Ablehnen', { selector: '#a' }),
        btn('Alle ablehnen', { selector: '#b' }),
        btn('Alle akzeptieren'),
      ]),
      lexicon,
    );
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
      {
        blocking,
      },
    );
    const r = classifyFirstLayer(f, lexicon);
    expect(r.variant).toBe('blocking-no-reject');
    expect(r.buttons?.[0]?.kind).toBe('accept');
  });

  it('a changed lexicon changes the outcome (basis for lexicon-changed-since-scan)', () => {
    const f = facts([btn('Weiter mit Basis'), btn('Alle akzeptieren')], { blocking });
    // An unknown button might be the reject: no verdict (5.5) until the lexicon knows it.
    expect(classifyFirstLayer(f, lexicon).variant).toBe('banner-not-recognized');
    const extended = { ...lexicon, version: 'test', reject: [...lexicon.reject, 'weiter mit basis'] };
    expect(classifyFirstLayer(f, extended).variant).toBe('ok');
  });
});

// : the probe keeps at most N buttons. When first-layer candidates were dropped, "no reject" is not a finding.
describe('classifyFirstLayer: truncated button set', () => {
  const truncated = (buttons: CmpButton[], p: Partial<CmpFacts> = {}): CmpFacts => {
    const f = facts(buttons, p);
    return { ...f, firstLayer: { ...f.firstLayer, buttonsTruncated: true } };
  };

  it('non-blocking bar without a found reject → banner-not-recognized / buttons-truncated, not nonblocking-no-reject', () => {
    const r = classifyFirstLayer(truncated([btn('Alle akzeptieren'), btn('Einstellungen')]), lexicon);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('buttons-truncated');
    expect(r.targets?.reject).toBeNull();
  });

  it('blocking banner without a found reject → no blocking-no-reject (critical) on an incomplete set', () => {
    const r = classifyFirstLayer(
      truncated([btn('Alle akzeptieren'), btn('Einstellungen')], { blocking }),
      lexicon,
    );
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('buttons-truncated');
  });

  it('a reject that is not actionable in the kept set does not prove the absence of an actionable one', () => {
    const r = classifyFirstLayer(
      truncated([
        btn('Ablehnen', { actionableAtFirstScreen: false, hitTestOk: false }),
        btn('Alle akzeptieren'),
      ]),
      lexicon,
    );
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.reasons).toContain('buttons-truncated');
  });

  it('no-choice-at-first-layer and reject-as-link are also not concluded from an incomplete set', () => {
    expect(classifyFirstLayer(truncated([btn('Einstellungen')], { blocking }), lexicon).reasons).toContain(
      'buttons-truncated',
    );
    expect(
      classifyFirstLayer(
        truncated([btn('Ablehnen', { role: 'link', tag: 'a' }), btn('Alle akzeptieren')]),
        lexicon,
      ).variant,
    ).toBe('banner-not-recognized');
  });

  it('counterexample: the full, untruncated set without a reject keeps nonblocking-no-reject', () => {
    const r = classifyFirstLayer(facts([btn('Alle akzeptieren'), btn('Einstellungen')]), lexicon);
    expect(r.variant).toBe('nonblocking-no-reject');
    expect(r.reasons).not.toContain('buttons-truncated');
  });

  it('counterexample: truncated, but an actionable reject was found → ok with its click target', () => {
    const r = classifyFirstLayer(truncated([btn('Ablehnen'), btn('Alle akzeptieren')]), lexicon);
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
  });

  it('the accept stays a click target of the incomplete set (phase C is not affected)', () => {
    const r = classifyFirstLayer(truncated([btn('Alle akzeptieren'), btn('Einstellungen')]), lexicon);
    expect(r.targets?.accept?.name).toBe('Alle akzeptieren');
  });
});

// : geometry measured during the appearance animation says nothing about reachability.
describe('classifyFirstLayer: unsettled geometry', () => {
  const rejectBelowViewport = (p: { geometryUnsettled?: boolean }): CmpFacts => {
    const f = facts([
      btn('Ablehnen', { actionableAtFirstScreen: false, inViewport: false, visibleAtFirstScreen: false }),
      btn('Alle akzeptieren'),
    ]);
    return { ...f, firstLayer: { ...f.firstLayer, ...p } };
  };

  it('reject outside the viewport while the geometry was unsettled → banner-not-recognized / geometry-unsettled', () => {
    const r = classifyFirstLayer(rejectBelowViewport({ geometryUnsettled: true }), lexicon);
    expect(r.variant).toBe('banner-not-recognized');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('geometry-unsettled');
    expect(r.targets?.reject).toBeNull();
  });

  it('counterexample: a settled container with the reject outside the viewport stays reject-not-actionable', () => {
    for (const geometryUnsettled of [false, undefined]) {
      const r = classifyFirstLayer(rejectBelowViewport({ geometryUnsettled }), lexicon);
      expect(r.variant).toBe('reject-not-actionable');
      expect(r.reasons).toContain('reject-not-actionable:outside-viewport');
    }
  });

  it('unsettled geometry does not touch variants that do not depend on geometry', () => {
    const f = facts([btn('Ablehnen'), btn('Alle akzeptieren')]);
    const r = classifyFirstLayer({ ...f, firstLayer: { ...f.firstLayer, geometryUnsettled: true } }, lexicon);
    expect(r.variant).toBe('ok');
    expect(r.targets?.reject?.name).toBe('Ablehnen');
  });
});

// : the only actionable "accept" is a save-selection button → no accept target (phase C must not click it).
describe('classifyFirstLayer: save-selection button', () => {
  it('a lone "Ausgewählte Cookies akzeptieren" with vendor role save is no accept', () => {
    const r = classifyFirstLayer(
      facts([btn('Ausgewählte Cookies akzeptieren', { vendorRole: 'save' }), btn('Einstellungen')]),
      lexicon,
    );
    expect(r.buttons?.[0]).toMatchObject({ kind: 'save', kindConfidence: 'high' });
    expect(r.acceptAvailableAtFirstLayer).toBe(false);
    expect(r.targets?.accept).toBeNull();
  });

  it('counterexample: "Alle Cookies akzeptieren" next to it is the accept target', () => {
    const r = classifyFirstLayer(
      facts([
        btn('Ausgewählte Cookies akzeptieren', { vendorRole: 'save' }),
        btn('Alle Cookies akzeptieren', { vendorRole: 'accept' }),
      ]),
      lexicon,
    );
    expect(r.acceptAvailableAtFirstLayer).toBe(true);
    expect(r.targets?.accept?.name).toBe('Alle Cookies akzeptieren');
  });
});
