import { describe, expect, it } from 'vitest';
import { consent05 } from '../../../../src/checks/browser/consent-05.ts';
import type { CmpPhaseFacts } from '../../../../src/cmp/types.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { click, cmpFacts, cmpWith, cookie, phase, req, site } from './helpers.ts';
import { SCENARIOS } from './scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['CONSENT-05']!.find((s) => s.file === file)!.build();

type State = NonNullable<CmpPhaseFacts['verify']>['stateAfter'][number];
const decided = { responded: true, method: 'explicit' } as const;
/** State our click produced (same document) and the persisted state read after the reload (03-checks §4 steps 3–4). */
const ACTION: State = {
  source: 'api',
  ready: 'ready',
  categories: { statistics: 'denied' },
  origin: 'action',
  decision: decided,
};
const STORED: State = { ...ACTION, origin: 'stored' };

const rejectB = (
  verify: Partial<NonNullable<CmpPhaseFacts['verify']>> = {},
  facts: CmpPhaseFacts['facts'] = [cmpFacts()],
): CmpPhaseFacts => ({
  phase: 'B',
  facts,
  click: { action: 'reject', clicked: true, button: null },
  verify: {
    action: 'reject',
    verified: true,
    method: ['api:all-denied', 'persisted-after-reload'],
    stateAfter: [ACTION, STORED],
    persistedAfterReload: true,
    ...verify,
  },
});

const runB = (
  requests = [] as ReturnType<typeof req>[],
  extra: Partial<Parameters<typeof phase>[1]> = {},
  cmp = cmpWith(rejectB()),
  knownGaps: string[] = [],
) =>
  runCheck(
    consent05,
    site({
      phases: [phase('A'), phase('B', { click: click('reject'), requests, ...extra })],
      cmp,
      knownGaps,
    }),
  );

const gaAfter = (id: string, p = {}) =>
  req(id, 'https://www.google-analytics.com/g/collect?v=2&cid=[redacted]&en=page_view', {
    phase: 'B',
    afterClick: true,
    resourceType: 'ping',
    identifierPresent: true,
    identifierNames: ['cid'],
    ...p,
  });

describe('CONSENT-05 after a confirmed reject', () => {
  it('violation: GA4 hit with identifier after the click', () => {
    const r = runCheck(consent05, scenario('violation-tracking-after-reject.json'));
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'tracking-after-reject',
      subject: 'google-analytics',
      phases: ['B'],
      params: { service: 'Google Analytics', host: 'region1.google-analytics.com' },
    });
  });

  it('clean: only consent update after the click; a request started before the click is not new', () => {
    expect(variantsOf(runCheck(consent05, scenario('clean-confirmed-reject.json')))).toEqual([]);
  });

  it('inconclusive: reject not confirmed by CMP state', () => {
    expect(runCheck(consent05, scenario('inconclusive-reject-not-confirmed.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
  });

  it('counterexample: request started before the click and completed after it is not counted', () => {
    expect(variantsOf(runB([gaAfter('b', { afterClick: false })]))).toEqual([]);
  });

  it('storage: a tracking cookie accepted after the click (even from an older request) → storage-after-reject', () => {
    const r = runB([], {
      cookies: [cookie('_ga', { phase: 'B', afterClick: true, setter: 'http-response' })],
    });
    expect(observationsOf(r).map((o) => [o.variant, o.params.name])).toEqual([
      ['tracking-after-reject', '_ga'],
    ]);
  });

  it('cookieless ping with denied state → cookieless-ping-after-reject (warning)', () => {
    const r = runB([
      gaAfter('b', { url: 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]' }),
    ]);
    expect(variantsOf(r)).toEqual(['cookieless-ping-after-reject']);
  });

  it('a hit and a cookieless ping of one service give one request finding (strongest wins)', () => {
    const r = runB([
      gaAfter('b'),
      gaAfter('c', { url: 'https://www.google-analytics.com/g/collect?gcs=G100' }),
    ]);
    expect(observationsOf(r).map((o) => o.variant)).toEqual(['tracking-after-reject']);
  });

  it('default-denied only is not a reject; no click; phase B missing → inconclusive', () => {
    const def = runB(
      [gaAfter('b')],
      {},
      cmpWith(
        rejectB({
          stateAfter: [
            { source: 'api', ready: 'ready', categories: { statistics: 'denied' }, origin: 'default' },
          ],
        }),
      ),
    );
    expect(def).toMatchObject({ status: 'inconclusive', reason: 'reject-not-confirmed' });
    const noClick = runB([], {}, cmpWith({ phase: 'B', facts: [cmpFacts()] }));
    expect(noClick).toMatchObject({ status: 'inconclusive', reason: 'no-reject-click' });
    const noB = runCheck(consent05, site({ phases: [phase('A')] }));
    expect(noB).toMatchObject({ status: 'inconclusive', reason: 'phase-b-missing' });
  });

  it('not persisted after reload → not confirmed', () => {
    expect(runB([gaAfter('b')], {}, cmpWith(rejectB({ persistedAfterReload: false })))).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
  });

  it('reload skipped by the time budget (persistence unknown) → reject not confirmed, no finding', () => {
    const r = runB(
      [gaAfter('b')],
      {},
      cmpWith(rejectB({ persistedAfterReload: null, stateAfter: [ACTION], method: ['api:all-denied'] })),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'reject-not-confirmed' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('no state produced by our click (only a stored state) → reject not confirmed', () => {
    const r = runB([gaAfter('b')], {}, cmpWith(rejectB({ stateAfter: [STORED] })));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'reject-not-confirmed' });
  });

  it('the action state must record the user decision (responded false → not confirmed)', () => {
    const r = runB(
      [gaAfter('b')],
      {},
      cmpWith(
        rejectB({ stateAfter: [{ ...ACTION, decision: { responded: false, method: 'unknown' } }, STORED] }),
      ),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'reject-not-confirmed' });
  });

  it('persisted flag without any stored state read after the reload → reject not confirmed', () => {
    const r = runB([gaAfter('b')], {}, cmpWith(rejectB({ stateAfter: [ACTION] })));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'reject-not-confirmed' });
  });

  it('the stored state may come from the CMP facts read after the reload', () => {
    const afterReload = cmpFacts({ moment: 'after-reload', state: [STORED] });
    const r = runB([gaAfter('b')], {}, cmpWith(rejectB({ stateAfter: [ACTION] }, [cmpFacts(), afterReload])));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['tracking-after-reject']);
  });

  it('pagehide capture unavailable → inconclusive (pagehide-capture-unavailable), established findings kept', () => {
    const none = runB([], {}, cmpWith(rejectB()), ['pagehide-beacons']);
    expect(none).toMatchObject({ status: 'inconclusive', reason: 'pagehide-capture-unavailable' });
    expect(none.outcome?.limitations).toContain('pagehide-capture-unavailable');
    const r = runB(
      [gaAfter('b', { url: 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]' })],
      {},
      cmpWith(rejectB()),
      ['pagehide-beacons'],
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'pagehide-capture-unavailable' });
    expect(r.outcome?.limitations).toContain('pagehide-capture-unavailable');
    expect(variantsOf(r)).toEqual(['cookieless-ping-after-reject']);
  });

  it('Consent Mode denied does not hide a stored identifier match after the reject → tracking-after-reject', () => {
    const r = runB([
      gaAfter('b', {
        url: 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]',
        matchesStoredIdentifier: true,
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.kind])).toEqual([
      ['tracking-after-reject', 'request'],
    ]);
  });

  it('a per-load identifier after the reject is no persistent identifier → cookieless-ping-after-reject', () => {
    const r = runB([
      req('b', 'https://in.hotjar.com/api/v2/client', {
        phase: 'B',
        afterClick: true,
        resourceType: 'xhr',
        identifierPresent: true,
        identifierNames: ['uuid'],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.consentModeDenied])).toEqual([
      ['cookieless-ping-after-reject', false],
    ]);
  });

  it.each(['rejected', 'attempted'] as const)(
    'a tracking cookie %s by the browser after the reject is no storage finding',
    (state) => {
      const r = runB([], {
        cookies: [
          cookie('_ga', { phase: 'B', afterClick: true, state, blockedReasons: ['ThirdPartyPhaseout'] }),
        ],
      });
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual([]);
    },
  );

  it('storage and a hit of one service give one finding; the request branch of the text is selected', () => {
    const storageOnly = runB([], { cookies: [cookie('_ga', { phase: 'B', afterClick: true })] });
    expect(observationsOf(storageOnly).map((o) => o.params.kind)).toEqual(['storage']);
    const both = runB([gaAfter('b')], { cookies: [cookie('_ga', { phase: 'B', afterClick: true })] });
    expect(observationsOf(both).map((o) => [o.variant, o.params.kind, o.params.name])).toEqual([
      ['tracking-after-reject', 'request', '_ga'],
    ]);
  });

  it('library loads and consent-provider requests after reject are no findings', () => {
    const r = runB([
      req('b', 'https://www.googletagmanager.com/gtag/js?id=G-1', { phase: 'B', afterClick: true }),
      req('c', 'https://consentcdn.cookiebot.com/sdk/bc-v4.min.html', {
        phase: 'B',
        afterClick: true,
        identifierPresent: true,
      }),
    ]);
    expect(variantsOf(r)).toEqual([]);
  });
});
