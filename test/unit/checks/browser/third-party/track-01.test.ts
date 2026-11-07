import { describe, expect, it } from 'vitest';
import { track01 } from '../../../../../src/checks/browser/track-01.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import type { Observation } from '../../../../../src/core/evaluation/check.ts';
import type { CookieRecord, RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { named } from '../../../../utils/named-rows.ts';
import { observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  click,
  cmpFacts,
  cmpWith,
  consentPages,
  controlPageFacts,
  cookie,
  phase,
  req,
  SHOP_HOST,
  START,
  site,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['TRACK-01']!.find((s) => s.file === file)!.build();

describe('TRACK-01 inventory', () => {
  it('violation: GA4 loaded and page_view sent before interaction → event-sent', () => {
    const [o] = observationsOf(runCheck(track01, scenario('violation-ga4-event-sent.json')));
    expect(o).toMatchObject({
      variant: 'service-inventory',
      subject: 'google-analytics',
      serviceId: 'google-analytics',
      params: { stage: 'event-sent', beforeInteraction: true, afterReject: false, afterAccept: false },
    });
  });

  it('counterexample: GTM container without tags → only "loaded"; GA only after accept stays info with timing', () => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', { requests: [req('a', 'https://www.googletagmanager.com/gtm.js?id=GTM-1')] }),
          phase('C', {
            click: click('accept'),
            requests: [
              req('c', 'https://www.google-analytics.com/g/collect?v=2&cid=[redacted]', {
                phase: 'C',
                afterClick: true,
                resourceType: 'ping',
              }),
            ],
          }),
        ],
      }),
    );
    expect(
      observationsOf(r).map((o) => [
        o.subject,
        o.params.stage,
        o.params.beforeInteraction,
        o.params.afterAccept,
      ]),
    ).toEqual([
      ['google-analytics', 'event-sent', false, true],
      ['google-tag-manager', 'loaded', true, false],
    ]);
  });

  const gamDictionary = req('a', 'https://securepubads.g.doubleclick.net/pagead/managed/dict/abc/def', {
    resourceType: 'other',
  });

  // Each row lists every inventory entry of phase A in order, so their number is asserted as well.
  const INVENTORY_CASES: Array<{
    name: string;
    requests: RequestRecord[];
    cookies?: CookieRecord[];
    expected: Array<Partial<Observation>>;
  }> = [
    {
      name: 'the GAM compression dictionary (resourceType other) proves only "loaded"',
      requests: [gamDictionary],
      expected: [{ subject: 'google-ad-manager', params: { stage: 'loaded' } }],
    },
    {
      name: 'counterexample: a fetch ad request next to the GAM dictionary proves event-sent',
      requests: [
        gamDictionary,
        req('b', 'https://securepubads.g.doubleclick.net/gampad/ads?iu=x', { resourceType: 'fetch' }),
      ],
      expected: [{ subject: 'google-ad-manager', params: { stage: 'event-sent' } }],
    },
    {
      name: 'Piano identity, experience and checkout calls prove "loaded" only',
      requests: [
        req('a', 'https://id.piano.io/api/v1/identity/login/token?aid=x', { resourceType: 'xhr' }),
        req('b', 'https://experience.piano.io/xbuilder/experience/execute', { resourceType: 'fetch' }),
        req('c', 'https://buy.piano.io/checkout/offer/show', { resourceType: 'fetch' }),
      ],
      expected: [{ subject: 'piano', params: { stage: 'loaded', stageBeforeInteraction: 'loaded' } }],
    },
    {
      name: 'counterexample: the Piano engagement ping proves event-sent',
      requests: [req('d', 'https://c2.piano.io/page/track/engagement', { resourceType: 'xhr' })],
      expected: [{ subject: 'piano', params: { stageBeforeInteraction: 'event-sent' } }],
    },
    {
      name: 'an `other` request on a path without a signature proves "loaded" only',
      requests: [req('a', 'https://securepubads.g.doubleclick.net/pcs/anything', { resourceType: 'other' })],
      expected: [
        { subject: 'google-ad-manager', params: { stage: 'loaded', stageBeforeInteraction: 'loaded' } },
      ],
    },
    {
      name: 'Chartbeat ping and ScorecardResearch beacon prove event-sent',
      requests: [
        req('a', 'https://ping.chartbeat.net/ping?h=example.de&p=%2F', { resourceType: 'image' }),
        req('b', 'https://sb.scorecardresearch.com/b?c1=2&c2=1000', { resourceType: 'image' }),
      ],
      expected: [
        { subject: 'chartbeat', params: { stageBeforeInteraction: 'event-sent' } },
        { subject: 'scorecardresearch', params: { stageBeforeInteraction: 'event-sent' } },
      ],
    },
    {
      name: 'counterexample: the Tealium library and a Chartbeat strategy call prove "loaded"',
      requests: [
        req('c', 'https://tags.tiqcdn.com/utag/acme/main/prod/utag.js', { resourceType: 'script' }),
        req('d', 'https://mab.chartbeat.com/mab_strategy/example.de/', { resourceType: 'xhr' }),
      ],
      expected: [
        { subject: 'chartbeat', params: { stageBeforeInteraction: 'loaded' } },
        { subject: 'tealium', params: { stageBeforeInteraction: 'loaded' } },
      ],
    },
    {
      name: 'a tracking cookie of the service proves "initialised"',
      requests: [req('a', 'https://connect.facebook.net/en_US/fbevents.js')],
      cookies: [cookie('_fbp')],
      expected: [{ params: { service: 'Meta Pixel', stage: 'initialised' } }],
    },
    {
      name: 'a hit whose response arrived before a body error still proves event-sent; SW/cache answers count as loaded',
      requests: [
        req('a', 'https://www.google-analytics.com/g/collect?v=2&tid=G-1', {
          resourceType: 'ping',
          state: 'failed',
          status: 204,
          delivery: 'sent',
          result: { kind: 'failed', errorText: 'net::ERR_ABORTED' },
        }),
        req('b', 'https://static.hotjar.com/c/hotjar-1.js', { state: 'from-sw', status: undefined }),
      ],
      expected: [
        { subject: 'google-analytics', params: { stage: 'event-sent' } },
        { subject: 'hotjar', params: { stage: 'loaded' } },
      ],
    },
    {
      name: 'failed requests and non-tracking categories are not inventory; first-party proxy has medium confidence',
      requests: [
        req('a', 'https://static.hotjar.com/c/hotjar-1.js', { state: 'failed' }),
        req('b', 'https://fonts.googleapis.com/css2?family=X', { resourceType: 'stylesheet' }),
        req('c', `${START}g/collect?v=2&tid=G-1`, { resourceType: 'ping' }),
      ],
      expected: [{ subject: 'google-analytics', confidence: 'medium', params: { firstPartyProxy: true } }],
    },
  ];
  it.each(named(INVENTORY_CASES))('%s', (_name, { requests, cookies = [], expected }) => {
    expect(
      observationsOf(runCheck(track01, site({ phases: [phase('A', { requests, cookies })] }))),
    ).toMatchObject(expected);
  });

  it.each([
    [
      'blocked-by-browser (CSP / browser block)',
      { state: 'blocked-by-browser', delivery: 'blocked-by-browser' },
    ],
    ['attempted without any response (aborted)', { state: 'attempted', delivery: 'attempted' }],
    ['failed before a response', { state: 'failed', delivery: 'attempted' }],
  ] as const)('a request %s is no inventory', (_name, p) => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://static.hotjar.com/c/hotjar-1.js', { ...p, status: undefined })],
          }),
        ],
      }),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('TRACK-01 stage per timing', () => {
  const ga4LibraryInA = () =>
    phase('A', { requests: [req('a', 'https://www.googletagmanager.com/gtag/js?id=G-ABC')] });
  const ga4HitInC = () =>
    phase('C', {
      click: click('accept'),
      requests: [
        req('c', 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=[redacted]&en=page_view', {
          phase: 'C',
          afterClick: true,
          resourceType: 'ping',
        }),
      ],
    });

  it('library before the interaction, event only after accept → the stage belongs to its own timing', () => {
    const r = runCheck(track01, site({ phases: [ga4LibraryInA(), ga4HitInC()] }));
    const obs = observationsOf(r);
    // gtag/js and /g/collect are two catalog signatures of one service.
    expect(obs.map((o) => o.subject)).toEqual(['google-analytics']);
    expect(obs[0]?.params).toMatchObject({
      beforeInteraction: true,
      afterReject: false,
      afterAccept: true,
      stageBeforeInteraction: 'loaded',
      // No phase B in the snapshot: the reject was not carried out, so nothing is "not found" after it.
      stageAfterReject: 'not-checked',
      stageAfterAccept: 'event-sent',
      stage: 'event-sent',
    });
  });

  it('the German text pairs each stage with its timing and does not claim an event before the interaction', () => {
    const [o] = observationsOf(runCheck(track01, site({ phases: [ga4LibraryInA(), ga4HitInC()] })));
    const body = renderMessage(loadTexts('de'), 'TRACK-01.service-inventory', o?.params ?? {}).body;
    expect(body).toMatch(/vor einer Interaktion:\s*geladen/);
    expect(body).toMatch(/nach Ablehnung:\s*nicht geprüft/);
    expect(body).not.toMatch(/nach Ablehnung:\s*nicht gefunden/);
    expect(body).toMatch(/nach Zustimmung:\s*Ereignis gesendet/);
    expect(body).not.toMatch(/vor einer Interaktion:\s*(ja|Ereignis gesendet)/);
  });

  it('an event before the interaction is reported for that timing; a tracking cookie proves "initialised" for its own timing', () => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://connect.facebook.net/en_US/fbevents.js'),
              req('b', 'https://www.facebook.com/tr?id=1&ev=PageView', { resourceType: 'image' }),
            ],
          }),
          phase('B', {
            click: click('reject'),
            requests: [
              req('c', 'https://connect.facebook.net/en_US/fbevents.js', { phase: 'B', afterClick: true }),
            ],
            cookies: [cookie('_fbp', { phase: 'B', afterClick: true })],
          }),
        ],
      }),
    );
    expect(observationsOf(r)[0]?.params).toMatchObject({
      stageBeforeInteraction: 'event-sent',
      stageAfterReject: 'initialised',
      stageAfterAccept: 'not-checked',
      stage: 'event-sent',
    });
  });

  describe('"nicht gefunden" only for a timing that was carried out', () => {
    const libraryInA = () =>
      phase('A', { requests: [req('a', 'https://www.googletagmanager.com/gtag/js?id=G-ABC')] });
    const bodies = (phases: ReturnType<typeof phase>[]) => {
      const [o] = observationsOf(runCheck(track01, site({ phases })));
      const params = o?.params ?? {};
      return {
        params,
        de: renderMessage(loadTexts('de'), 'TRACK-01.service-inventory', params).body,
        en: renderMessage(loadTexts('en'), 'TRACK-01.service-inventory', params).body,
      };
    };

    it('banner not recognised: B partial without a click and C skipped → both timings "nicht geprüft"', () => {
      const { params, de, en } = bodies([
        libraryInA(),
        phase('B', { status: 'partial', reason: 'cmp-not-recognized' }),
        phase('C', { status: 'skipped', reason: 'cmp-not-recognized' }),
      ]);
      expect(params).toMatchObject({
        stageBeforeInteraction: 'loaded',
        stageAfterReject: 'not-checked',
        stageAfterAccept: 'not-checked',
      });
      expect(de).toMatch(/vor einer Interaktion:\s*geladen/);
      expect(de).toMatch(/nach Ablehnung:\s*nicht geprüft/);
      expect(de).toMatch(/nach Zustimmung:\s*nicht geprüft/);
      expect(de).not.toMatch(/nicht gefunden/);
      expect(en).toMatch(/after rejection:\s*not checked/);
      expect(en).toMatch(/after acceptance:\s*not checked/);
      expect(en).not.toMatch(/not found/);
    });

    it('B and C skipped for another reason (request cap, time budget) → not checked as well', () => {
      const { params } = bodies([
        libraryInA(),
        phase('B', { status: 'skipped', reason: 'request-cap', click: click('reject') }),
        phase('C', { status: 'skipped', reason: 'time-budget', click: click('accept') }),
      ]);
      expect(params).toMatchObject({ stageAfterReject: 'not-checked', stageAfterAccept: 'not-checked' });
    });

    it('a click that did not succeed carried out nothing', () => {
      const failed = { ...click('reject'), success: false };
      const { params } = bodies([libraryInA(), phase('B', { status: 'partial', click: failed })]);
      expect(params).toMatchObject({ stageAfterReject: 'not-checked' });
    });

    it('counterexample: a successful reject click without a request of the service afterwards → "nicht gefunden"', () => {
      const { params, de, en } = bodies([
        libraryInA(),
        phase('B', { click: click('reject') }),
        phase('C', { status: 'skipped', reason: 'time-budget' }),
      ]);
      expect(params).toMatchObject({ stageAfterReject: 'none', stageAfterAccept: 'not-checked' });
      expect(de).toMatch(/nach Ablehnung:\s*nicht gefunden/);
      expect(de).toMatch(/nach Zustimmung:\s*nicht geprüft/);
      expect(en).toMatch(/after rejection:\s*not found/);
      expect(en).toMatch(/after acceptance:\s*not checked/);
    });

    it('a tracking cookie of the service written after the reject without any request → "initialisiert", not "nicht gefunden"', () => {
      const { params, de } = bodies([
        libraryInA(),
        phase('B', {
          click: click('reject'),
          cookies: [cookie('_ga', { phase: 'B', afterClick: true })],
        }),
        phase('C', { status: 'skipped', reason: 'time-budget' }),
      ]);
      expect(params).toMatchObject({ stageAfterReject: 'initialised', afterReject: true });
      expect(de).toMatch(/nach Ablehnung:\s*initialisiert/);
    });

    it('a service seen only through its stored identifier is listed too, backed by the stored entry', () => {
      const r = runCheck(
        track01,
        site({
          phases: [
            libraryInA(),
            phase('B', {
              click: click('reject'),
              cookies: [
                cookie('IDE', {
                  domain: '.doubleclick.net',
                  firstParty: false,
                  phase: 'B',
                  afterClick: true,
                }),
              ],
            }),
          ],
        }),
      );
      const gmp = observationsOf(r).find((o) => o.subject === 'google-marketing-platform');
      expect(gmp).toMatchObject({
        confidence: 'high',
        category: 'ads',
        phases: ['B'],
        params: { stageBeforeInteraction: 'none', stageAfterReject: 'initialised', afterReject: true },
      });
      expect(gmp?.evidence.map((e) => e.type)).toEqual(['cookie']);
    });

    it('counterexample: both clicks carried out and the service silent afterwards → "nicht gefunden" twice', () => {
      const { params, de } = bodies([
        libraryInA(),
        phase('B', { click: click('reject') }),
        phase('C', { click: click('accept') }),
      ]);
      expect(params).toMatchObject({ stageAfterReject: 'none', stageAfterAccept: 'none' });
      expect(de.match(/nicht gefunden/g)).toHaveLength(2);
      expect(de).not.toMatch(/nicht geprüft/);
    });

    it('explains "nicht geprüft" and "initialisiert" without a request only where the inventory shows them', () => {
      const notChecked = /„Nicht geprüft“ steht für/;
      const initialised = /„Initialisiert“ ohne Anfrage/;

      const silent = bodies([
        libraryInA(),
        phase('B', { click: click('reject') }),
        phase('C', { click: click('accept') }),
      ]);
      expect(silent.params).toMatchObject({ notChecked: false, initialisedWithoutRequest: false });
      expect(silent.de).not.toMatch(notChecked);
      expect(silent.de).not.toMatch(initialised);
      expect(silent.en).not.toMatch(/"Not checked" stands for|"Initialised" without a request/);

      const unchecked = bodies([
        libraryInA(),
        phase('B', { status: 'partial', reason: 'cmp-not-recognized' }),
      ]);
      expect(unchecked.de).toMatch(notChecked);
      expect(unchecked.de).not.toMatch(initialised);

      const stored = bodies([
        libraryInA(),
        phase('B', { click: click('reject'), cookies: [cookie('_ga', { phase: 'B', afterClick: true })] }),
        phase('C', { click: click('accept') }),
      ]);
      expect(stored.params).toMatchObject({ initialisedWithoutRequest: true, notChecked: false });
      expect(stored.de).toMatch(initialised);
      expect(stored.de).not.toMatch(notChecked);
    });

    it('requests after a click prove the stage even if the phase status says partial', () => {
      const { params } = bodies([
        libraryInA(),
        phase('B', {
          status: 'partial',
          click: click('reject'),
          requests: [
            req('b', 'https://www.googletagmanager.com/gtag/js?id=G-ABC', { phase: 'B', afterClick: true }),
          ],
        }),
      ]);
      expect(params).toMatchObject({ stageAfterReject: 'loaded', stageAfterAccept: 'not-checked' });
    });
  });

  it('the rendered inventory text has no duplicated word in de and en, for every stage combination', () => {
    const stages = ['none', 'not-checked', 'loaded', 'initialised', 'event-sent'];
    for (const lang of ['de', 'en'] as const) {
      const texts = loadTexts(lang);
      for (const before of stages)
        for (const reject of stages)
          for (const accept of stages) {
            const { body } = renderMessage(texts, 'TRACK-01.service-inventory', {
              service: 'Google Analytics',
              stage: 'event-sent',
              stageBeforeInteraction: before,
              stageAfterReject: reject,
              stageAfterAccept: accept,
              beforeInteraction: before !== 'none' && before !== 'not-checked',
              afterReject: reject !== 'none' && reject !== 'not-checked',
              afterAccept: accept !== 'none' && accept !== 'not-checked',
            });
            expect(body, `${lang} ${before}/${reject}/${accept}`).not.toMatch(/\b(\p{L}+)\s+\1\b/iu);
            expect(body).not.toMatch(/beobachtet beobachtet/);
          }
    }
  });
});

describe('TRACK-01 on control pages where the decision of the click is not in effect', () => {
  const OTHER = `${SHOP_HOST}/kontakt`;
  const hit = (id: string, ph: 'B' | 'C', pageUrl: string) =>
    req(id, 'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=[redacted]&en=page_view', {
      phase: ph,
      afterClick: true,
      resourceType: 'ping',
      pageUrl,
    });
  const libraryInA = () =>
    phase('A', { requests: [req('a', 'https://www.googletagmanager.com/gtag/js?id=G-ABC')] });
  /** Phases B and C with the control page `url`; `inEffect` per phase, and GA hits on the pages in `hits`. */
  const consentRun = (
    url: string,
    inEffect: { B: boolean; C: boolean },
    hits: { B?: string[]; C?: string[] },
    extra: { B?: Partial<Parameters<typeof phase>[1]> } = {},
  ) =>
    runCheck(
      track01,
      site({
        phases: [
          libraryInA(),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            pages: consentPages('B', [url]),
            requests: (hits.B ?? []).map((p, i) => hit(`b${i}`, 'B', p)),
            ...extra.B,
          }),
          phase('C', {
            click: click('accept'),
            pages: consentPages('C', [url]),
            requests: (hits.C ?? []).map((p, i) => hit(`c${i}`, 'C', p)),
          }),
        ],
        cmp: cmpWith(
          { phase: 'B', facts: [cmpFacts(), controlPageFacts(url, 'B', inEffect.B)] },
          { phase: 'C', facts: [cmpFacts({ phase: 'C' }), controlPageFacts(url, 'C', inEffect.C)] },
        ),
      }),
    );

  it('a hit on a control page without the reject is not "after rejection"; the result names the pages left out', () => {
    const r = consentRun(OTHER, { B: false, C: true }, { B: [OTHER] });
    expect(r).toMatchObject({ status: 'partial', outcome: { limitations: ['reject-not-in-effect'] } });
    expect(observationsOf(r)[0]?.params).toMatchObject({
      stageBeforeInteraction: 'loaded',
      stageAfterReject: 'none',
      afterReject: false,
      requestCount: 1,
    });
    expect(observationsOf(r)[0]?.pages).toEqual([START]);
  });

  it('a hit on a control page without the accept is not "after acceptance"', () => {
    const r = consentRun(OTHER, { B: true, C: false }, { C: [OTHER] });
    expect(r).toMatchObject({ status: 'partial', outcome: { limitations: ['accept-not-in-effect'] } });
    expect(observationsOf(r)[0]?.params).toMatchObject({ stageAfterAccept: 'none', afterAccept: false });
  });

  it('both pages without the decision: both limitations, and the hits after the clicks on the start page still count', () => {
    const r = consentRun(OTHER, { B: false, C: false }, { B: [START, OTHER], C: [START, OTHER] });
    expect(r.outcome?.limitations).toEqual(['accept-not-in-effect', 'reject-not-in-effect']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      stageAfterReject: 'event-sent',
      stageAfterAccept: 'event-sent',
      requestCount: 3,
    });
  });

  it('a tracking cookie written on a control page without the reject proves no stage after the reject', () => {
    const r = consentRun(
      OTHER,
      { B: false, C: true },
      {},
      {
        B: { cookies: [cookie('_ga', { phase: 'B', afterClick: true, pageUrl: OTHER })] },
      },
    );
    expect(observationsOf(r)[0]?.params).toMatchObject({ stageAfterReject: 'none', afterReject: false });
  });

  it('a throttled phase keeps its limitation next to the pages left out', () => {
    const r = consentRun(
      OTHER,
      { B: false, C: true },
      { B: [OTHER] },
      { B: { status: 'partial', reason: 'throttled' } },
    );
    expect(r).toMatchObject({
      status: 'partial',
      outcome: { limitations: ['reject-not-in-effect', 'throttled'] },
    });
  });

  it('counterexample: control pages on another host with the stored decision count for both timings', () => {
    const r = consentRun(OTHER, { B: true, C: true }, { B: [OTHER], C: [OTHER] });
    expect(r).toMatchObject({ status: 'completed', outcome: { limitations: [] } });
    expect(observationsOf(r)[0]?.params).toMatchObject({
      stageAfterReject: 'event-sent',
      stageAfterAccept: 'event-sent',
    });
  });

  it('counterexample: a cookie of the service on a control page with the stored reject proves "initialised"', () => {
    const r = consentRun(
      OTHER,
      { B: true, C: true },
      {},
      {
        B: { cookies: [cookie('_ga', { phase: 'B', afterClick: true, pageUrl: OTHER })] },
      },
    );
    expect(observationsOf(r)[0]?.params).toMatchObject({ stageAfterReject: 'initialised' });
  });
});
