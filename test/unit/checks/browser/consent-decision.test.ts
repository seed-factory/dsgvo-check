/**
 * Whether a consent decision counts: a reject is confirmed only by CMP state that our click produced and that was read
 * back after the reload, and a decision is in effect on a page unless the facts recorded there after the click show the
 * CMP without an answer or the banner shown again (a consent cookie bound to another host).
 */
import { describe, expect, it } from 'vitest';
import { confirmedReject, decisionInEffect, stateEvidence } from '../../../../src/checks/browser/signals.ts';
import type { CmpFacts, CmpPhaseFacts, ConsentStateFact } from '../../../../src/cmp/types.ts';
import { EvidenceSchema } from '../../../../src/core/report/schema.ts';
import { cmpFacts } from './helpers.ts';

const denied = (origin: ConsentStateFact['origin'], p: Partial<ConsentStateFact> = {}): ConsentStateFact => ({
  source: 'api',
  ready: 'ready',
  categories: { statistics: 'denied', marketing: 'denied' },
  origin,
  decision: { responded: true, method: 'explicit' },
  ...p,
});

const unanswered = (p: Partial<ConsentStateFact> = {}): ConsentStateFact => ({
  source: 'api',
  ready: 'ready',
  categories: { statistics: 'denied', marketing: 'denied' },
  origin: 'default',
  decision: { responded: false, method: 'unknown' },
  ...p,
});

const shown = (visible: boolean) => ({
  bannerPresent: true,
  bannerVisible: visible,
  buttons: [],
  purAbo: false,
  closeMeansAccept: null,
});

/** Phase B with a reject our click produced (`action`) and read back after the reload (`stored`). */
const rejectPhase = (
  p: Partial<CmpPhaseFacts> = {},
  verify: Partial<NonNullable<CmpPhaseFacts['verify']>> = {},
) =>
  ({
    phase: 'B',
    facts: [cmpFacts(), cmpFacts({ moment: 'after-reload', state: [denied('stored')] })],
    click: { action: 'reject', clicked: true, button: null },
    verify: {
      action: 'reject',
      verified: true,
      method: ['api:all-denied', 'persisted-after-reload'],
      stateAfter: [denied('action')],
      persistedAfterReload: true,
      ...verify,
    },
    ...p,
  }) satisfies CmpPhaseFacts;

describe('confirmedReject', () => {
  it('gives the state our click produced and the state read back after the reload', () => {
    expect(confirmedReject(rejectPhase())).toEqual({ action: denied('action'), stored: denied('stored') });
  });

  it('takes the stored state from the verification when the facts after the reload have none', () => {
    const b = rejectPhase(
      { facts: [cmpFacts()] },
      { stateAfter: [denied('action'), denied('stored', { source: 'cookie' })] },
    );
    expect(confirmedReject(b)?.stored).toEqual(denied('stored', { source: 'cookie' }));
  });

  it.each<[string, CmpPhaseFacts | undefined]>([
    ['no phase B', undefined],
    ['an accept', rejectPhase({}, { action: 'accept' })],
    ['a reject the state did not confirm', rejectPhase({}, { verified: false })],
    ['a reject not read back after the reload', rejectPhase({}, { persistedAfterReload: null })],
    ['a reject lost after the reload', rejectPhase({}, { persistedAfterReload: false })],
    ['no state produced by the click', rejectPhase({}, { stateAfter: [denied('stored')] })],
    [
      'a click state that records no answer',
      rejectPhase(
        {},
        { stateAfter: [denied('action', { decision: { responded: false, method: 'unknown' } })] },
      ),
    ],
    ['a click state not ready', rejectPhase({}, { stateAfter: [denied('action', { ready: 'loading' })] })],
    [
      'no stored state anywhere',
      rejectPhase({ facts: [cmpFacts(), cmpFacts({ moment: 'after-reload', state: [denied('default')] })] }),
    ],
  ])('confirms nothing for %s', (_case, b) => {
    expect(confirmedReject(b)).toBeNull();
  });

  it('a decision the CMP reports without the responded flag still counts as recorded', () => {
    const noFlag = denied('action');
    delete noFlag.decision;
    expect(confirmedReject(rejectPhase({}, { stateAfter: [noFlag] }))?.action).toBe(noFlag);
  });
});

describe('stateEvidence', () => {
  it('is consent-state evidence of phase B, with the page only when known', () => {
    const ev = stateEvidence(denied('stored', { scope: 'domain' }), 'https://www.example.test/');
    expect(ev).toEqual({
      type: 'consent-state',
      source: 'api',
      ready: 'ready',
      categories: { statistics: 'denied', marketing: 'denied' },
      origin: 'stored',
      phase: 'B',
      page: 'https://www.example.test/',
      scope: 'domain',
    });
    expect(stateEvidence(denied('action'), null)).not.toHaveProperty('page');
    expect(() => EvidenceSchema.parse({ id: 'ev-1', ...ev })).not.toThrow();
  });
});

describe('decisionInEffect', () => {
  const KONTAKT = 'https://www.example.test/kontakt/';
  const control = (p: Partial<CmpFacts>) =>
    cmpFacts({ moment: 'control-page', pageUrl: KONTAKT, firstLayer: shown(false), ...p });

  it.each<[string, boolean, CmpFacts[]]>([
    ['the stored reject on a control page', true, [control({ state: [denied('stored')] })]],
    ['a control page where the CMP reports no answer', false, [control({ state: [unanswered()] })]],
    [
      'a control page that shows the banner again',
      false,
      [control({ state: [denied('stored')], firstLayer: shown(true) })],
    ],
    [
      'counterexample: a control page on another host with the stored reject (consent shared by a domain cookie)',
      true,
      [control({ pageUrl: 'https://shop.example.test/', state: [denied('stored')] })],
    ],
    [
      'one source without an answer next to one with the stored reject',
      false,
      [control({ state: [denied('stored', { source: 'cookie' }), unanswered()] })],
    ],
    [
      'a CMP still loading whose adapter found no consent cookie',
      false,
      [control({ state: [unanswered({ ready: 'loading', categories: {} })] })],
    ],
    [
      'a CMP that cannot tell whether it was answered',
      true,
      [
        control({
          state: [unanswered({ ready: 'loading', decision: { responded: 'unknown', method: 'unknown' } })],
        }),
      ],
    ],
    ['a page without facts after the click', true, []],
    [
      'the first screen before the click, where the banner is visible by design',
      true,
      [cmpFacts({ firstLayer: shown(true), state: [unanswered()] })],
    ],
    [
      'the start page: the fact after the reload decides, not the closing banner right after the click',
      true,
      [
        cmpFacts({ firstLayer: shown(true), state: [unanswered()] }),
        cmpFacts({ moment: 'after-click', firstLayer: shown(true), state: [denied('action')] }),
        cmpFacts({ moment: 'after-reload', firstLayer: shown(false), state: [denied('stored')] }),
      ],
    ],
    [
      'the start page that shows the banner again after the reload',
      false,
      [
        cmpFacts({ moment: 'after-click', firstLayer: shown(false), state: [denied('action')] }),
        cmpFacts({ moment: 'after-reload', firstLayer: shown(true), state: [unanswered()] }),
      ],
    ],
  ])('phase B: %s → %s', (_case, inEffect, facts) => {
    expect(decisionInEffect(facts, 'B')).toBe(inEffect);
  });

  it('reads only the facts of the given phase', () => {
    const facts = [
      control({ phase: 'C', state: [unanswered()], firstLayer: shown(true) }),
      control({ state: [denied('stored')] }),
    ];
    expect(decisionInEffect(facts, 'B')).toBe(true);
    expect(decisionInEffect(facts, 'C')).toBe(false);
  });
});
