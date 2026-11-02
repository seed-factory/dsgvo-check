/** : recognition confidence (≥ 2 independent signal kinds), version helpers and the state verdict (CONSENT-05). */
import { describe, expect, it } from 'vitest';
import {
  confidenceFromSignals,
  majorSupported,
  originAfterClick,
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

  it('no signal → null; unknown kinds are ignored', () => {
    expect(confidenceFromSignals([])).toBeNull();
    expect(confidenceFromSignals(['heuristic:dialog', 'heuristic:fixed'])).toBeNull();
  });
});

describe('version helpers', () => {
  it('reads WordPress ?ver=', () => {
    expect(versionFromUrl('https://x.test/wp-content/plugins/borlabs-cookie/a.js?ver=3.2.1')).toBe('3.2.1');
    expect(versionFromUrl('https://x.test/a.js?ver=abc')).toBeNull();
    expect(versionFromUrl(undefined)).toBeNull();
    expect(versionFromUrl('not a url')).toBeNull();
  });

  // : a cache-busting timestamp in `?ver=` is not a plugin version.
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

  // : only a positive answer recorded by the CMP confirms a reject; `unknown` or a missing decision does not.
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
});

// : CookieHub cannot list the categories of an installation; a category that stays denied after "accept all"
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
