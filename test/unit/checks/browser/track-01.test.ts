import { describe, expect, it } from 'vitest';
import { track01 } from '../../../../src/checks/browser/track-01.ts';
import { loadTexts } from '../../../../src/core/data.ts';
import { renderMessage } from '../../../../src/core/messages.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { click, cookie, phase, req, START, site } from './helpers.ts';
import { SCENARIOS } from './scenarios/index.ts';

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

  it('clean: names in source code without an executed request → nothing', () => {
    expect(variantsOf(runCheck(track01, scenario('clean-source-reference-only.json')))).toEqual([]);
  });

  it('inconclusive: no network slice', () => {
    expect(runCheck(track01, scenario('inconclusive-no-network.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'no-network-observation',
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

  it('the GAM compression dictionary (resourceType other) proves only "loaded"; a fetch ad request proves event-sent', () => {
    const dict = req('a', 'https://securepubads.g.doubleclick.net/pagead/managed/dict/abc/def', {
      resourceType: 'other',
    });
    const loaded = runCheck(track01, site({ phases: [phase('A', { requests: [dict] })] }));
    expect(observationsOf(loaded).map((o) => [o.subject, o.params.stage])).toEqual([
      ['google-ad-manager', 'loaded'],
    ]);
    const sent = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              dict,
              req('b', 'https://securepubads.g.doubleclick.net/gampad/ads?iu=x', { resourceType: 'fetch' }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(sent).map((o) => [o.subject, o.params.stage])).toEqual([
      ['google-ad-manager', 'event-sent'],
    ]);
  });

  it('Piano identity, experience and checkout calls prove "loaded" only; the engagement ping proves event-sent', () => {
    const calls = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://id.piano.io/api/v1/identity/login/token?aid=x', { resourceType: 'xhr' }),
              req('b', 'https://experience.piano.io/xbuilder/experience/execute', { resourceType: 'fetch' }),
              req('c', 'https://buy.piano.io/checkout/offer/show', { resourceType: 'fetch' }),
            ],
          }),
        ],
      }),
    );
    expect(
      observationsOf(calls).map((o) => [o.subject, o.params.stage, o.params.stageBeforeInteraction]),
    ).toEqual([['piano', 'loaded', 'loaded']]);
    const ping = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [req('d', 'https://c2.piano.io/page/track/engagement', { resourceType: 'xhr' })],
          }),
        ],
      }),
    );
    expect(observationsOf(ping).map((o) => [o.subject, o.params.stageBeforeInteraction])).toEqual([
      ['piano', 'event-sent'],
    ]);
  });

  it('an `other` request on a path without a signature proves "loaded" only', () => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://securepubads.g.doubleclick.net/pcs/anything', { resourceType: 'other' }),
            ],
          }),
        ],
      }),
    );
    expect(
      observationsOf(r).map((o) => [o.subject, o.params.stage, o.params.stageBeforeInteraction]),
    ).toEqual([['google-ad-manager', 'loaded', 'loaded']]);
  });

  it('Chartbeat ping and ScorecardResearch beacon prove event-sent; the Tealium library and a Chartbeat strategy call prove "loaded"', () => {
    const hits = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://ping.chartbeat.net/ping?h=example.de&p=%2F', { resourceType: 'image' }),
              req('b', 'https://sb.scorecardresearch.com/b?c1=2&c2=1000', { resourceType: 'image' }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(hits).map((o) => [o.subject, o.params.stageBeforeInteraction])).toEqual([
      ['chartbeat', 'event-sent'],
      ['scorecardresearch', 'event-sent'],
    ]);
    const loaded = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('c', 'https://tags.tiqcdn.com/utag/acme/main/prod/utag.js', { resourceType: 'script' }),
              req('d', 'https://mab.chartbeat.com/mab_strategy/example.de/', { resourceType: 'xhr' }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(loaded).map((o) => [o.subject, o.params.stageBeforeInteraction])).toEqual([
      ['chartbeat', 'loaded'],
      ['tealium', 'loaded'],
    ]);
  });

  it('a tracking cookie of the service proves "initialised"', () => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://connect.facebook.net/en_US/fbevents.js')],
            cookies: [cookie('_fbp')],
          }),
        ],
      }),
    );
    expect(observationsOf(r)[0]?.params).toMatchObject({ service: 'Meta Pixel', stage: 'initialised' });
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

  it('a hit whose response arrived before a body error still proves event-sent; SW/cache answers count as loaded', () => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
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
          }),
        ],
      }),
    );
    expect(observationsOf(r).map((o) => [o.subject, o.params.stage])).toEqual([
      ['google-analytics', 'event-sent'],
      ['hotjar', 'loaded'],
    ]);
  });

  it('failed requests and non-tracking categories are not inventory; first-party proxy has medium confidence', () => {
    const r = runCheck(
      track01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://static.hotjar.com/c/hotjar-1.js', { state: 'failed' }),
              req('b', 'https://fonts.googleapis.com/css2?family=X', { resourceType: 'stylesheet' }),
              req('c', `${START}g/collect?v=2&tid=G-1`, { resourceType: 'ping' }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(r).map((o) => [o.subject, o.confidence, o.params.firstPartyProxy])).toEqual([
      ['google-analytics', 'medium', true],
    ]);
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
      expect(en).toMatch(/after reject:\s*not checked/);
      expect(en).toMatch(/after accept:\s*not checked/);
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
      expect(en).toMatch(/after reject:\s*not found/);
      expect(en).toMatch(/after accept:\s*not checked/);
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
