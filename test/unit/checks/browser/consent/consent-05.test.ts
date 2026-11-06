import { describe, expect, it } from 'vitest';
import { consent05 } from '../../../../../src/checks/browser/consent-05.ts';
import { MAX_EVIDENCE } from '../../../../../src/checks/browser/evidence.ts';
import type { CmpPhaseFacts } from '../../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import { observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  cmpFacts,
  cmpWith,
  consentPages,
  controlPageFacts,
  cookie,
  page,
  phase,
  req,
  SHOP_HOST,
  START,
  settingsRejectCmp,
  settingsRejectPlan,
  site,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['CONSENT-05']!.find((s) => s.file === file)!.build();

type State = NonNullable<CmpPhaseFacts['verify']>['stateAfter'][number];
const decided = { responded: true, method: 'explicit' } as const;
/** State our click produced (same document) and the persisted state read after the reload. */
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

  it('a Shopware reject confirmed from the cookie source: Google Ads with its cookie, GA4 cookieless, the state as proof', () => {
    const r = runCheck(consent05, scenario('violation-shopware-known-flags-absent.json'));

    expect(observationsOf(r).map((o) => [o.subject, o.variant, o.params.kind, o.params.name])).toEqual([
      ['google-ads', 'tracking-after-reject', 'both', '_gcl_au'],
      ['google-analytics', 'cookieless-ping-after-reject', 'request', null],
    ]);
    const proof = observationsOf(r)[0]?.evidence.filter((e) => e.type === 'consent-state');
    expect(proof).toMatchObject([
      { source: 'cookie', origin: 'action', categories: { 'google-ads-enabled': 'denied' } },
      { source: 'cookie', origin: 'stored', categories: { 'google-ads-enabled': 'denied' } },
    ]);
  });

  it('counterexample: a Shopware reject that left a known permission cookie set is not confirmed, no finding', () => {
    const r = runCheck(consent05, scenario('inconclusive-shopware-known-flag-set-by-reject.json'));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'reject-not-confirmed' });
    expect(observationsOf(r)).toEqual([]);
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
    const noB = runCheck(
      consent05,
      site({ phases: [phase('A')], cmp: cmpWith({ phase: 'A', facts: [cmpFacts({ phase: 'A' })] }) }),
    );
    expect(noB).toMatchObject({ status: 'inconclusive', reason: 'phase-b-missing' });
  });

  it('no banner on any page: nothing to reject, so not applicable rather than inconclusive', () => {
    const r = runCheck(consent05, site({ phases: [phase('A'), phase('B', { requests: [gaAfter('b')] })] }));
    expect(r).toMatchObject({ status: 'not_applicable', reason: 'no-banner' });
    expect(observationsOf(r)).toEqual([]);
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

  it('storage and a hit of one service give one finding whose text names both', () => {
    const storageOnly = runB([], { cookies: [cookie('_ga', { phase: 'B', afterClick: true })] });
    expect(observationsOf(storageOnly).map((o) => o.params.kind)).toEqual(['storage']);
    const requestOnly = runB([gaAfter('b')]);
    expect(observationsOf(requestOnly).map((o) => o.params.kind)).toEqual(['request']);
    const both = runB([gaAfter('b')], { cookies: [cookie('_ga', { phase: 'B', afterClick: true })] });
    expect(observationsOf(both).map((o) => [o.variant, o.params.kind, o.params.name])).toEqual([
      ['tracking-after-reject', 'both', '_ga'],
    ]);
  });

  it('keeps places for the storage writes in the evidence next to many requests', () => {
    const hits = Array.from({ length: 12 }, (_, i) =>
      gaAfter(`b${i}`, { url: `https://www.google-analytics.com/g/collect?v=2&cid=[redacted]&_p=${i}` }),
    );
    const r = runB(hits, { cookies: [cookie('_ga', { phase: 'B', afterClick: true })] });
    const [o] = observationsOf(r);
    expect(o!.evidence.filter((e) => e.type === 'cookie')).toHaveLength(1);
    expect(o!.params.requestCount).toBe(12);
  });

  it('a persistent identifier after many cookieless hits of the service: its host is named and it leads the evidence', () => {
    const adsAfter = (id: string, url: string, p = {}) =>
      req(id, url, { phase: 'B', afterClick: true, resourceType: 'image', ...p });
    const cookieless = Array.from({ length: 12 }, (_, i) =>
      adsAfter(`b${i}`, `https://www.googleadservices.com/pagead/conversion/123/?gcs=G100&_p=${i}`),
    );
    const persistent = adsAfter('p', 'https://ad.doubleclick.net/ccm/collect?auid=[redacted]', {
      identifierPresent: true,
      identifierNames: ['auid'],
    });
    const [o] = observationsOf(runB([...cookieless, persistent]));
    expect(o).toMatchObject({
      variant: 'tracking-after-reject',
      subject: 'google-ads',
      params: { kind: 'request', host: 'ad.doubleclick.net', requestCount: 13 },
    });
    const requests = o!.evidence.filter((e) => e.type === 'request');
    expect(requests).toHaveLength(MAX_EVIDENCE);
    expect(requests[0]).toMatchObject({
      url: 'https://ad.doubleclick.net/ccm/collect?auid=[redacted]',
      features: { identifier: { kind: 'persistent-param' } },
    });
  });

  it('counterexample: only cookieless hits keep the host of the first one', () => {
    const [o] = observationsOf(
      runB([
        gaAfter('b', { url: 'https://region1.google-analytics.com/g/collect?v=2&gcs=G100' }),
        gaAfter('c', { url: 'https://www.google-analytics.com/g/collect?v=2&gcs=G100' }),
      ]),
    );
    expect(o).toMatchObject({
      variant: 'cookieless-ping-after-reject',
      params: { host: 'region1.google-analytics.com' },
    });
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

describe('CONSENT-05 on the control pages after the reject', () => {
  const OTHER = `${SHOP_HOST}/kontakt`;
  /** The reject of `rejectB`, with the facts read on the control pages; `hits` are GA page_views on these pages. */
  const runControl = (
    control: Array<[string, boolean]>,
    hits: string[],
    extra: Partial<Parameters<typeof phase>[1]> = {},
    knownGaps: string[] = [],
  ) =>
    runCheck(
      consent05,
      site({
        phases: [
          phase('A'),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            pages: consentPages(
              'B',
              control.map(([url]) => url),
            ),
            requests: hits.map((pageUrl, i) => gaAfter(`b${i}`, { pageUrl })),
            ...extra,
          }),
        ],
        cmp: cmpWith(
          rejectB({}, [
            cmpFacts(),
            ...control.map(([url, inEffect]) => controlPageFacts(url, 'B', inEffect)),
          ]),
        ),
        knownGaps,
      }),
    );

  it('violation: GA4 with identifier on a control page that reads the stored reject back', () => {
    const r = runCheck(consent05, scenario('violation-tracking-on-control-page-after-reject.json'));
    expect(r).toMatchObject({ status: 'completed', outcome: { limitations: [] } });
    expect(observationsOf(r).map((o) => [o.variant, o.pages])).toEqual([
      ['tracking-after-reject', [CONTACT]],
    ]);
    // Reload and contact page: both after the reject.
    expect(r.outcome?.coverage).toEqual({ observed: 3, evaluated: 2 });
  });

  it('a control page that shows the banner again without an answer: its hit is no finding, the page is not evaluated', () => {
    const r = runCheck(consent05, scenario('inconclusive-reject-not-in-effect-on-control-page.json'));
    expect(r).toMatchObject({ status: 'partial', outcome: { limitations: ['reject-not-in-effect'] } });
    expect(observationsOf(r)).toEqual([]);
    // Start page, reload, contact page and the page on the other host; the last one is left out.
    expect(r.outcome?.coverage).toEqual({ observed: 4, evaluated: 2 });
  });

  it('clean: control pages with the stored reject and no request give a completed result over every page', () => {
    const r = runCheck(consent05, scenario('clean-control-pages-after-reject.json'));
    expect(r).toMatchObject({
      status: 'completed',
      outcome: { limitations: [], coverage: { evaluated: 3 } },
    });
    expect(observationsOf(r)).toEqual([]);
  });

  it('counterexample: a control page on another host with the stored reject (shared consent cookie) still counts', () => {
    const r = runCheck(consent05, scenario('violation-tracking-on-other-host-with-shared-reject.json'));
    expect(r).toMatchObject({ status: 'completed', outcome: { limitations: [] } });
    expect(observationsOf(r).map((o) => [o.variant, o.pages])).toEqual([['tracking-after-reject', [OTHER]]]);
  });

  it('the hits of the pages where the reject is in effect remain, those of the other page are left out', () => {
    const r = runControl(
      [
        [CONTACT, true],
        [OTHER, false],
      ],
      [START, CONTACT, OTHER, OTHER],
    );
    expect(r.status).toBe('partial');
    expect(observationsOf(r).map((o) => [o.variant, o.pages, o.params.requestCount])).toEqual([
      ['tracking-after-reject', [START, CONTACT], 2],
    ]);
  });

  it('a tracking cookie written on a page without the reject is no storage finding', () => {
    const r = runControl([[OTHER, false]], [], {
      cookies: [cookie('_ga', { phase: 'B', afterClick: true, pageUrl: OTHER })],
    });
    expect(r).toMatchObject({ status: 'partial', outcome: { limitations: ['reject-not-in-effect'] } });
    expect(observationsOf(r)).toEqual([]);
  });

  it('counterexample: the same cookie on a page with the stored reject is tracking after the reject', () => {
    const r = runControl([[OTHER, true]], [], {
      cookies: [cookie('_ga', { phase: 'B', afterClick: true, pageUrl: OTHER })],
    });
    expect(observationsOf(r).map((o) => [o.variant, o.params.kind, o.params.name])).toEqual([
      ['tracking-after-reject', 'storage', '_ga'],
    ]);
  });

  it('without the page-exit capture the result stays inconclusive and names both limitations', () => {
    const r = runControl([[OTHER, false]], [OTHER], {}, ['pagehide-beacons']);
    expect(r).toMatchObject({
      status: 'inconclusive',
      reason: 'pagehide-capture-unavailable',
      outcome: { limitations: ['pagehide-capture-unavailable', 'reject-not-in-effect'] },
    });
    expect(observationsOf(r)).toEqual([]);
  });

  it('a page without the reject that was not evaluable anyway is left out once', () => {
    const r = runControl([[OTHER, false]], [], {
      pages: [
        ...consentPages('B', []),
        page(OTHER, 'nav', 'B', { order: 1, evaluable: false, notEvaluableReason: 'challenge' }),
      ],
    });
    expect(r.outcome?.coverage).toEqual({ observed: 3, evaluated: 1 });
  });
});

describe('CONSENT-05 after a reject saved in the settings layer of a first layer without reject', () => {
  const settingsScenario = (file: string) => runCheck(consent05, scenario(file));
  const title = (lang: 'de' | 'en', params: Record<string, unknown>) =>
    renderMessage(loadTexts(lang), 'CONSENT-05.tracking-after-reject', params as never).title;

  it('tracking after the confirmed save is tracking-after-reject that names the settings path', () => {
    const [o] = observationsOf(settingsScenario('violation-tracking-after-settings-reject.json'));
    expect(o).toMatchObject({
      variant: 'tracking-after-reject',
      params: { kind: 'request', rejectPath: 'settings' },
    });
    expect(o?.evidence.filter((e) => e.type === 'consent-state').map((e) => e.origin)).toEqual([
      'action',
      'stored',
    ]);
    expect(title('de', o!.params)).toBe(
      'Anfragen mit dauerhafter Kennung nach bestätigter Ablehnung über die Einstellungen: Google Analytics',
    );
    expect(title('en', o!.params)).toBe(
      'Requests with a persistent identifier after a confirmed rejection via the settings: Google Analytics',
    );
    expect(renderMessage(loadTexts('de'), 'CONSENT-05.tracking-after-reject', o!.params).body).toContain(
      'Die erste Ebene des Einwilligungsbanners bot keine Ablehnung; abgelehnt wurde in den Einstellungen',
    );
  });

  it('counterexample: a first-layer reject names its own path and keeps the earlier wording', () => {
    const [o] = observationsOf(runB([gaAfter('B-1')]));
    expect(o?.params.rejectPath).toBe('first-layer');
    expect(title('de', o!.params)).toBe(
      'Anfragen mit dauerhafter Kennung nach bestätigter Ablehnung: Google Analytics',
    );
    expect(renderMessage(loadTexts('de'), 'CONSENT-05.tracking-after-reject', o!.params).body).not.toContain(
      'Einstellungen',
    );
  });

  it('a save the platform policy left at its default is no confirmed reject: reject-not-confirmed', () => {
    expect(settingsScenario('inconclusive-settings-reject-not-confirmed.json')).toMatchObject({
      status: 'inconclusive',
      reason: 'reject-not-confirmed',
    });
  });

  it.each([
    'preselected-groups',
    'settings-groups-unreadable',
    'settings-not-opened',
    'settings-layer-ambiguous',
    'settings-save-not-found',
    'settings-control-not-found',
  ])('nothing saved (%s): no reject click, the reason is a limitation with words', (reason) => {
    const r = runCheck(
      consent05,
      site({
        phases: [phase('A'), phase('B', { requests: [gaAfter('B-1', { afterClick: false })] })],
        cmp: settingsRejectCmp({ pressed: false }),
        plan: settingsRejectPlan(reason),
      }),
    );
    expect(r).toMatchObject({
      status: 'inconclusive',
      reason: 'no-reject-click',
      outcome: { limitations: [reason] },
    });
    expect(observationsOf(r)).toEqual([]);
    for (const lang of ['de', 'en'] as const) {
      const text = formatMessage(loadTexts(lang).ui['report.checkLimitation']!.text, { code: reason }, lang);
      expect(text, `${lang}: ${reason}`).not.toBe('');
    }
  });

  it('a save core chose whose click did not go through: no reject click, settings-save-failed with words', () => {
    const failed = settingsRejectCmp({ pressed: false });
    failed.phases[0]!.click = {
      action: 'reject',
      clicked: false,
      button: { name: 'Speichern', role: 'button', kind: 'reject', kindConfidence: 'high' },
      error: 'target-not-found',
      path: 'settings',
    };
    const r = runCheck(
      consent05,
      site({ phases: [phase('A'), phase('B')], cmp: failed, plan: settingsRejectPlan() }),
    );
    expect(r).toMatchObject({
      status: 'inconclusive',
      reason: 'no-reject-click',
      outcome: { limitations: ['settings-save-failed'] },
    });
    for (const lang of ['de', 'en'] as const) {
      const ui = loadTexts(lang).ui['report.checkLimitation']!.text;
      expect(formatMessage(ui, { code: 'settings-save-failed' }, lang)).not.toBe('');
    }
  });

  it('counterexample: a first layer without reject and no settings layer tried keeps the bare no-reject-click', () => {
    const r = runCheck(
      consent05,
      site({
        phases: [phase('A'), phase('B')],
        cmp: cmpWith({
          phase: 'B',
          facts: [cmpFacts()],
          click: { action: 'reject', clicked: false, button: null },
        }),
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'no-reject-click' });
    expect(r.outcome?.limitations ?? []).toEqual([]);
  });
});
