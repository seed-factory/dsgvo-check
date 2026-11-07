/** Recognition confidence (≥ 2 independent signal kinds), version helpers and the state verdict (CONSENT-05). */
import { describe, expect, it } from 'vitest';
import {
  confidenceFromSignals,
  majorSupported,
  originAfterClick,
  outranks,
  signalKinds,
  stateVerdict,
  unchangedDeniedAfterAccept,
  versionFromUrl,
} from '../../../src/cmp/detection.ts';
import type { ConsentStateFact } from '../../../src/cmp/types.ts';

describe('recognition confidence', () => {
  it('high needs two independent kinds', () => {
    expect(confidenceFromSignals(['global:Cookiebot', 'dom:#CybotCookiebotDialog'])).toBe('high');
    expect(confidenceFromSignals(['script:consent.cookiebot.com/uc.js', 'cookie:CookieConsent'])).toBe(
      'high',
    );
  });

  it('several signals of one kind stay one signal → medium', () => {
    expect(confidenceFromSignals(['global:BorlabsCookie', 'global:borlabsCookieConfig'])).toBe('medium');
    expect(confidenceFromSignals(['dom:#BorlabsCookieBox', 'dom:.brlbs-cmpnt-dialog'])).toBe('medium');
  });

  it('cookie and storage are the same kind (stored consent by name)', () => {
    expect([...signalKinds(['cookie:ccm_consent', 'storage:ccm_consent'])]).toEqual(['stored']);
    expect(confidenceFromSignals(['cookie:ccm_consent', 'storage:ccm_consent'])).toBe('medium');
  });

  it('an adapter that requires a banner signal kind recognises nothing from a platform global alone', () => {
    expect(confidenceFromSignals(['global:salesChannelId'], ['dom'])).toBeNull();
    expect(confidenceFromSignals(['global:consentPolicyManager'], ['dom', 'script'])).toBeNull();
    expect(confidenceFromSignals(['dom:.cookie-permission-container'], ['dom'])).toBe('medium');
    expect(
      confidenceFromSignals(['global:salesChannelId', 'dom:.cookie-permission-container'], ['dom']),
    ).toBe('high');
    expect(confidenceFromSignals(['global:consentPolicyManager', 'script:banner'], ['dom', 'script'])).toBe(
      'high',
    );
    expect(confidenceFromSignals(['global:Cookiebot'], [])).toBe('medium');
  });

  it('no signal → null; unknown kinds are ignored', () => {
    expect(confidenceFromSignals([])).toBeNull();
    expect(confidenceFromSignals(['heuristic:dialog', 'heuristic:fixed'])).toBeNull();
  });
});

describe('which adapter detection wins', () => {
  const det = (recognitionConfidence: 'high' | 'medium' | 'low', signals: string[]) => ({
    recognitionConfidence,
    signals,
  });

  it.each([
    ['higher confidence', det('high', ['dom:#a', 'global:a']), det('medium', ['dom:#b']), true],
    ['lower confidence', det('medium', ['dom:#a']), det('high', ['dom:#b', 'global:b']), false],
    // A consent cookie name is shared between vendors (cookieman and Cookiebot both write `CookieConsent`).
    [
      'a page signal against a stored consent only',
      det('medium', ['dom:#a']),
      det('medium', ['cookie:CookieConsent']),
      true,
    ],
    [
      'a stored consent only against a page signal',
      det('medium', ['cookie:CookieConsent']),
      det('medium', ['global:a']),
      false,
    ],
    [
      'two page signals of the same confidence (the earlier adapter stays)',
      det('medium', ['dom:#a']),
      det('medium', ['global:b']),
      false,
    ],
    [
      'the same confidence with stored consent on both sides',
      det('medium', ['cookie:a']),
      det('medium', ['storage:b']),
      false,
    ],
  ] as const)('%s → %s', (_case, a, b, expected) => {
    expect(outranks(a, b)).toBe(expected);
  });
});

describe('version helpers', () => {
  it('reads WordPress ?ver=', () => {
    expect(versionFromUrl('https://x.test/wp-content/plugins/borlabs-cookie/a.js?ver=3.2.1')).toBe('3.2.1');
    expect(versionFromUrl('https://x.test/a.js?ver=abc')).toBeNull();
    expect(versionFromUrl(undefined)).toBeNull();
    expect(versionFromUrl('not a url')).toBeNull();
  });

  // a cache-busting timestamp in `?ver=` is not a plugin version.
  it('a timestamp or a bare counter is not a version; a dotted version is', () => {
    expect(versionFromUrl('https://x.test/c.js?ver=1793004134')).toBeNull();
    expect(versionFromUrl('https://x.test/c.js?ver=1785843825')).toBeNull();
    expect(versionFromUrl('https://x.test/c.js?v=17')).toBeNull();
    expect(versionFromUrl('https://x.test/c.js?ver=7.6.2')).toBe('7.6.2');
    expect(versionFromUrl('https://x.test/c.js?ver=7.5')).toBe('7.5');
    expect(versionFromUrl('https://x.test/c.js?v=2.2.67')).toBe('2.2.67');
  });

  it('major ranges: known in range, known out of range, unknown', () => {
    expect(majorSupported('3.2.1', [2, 3])).toBe(true);
    expect(majorSupported('1.9.8', [2, 3])).toBe(false);
    expect(majorSupported(null, [2, 3])).toBeNull();
  });
});

function st(p: Partial<ConsentStateFact>): ConsentStateFact {
  return {
    source: 'api',
    ready: 'ready',
    categories: { statistics: 'denied', marketing: 'denied' },
    origin: 'action',
    decision: { responded: true, method: 'explicit' },
    ...p,
  };
}

describe('stateVerdict', () => {
  it('reject confirmed: ready, answered, all optional categories denied', () => {
    expect(stateVerdict([st({})], 'reject')).toEqual({
      ok: true,
      methods: ['api:all-denied', 'decision:responded', 'origin:action'],
    });
  });

  // only a positive answer recorded by the CMP confirms a reject; `unknown` or a missing decision does not.
  it('default-denied with an unknown answer is not a confirmed reject', () => {
    const r = stateVerdict(
      [st({ origin: 'default', decision: { responded: 'unknown', method: 'unknown' } })],
      'reject',
    );
    expect(r).toMatchObject({ ok: false, reason: 'api:response-unknown' });
    const rAction = stateVerdict([st({ decision: { responded: 'unknown', method: 'unknown' } })], 'reject');
    expect(rAction).toMatchObject({ ok: false, reason: 'api:response-unknown' });
  });

  it('all denied without any decision fact is not a confirmed reject', () => {
    const { decision: _omit, ...noDecision } = st({});
    expect(stateVerdict([noDecision], 'reject')).toMatchObject({
      ok: false,
      reason: 'api:response-unknown',
    });
    expect(stateVerdict([{ ...noDecision, origin: 'stored' }], 'accept')).toMatchObject({ ok: false });
  });

  it('the state origin must match an answer: default and special-branch never confirm', () => {
    expect(stateVerdict([st({ origin: 'default' })], 'reject')).toMatchObject({
      ok: false,
      reason: 'api:origin-default',
    });
    expect(stateVerdict([st({ origin: 'special-branch' })], 'reject')).toMatchObject({
      ok: false,
      reason: 'api:origin-special-branch',
    });
    expect(stateVerdict([st({ origin: 'stored' })], 'reject')).toMatchObject({ ok: true });
  });

  it('right after our click (same document) only a state changed by the click confirms', () => {
    expect(stateVerdict([st({ origin: 'stored' })], 'reject', { requireAction: true })).toMatchObject({
      ok: false,
      reason: 'api:unchanged-after-click',
    });
    expect(stateVerdict([st({})], 'reject', { requireAction: true }).ok).toBe(true);
  });

  it('a default state with denied categories but no answer is not a confirmed reject', () => {
    const r = stateVerdict(
      [st({ origin: 'default', decision: { responded: false, method: 'unknown' } })],
      'reject',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('api:no-response-recorded');
  });

  it('one granted category → not confirmed', () => {
    const r = stateVerdict([st({ categories: { statistics: 'denied', marketing: 'granted' } })], 'reject');
    expect(r).toMatchObject({ ok: false, reason: 'api:not-all-denied' });
  });

  it('the API wins over the cookie; the cookie is used when there is no API fact', () => {
    const cookie = st({ source: 'cookie', categories: { marketing: 'granted' } });
    expect(stateVerdict([cookie, st({})], 'reject').ok).toBe(true);
    expect(stateVerdict([st({ source: 'cookie' })], 'reject').methods[0]).toBe('cookie:all-denied');
  });

  it('accept: all granted', () => {
    expect(stateVerdict([st({ categories: { a: 'granted', b: 'granted' } })], 'accept').ok).toBe(true);
  });

  it('not ready / no categories → unavailable', () => {
    expect(stateVerdict([st({ ready: 'loading' })], 'reject').reason).toBe('state-unavailable');
    expect(stateVerdict([st({ categories: {} })], 'reject').reason).toBe('no-categories');
    expect(stateVerdict([], 'reject').reason).toBe('state-unavailable');
  });

  // Shopware lists its permission cookies only after an answer: without one, the missing answer is the reason.
  it('no categories and no answer recorded → no response recorded, not merely no categories', () => {
    const unanswered = st({
      source: 'cookie',
      origin: 'default',
      categories: {},
      decision: { responded: false, method: 'unknown' },
    });
    expect(stateVerdict([unanswered], 'reject')).toMatchObject({
      ok: false,
      reason: 'cookie:no-response-recorded',
    });
    const unknown = { ...unanswered, decision: { responded: 'unknown', method: 'unknown' } } as const;
    expect(stateVerdict([unknown], 'reject').reason).toBe('no-categories');
  });
});

// CookieHub cannot list the categories of an installation; a category that stays denied after "accept all"
// may simply not exist there, so it must not turn a working accept into `not-all-granted`.
describe('stateVerdict: categories the CMP does not offer', () => {
  const afterAccept = st({
    categories: { preferences: 'denied', analytics: 'granted', marketing: 'granted' },
  });

  it('without the exclusion one denied category fails the accept (unchanged behaviour)', () => {
    expect(stateVerdict([afterAccept], 'accept')).toMatchObject({ ok: false, reason: 'api:not-all-granted' });
  });

  it('an excluded category does not take part; the exclusion is visible in the methods', () => {
    const r = stateVerdict([afterAccept], 'accept', { ignoreCategories: ['preferences'] });
    expect(r.ok).toBe(true);
    expect(r.methods).toContain('api:all-granted');
    expect(r.methods).toContain('categories-ignored:preferences');
  });

  it('counterexample: a different denied category still fails', () => {
    expect(stateVerdict([afterAccept], 'accept', { ignoreCategories: ['marketing'] })).toMatchObject({
      ok: false,
      reason: 'api:not-all-granted',
    });
  });

  it('nothing left after the exclusion → no verdict', () => {
    const only = st({ categories: { preferences: 'denied' } });
    expect(stateVerdict([only], 'accept', { ignoreCategories: ['preferences'] })).toMatchObject({
      ok: false,
      reason: 'no-categories',
    });
  });

  it('unchangedDeniedAfterAccept: denied before and after, while the click granted another category', () => {
    const before = st({
      origin: 'default',
      decision: { responded: false, method: 'unknown' },
      categories: { preferences: 'denied', analytics: 'denied', marketing: 'denied' },
    });
    expect(unchangedDeniedAfterAccept([before], [afterAccept])).toEqual(['preferences']);
  });

  it('unchangedDeniedAfterAccept: a click that granted nothing excludes nothing (an inert accept stays unverified)', () => {
    const allDenied = st({ categories: { preferences: 'denied', analytics: 'denied', marketing: 'denied' } });
    expect(unchangedDeniedAfterAccept([allDenied], [allDenied])).toEqual([]);
    expect(unchangedDeniedAfterAccept(null, [afterAccept])).toEqual([]);
  });

  // Shopware lists its permission cookies only once the visitor answered: before the click nothing was granted.
  it('unchangedDeniedAfterAccept: a category a state without an answer did not list counts as denied before', () => {
    const unanswered = st({
      source: 'cookie',
      origin: 'default',
      decision: { responded: false, method: 'unknown' },
      categories: {},
    });
    const accepted = st({
      source: 'cookie',
      categories: { 'google-analytics-enabled': 'granted', 'youtube-video': 'denied' },
    });
    expect(unchangedDeniedAfterAccept([unanswered], [accepted])).toEqual(['youtube-video']);
  });

  it.each([
    ['an answer was already recorded', { responded: true, method: 'explicit' }],
    ['the answer was unknown', { responded: 'unknown', method: 'unknown' }],
  ] as const)(
    'counterexample: an unlisted category is not taken as denied before when %s',
    (_c, decision) => {
      const before = st({ source: 'cookie', origin: 'stored', decision, categories: {} });
      const accepted = st({
        source: 'cookie',
        categories: { 'google-analytics-enabled': 'granted', 'youtube-video': 'denied' },
      });
      expect(unchangedDeniedAfterAccept([before], [accepted])).toEqual([]);
    },
  );
});

// Shopware's state lists the permission cookies the adapter knows by name, not every cookie of the installation.
describe('stateVerdict: categories that are known names only', () => {
  const named = (categories: ConsentStateFact['categories']) => st({ source: 'cookie', categories });

  it.each([
    ['reject', 'denied', 'cookie:known-flags-absent'],
    ['accept', 'granted', 'cookie:known-flags-present'],
  ] as const)('a confirmed %s names its basis, not every category', (action, state, method) => {
    const r = stateVerdict([named({ a: state, b: state })], action, { knownFlags: true });
    expect(r.ok).toBe(true);
    expect(r.methods[0]).toBe(method);
    expect(r.methods).not.toContain(`cookie:all-${state}`);
  });

  it('a failed verdict keeps its reason', () => {
    const r = stateVerdict([named({ a: 'denied', b: 'granted' })], 'reject', { knownFlags: true });
    expect(r).toMatchObject({ ok: false, reason: 'cookie:not-all-denied' });
  });

  it('counterexample: without the option the method stays all-denied', () => {
    expect(stateVerdict([named({ a: 'denied' })], 'reject').methods[0]).toBe('cookie:all-denied');
  });
});

describe('originAfterClick (`action` only for an answer the click produced)', () => {
  const preClick = (p: Partial<ConsentStateFact> = {}) =>
    st({ origin: 'default', decision: { responded: false, method: 'unknown' }, ...p });
  const postClick = (p: Partial<ConsentStateFact> = {}) => st({ origin: 'stored', ...p });

  it('answer recorded after the click in the same document → action', () => {
    expect(originAfterClick([postClick()], [preClick()], true)[0]?.origin).toBe('action');
  });

  it('a source that only appeared after the click (consent cookie written) → action', () => {
    expect(originAfterClick([postClick({ source: 'cookie' })], [preClick()], true)[0]?.origin).toBe('action');
  });

  it('no recorded answer (false / unknown / missing) keeps the original origin', () => {
    const unknown = postClick({ origin: 'default', decision: { responded: 'unknown', method: 'unknown' } });
    expect(originAfterClick([unknown], [preClick()], true)[0]?.origin).toBe('default');
    const no = postClick({ origin: 'default', decision: { responded: false, method: 'unknown' } });
    expect(originAfterClick([no], [preClick()], true)[0]?.origin).toBe('default');
    const { decision: _omit, ...missing } = postClick({ origin: 'default' });
    expect(originAfterClick([missing], [preClick()], true)[0]?.origin).toBe('default');
  });

  it('an answer that was already there with the same categories was not produced by the click', () => {
    const answered = preClick({ origin: 'stored', decision: { responded: true, method: 'explicit' } });
    expect(originAfterClick([postClick()], [answered], true)[0]?.origin).toBe('stored');
    const changed = postClick({ categories: { statistics: 'granted', marketing: 'granted' } });
    expect(originAfterClick([changed], [answered], true)[0]?.origin).toBe('action');
  });

  // Shopware's categories are known names only: under an answer from before the click, a changed list proves too little.
  it('newAnswerOnly: an answer recorded before the click stays the CMP own, even with changed categories', () => {
    const answered = preClick({
      source: 'cookie',
      origin: 'stored',
      decision: { responded: true, method: 'explicit' },
      categories: { 'google-analytics-enabled': 'granted' },
    });
    const rejected = postClick({ source: 'cookie', categories: { 'google-analytics-enabled': 'denied' } });

    expect(originAfterClick([rejected], [answered], true)[0]?.origin).toBe('action');
    expect(originAfterClick([rejected], [answered], true, { newAnswerOnly: true })[0]?.origin).toBe('stored');
    const fresh = preClick({ source: 'cookie', categories: {} });
    expect(originAfterClick([rejected], [fresh], true, { newAnswerOnly: true })[0]?.origin).toBe('action');
  });

  it('another document (after any reload) or the special branch keep their origin', () => {
    expect(originAfterClick([postClick()], [preClick()], false)[0]?.origin).toBe('stored');
    const special = postClick({ origin: 'special-branch' });
    expect(originAfterClick([special], [preClick()], true)[0]?.origin).toBe('special-branch');
  });

  it('the verdict over the rewritten state: a working click confirms, a no-op click does not', () => {
    const noop = originAfterClick(
      [st({ origin: 'default', decision: { responded: 'unknown', method: 'unknown' } })],
      [st({ origin: 'default', decision: { responded: 'unknown', method: 'unknown' } })],
      true,
    );
    expect(stateVerdict(noop, 'reject', { requireAction: true }).ok).toBe(false);
    const working = originAfterClick([postClick()], [preClick()], true);
    expect(stateVerdict(working, 'reject', { requireAction: true }).ok).toBe(true);
  });
});
