import { describe, expect, it } from 'vitest';
import { consent04, createConsent04, lexiconFrom } from '../../../../src/checks/browser/consent-04.ts';
import type { CmpButton, CmpFacts, CmpLexicon, FirstLayerClassification } from '../../../../src/cmp/types.ts';
import { EvidenceSchema } from '../../../../src/core/report-schema.ts';
import type { Snapshot } from '../../../../src/core/snapshot.ts';
import type { SanitizedUrl } from '../../../../src/core/snapshot-common.ts';
import { makeBrowserPlan, observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { cmpFacts, cmpWith, phase, site } from './helpers.ts';
import { SCENARIOS } from './scenarios.ts';

const scenario = (file: string) => SCENARIOS['CONSENT-04']!.find((s) => s.file === file)!.build();

const fixed =
  (variant: string, extra: Partial<FirstLayerClassification> = {}) =>
  (): FirstLayerClassification => ({
    variant: variant as FirstLayerClassification['variant'],
    flags: [],
    confidence: 'high',
    reasons: [],
    ...extra,
  });

const button = (name: string, kind: CmpButton['kind'], actionable = true): CmpButton => ({
  role: 'button',
  name,
  tag: 'button',
  kind,
  kindConfidence: 'high',
  layer: 1,
  box: { x: 10, y: 600, width: 160, height: 44 },
  visibleAtFirstScreen: true,
  actionableAtFirstScreen: actionable,
  contrast: 7,
});

const visibleBanner = (p: Partial<CmpFacts> = {}) =>
  cmpFacts({
    firstLayer: {
      bannerPresent: true,
      bannerVisible: true,
      buttons: [button('Alle akzeptieren', 'accept'), button('Einstellungen', 'settings')],
      purAbo: false,
      closeMeansAccept: null,
    },
    blocking: {
      overlay: true,
      scrollLock: true,
      inert: false,
      coveredRatio: 0.6,
      method: ['overlay', 'overflow-hidden'],
    },
    ...p,
  });

describe('CONSENT-04 first layer (classifier injected)', () => {
  it('violation (fixture): CMP state granted without action', () => {
    const r = runCheck(consent04, scenario('violation-consent-without-action.json'));
    expect(r).toMatchObject({ status: 'completed' });
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'consent-without-action',
      subject: 'consent-ui',
      params: { cmp: 'cookiebot' },
    });
    expect(o?.evidence.map((e) => e.type)).toEqual(['cmp', 'consent-state']);
    expect(r.outcome?.limitations).toContain('first-layer-not-visible');
  });

  it('clean (fixture): no banner at all → not_applicable', () => {
    expect(runCheck(consent04, scenario('clean-no-banner.json'))).toMatchObject({
      status: 'not_applicable',
      reason: 'no-banner',
    });
  });

  it('inconclusive (fixture): heuristic candidate → info "Banner nicht erkannt"; the classifier is not consulted', () => {
    let called = false;
    const check = createConsent04(() => {
      called = true;
      return fixed('blocking-no-reject')();
    });
    const r = runCheck(check, scenario('inconclusive-banner-not-recognized.json'));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
    expect(variantsOf(r)).toEqual(['banner-not-recognized']);
    expect(called).toBe(false);
  });

  it('supported CMP with high recognition: the classifier verdict becomes the variant (blocking-no-reject)', () => {
    const r = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) }),
    );
    expect(r.status).toBe('completed');
    const [o] = observationsOf(r);
    expect(o).toMatchObject({ variant: 'blocking-no-reject', confidence: 'high' });
    expect(o?.evidence[0]).toMatchObject({
      type: 'cmp',
      cmpId: 'cookiebot',
      recognitionConfidence: 'high',
      blocking: { overlay: true, coveredRatio: 0.6 },
    });
  });

  it('classifier "ok" → no finding; pur-abo flag is reported in addition', () => {
    const ok = runCheck(
      createConsent04(fixed('ok')),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) }),
    );
    expect(variantsOf(ok)).toEqual([]);
    const flagged = runCheck(
      createConsent04(fixed('blocking-no-reject', { flags: ['pur-abo'] })),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) }),
    );
    expect(variantsOf(flagged)).toEqual(['blocking-no-reject', 'pur-abo']);
  });

  it('classifier medium confidence is passed on (assess caps the level)', () => {
    const r = runCheck(
      createConsent04(fixed('blocking-no-reject', { confidence: 'medium' })),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) }),
    );
    expect(observationsOf(r)[0]?.confidence).toBe('medium');
  });

  it('classifier says "banner-not-recognized" → inconclusive with that info variant', () => {
    const r = runCheck(
      createConsent04(fixed('banner-not-recognized')),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
  });

  it('only own adapters with high recognition give a verdict: medium → banner-not-recognized, version out of range → cmp-not-supported', () => {
    const det = visibleBanner().detection;
    const medium = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [visibleBanner({ detection: { ...det, recognitionConfidence: 'medium' } })],
        }),
      }),
    );
    expect(variantsOf(medium)).toEqual(['banner-not-recognized']);
    const version = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [visibleBanner({ detection: { ...det, versionSupported: false } })],
        }),
      }),
    );
    expect(version).toMatchObject({ status: 'inconclusive', reason: 'cmp-not-supported' });
    expect(observationsOf(version)[0]?.params).toMatchObject({ cmp: 'cookiebot' });
    const named = runCheck(
      consent04,
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            visibleBanner({
              detection: { ...det, cmpId: 'onetrust', method: 'heuristic', recognitionConfidence: 'medium' },
            }),
          ],
        }),
      }),
    );
    expect(variantsOf(named)).toEqual(['cmp-not-supported']);
  });

  it('reject clicked but the state is not denied → reject-ineffective', () => {
    const r = runCheck(
      createConsent04(fixed('ok')),
      site({
        phases: [phase('A'), phase('B')],
        cmp: cmpWith({
          phase: 'B',
          facts: [visibleBanner()],
          click: {
            action: 'reject',
            clicked: true,
            button: { name: 'Ablehnen', role: 'button', kind: 'reject', kindConfidence: 'high' },
          },
          verify: {
            action: 'reject',
            verified: false,
            method: [],
            stateAfter: [
              { source: 'api', ready: 'ready', categories: { statistics: 'granted' }, origin: 'action' },
            ],
            persistedAfterReload: false,
          },
        }),
      }),
    );
    expect(variantsOf(r)).toEqual(['reject-ineffective']);
  });

  it('reject clicked, CMP API not ready afterwards → no reject-ineffective, limitation reject-unverified', () => {
    const r = runCheck(
      createConsent04(fixed('ok')),
      site({
        phases: [phase('A'), phase('B')],
        cmp: cmpWith({
          phase: 'B',
          facts: [visibleBanner()],
          click: {
            action: 'reject',
            clicked: true,
            button: { name: 'Ablehnen', role: 'button', kind: 'reject', kindConfidence: 'high' },
          },
          verify: {
            action: 'reject',
            verified: false,
            method: [],
            stateAfter: [
              { source: 'api', ready: 'loading', categories: { statistics: 'granted' }, origin: 'action' },
            ],
            persistedAfterReload: null,
          },
        }),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.limitations).toContain('reject-unverified');
  });

  it('granted after our own accept (phase C after the click / after a reload) is not consent-without-action', () => {
    const granted = (origin: 'stored' | 'action') => [
      {
        source: 'api' as const,
        ready: 'ready' as const,
        categories: { statistics: 'granted' as const, marketing: 'granted' as const },
        origin,
      },
    ];
    const r = runCheck(
      createConsent04(fixed('ok')),
      site({
        cmp: cmpWith(
          { phase: 'B', facts: [visibleBanner()] },
          {
            phase: 'C',
            facts: [
              visibleBanner({ phase: 'C', moment: 'after-click', state: granted('action') }),
              visibleBanner({ phase: 'C', moment: 'after-reload', state: granted('stored') }),
              visibleBanner({ phase: 'C', moment: 'phase-end', state: granted('stored') }),
            ],
          },
        ),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('a granted state attributed to an action (origin action) on the first screen is not "without action"', () => {
    const r = runCheck(
      createConsent04(fixed('ok')),
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            visibleBanner({
              state: [
                { source: 'api', ready: 'ready', categories: { marketing: 'granted' }, origin: 'action' },
                {
                  source: 'api',
                  ready: 'ready',
                  categories: { marketing: 'granted' },
                  origin: 'special-branch',
                },
              ],
            }),
          ],
        }),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: necessary-only grant or default-denied is not consent-without-action', () => {
    const r = runCheck(
      createConsent04(fixed('ok')),
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            visibleBanner({
              state: [
                {
                  source: 'api',
                  ready: 'ready',
                  categories: { necessary: 'granted', statistics: 'denied' },
                  origin: 'default',
                },
                { source: 'api', ready: 'loading', categories: { marketing: 'granted' }, origin: 'default' },
              ],
            }),
          ],
        }),
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('bot signal → inconclusive with SCAN-BOTMODE', () => {
    const r = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [visibleBanner({ botSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] })],
        }),
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
  });

  it('replay with a changed lexicon is flagged against plan.click', () => {
    const plan = makeBrowserPlan({
      click: {
        B: {
          phase: 'B',
          action: 'reject',
          target: { cmpId: 'cookiebot', name: 'Ablehnen', kindConfidence: 'high' },
        },
      },
    });
    const r = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }), plan }),
      {
        options: { strict: false, assumeRegion: null, fromSnapshot: true },
      },
    );
    expect(r.outcome?.limitations).toContain('lexicon-changed-since-scan');
  });

  it('lexiconFrom accepts a `lexicon:` block or the top level and rejects other shapes', () => {
    const lex: CmpLexicon = {
      version: '1',
      accept: ['Akzeptieren'],
      reject: ['Ablehnen'],
      settings: [],
      save: [],
      close: [],
      later: [],
      hide: ['Verbergen'],
    };
    expect(lexiconFrom({ lexicon: lex })).toEqual(lex);
    expect(lexiconFrom(lex)).toEqual(lex);
    expect(lexiconFrom({ foo: 1 })).toBeNull();
    expect(lexiconFrom(undefined)).toBeNull();
  });
});

describe('CONSENT-04 with the first-layer classifier', () => {
  it('counterexample: "Verbergen" is not a reject → blocking dialog without reject', () => {
    const facts = visibleBanner({
      firstLayer: {
        bannerPresent: true,
        bannerVisible: true,
        buttons: [button('Alle akzeptieren', 'accept'), button('Verbergen', 'hide')],
        purAbo: false,
        closeMeansAccept: null,
      },
    });
    expect(variantsOf(runCheck(consent04, site({ cmp: cmpWith({ phase: 'B', facts: [facts] }) })))).toContain(
      'blocking-no-reject',
    );
  });

  it('clean: visible actionable accept and reject on the first layer → no first-layer finding', () => {
    const facts = visibleBanner({
      firstLayer: {
        bannerPresent: true,
        bannerVisible: true,
        buttons: [button('Alle akzeptieren', 'accept'), button('Ablehnen', 'reject')],
        purAbo: false,
        closeMeansAccept: null,
      },
    });
    expect(variantsOf(runCheck(consent04, site({ cmp: cmpWith({ phase: 'B', facts: [facts] }) })))).toEqual(
      [],
    );
  });
});

// : the CMP markup role of a button is a fact of the adapter and belongs to the report evidence.
describe('CONSENT-04 evidence: vendorRole', () => {
  const firstLayer = (buttons: CmpButton[]): CmpFacts['firstLayer'] => ({
    bannerPresent: true,
    bannerVisible: true,
    buttons,
    purAbo: false,
    closeMeansAccept: null,
  });

  it('vendorRole is projected next to kind / kindConfidence and survives schema validation and serialization', () => {
    const save: CmpButton = {
      ...button('Ausgewählte Cookies akzeptieren', 'accept'),
      kindConfidence: 'low',
      vendorRole: 'save',
    };
    const plain = button('Alle akzeptieren', 'accept');
    const facts = visibleBanner({ firstLayer: firstLayer([save, plain]) });
    const r = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({ cmp: cmpWith({ phase: 'B', facts: [facts] }) }),
    );
    const cmpEv = observationsOf(r)[0]?.evidence.find((e) => e.type === 'cmp');
    expect(cmpEv).toBeDefined();
    const parsed = EvidenceSchema.parse({ id: 'ev-1', ...cmpEv });
    const buttons = (parsed as { buttons?: Array<Record<string, unknown>> }).buttons ?? [];
    expect(buttons[0]).toMatchObject({ kind: 'accept', kindConfidence: 'low', vendorRole: 'save' });
    expect(buttons[1]?.vendorRole ?? null).toBeNull();
    const json = JSON.parse(JSON.stringify(parsed)) as { buttons: Array<Record<string, unknown>> };
    expect(json.buttons[0]?.vendorRole).toBe('save');
  });
});

// / : an incomplete or still-moving measurement is a limitation, never a verdict about the reject.
describe('CONSENT-04 limitations from the classifier reasons', () => {
  const bannerFacts = (extra: Partial<CmpFacts['firstLayer']> = {}) =>
    visibleBanner({
      firstLayer: {
        bannerPresent: true,
        bannerVisible: true,
        buttons: [button('Alle akzeptieren', 'accept'), button('Einstellungen', 'settings')],
        purAbo: false,
        closeMeansAccept: null,
        ...extra,
      },
    });

  it('truncated buttons without a found reject: inconclusive banner-not-recognized + limitation buttons-truncated', () => {
    const r = runCheck(
      consent04,
      site({ cmp: cmpWith({ phase: 'B', facts: [bannerFacts({ buttonsTruncated: true })] }) }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
    expect(variantsOf(r)).toEqual(['banner-not-recognized']);
    expect(r.outcome?.limitations).toContain('buttons-truncated');
  });

  it('counterexample: the same facts without truncation keep the verdict blocking-no-reject', () => {
    const r = runCheck(consent04, site({ cmp: cmpWith({ phase: 'B', facts: [bannerFacts()] }) }));
    expect(variantsOf(r)).toEqual(['blocking-no-reject']);
    expect(r.outcome?.limitations ?? []).not.toContain('buttons-truncated');
  });

  it('unsettled geometry with the reject outside the viewport: limitation geometry-unsettled, no reject-not-actionable', () => {
    const facts = bannerFacts({
      geometryUnsettled: true,
      buttons: [
        { ...button('Ablehnen', 'reject', false), inViewport: false, visibleAtFirstScreen: false },
        button('Alle akzeptieren', 'accept'),
      ],
    });
    const r = runCheck(consent04, site({ cmp: cmpWith({ phase: 'B', facts: [facts] }) }));
    expect(variantsOf(r)).toEqual(['banner-not-recognized']);
    expect(r.outcome?.limitations).toContain('geometry-unsettled');
  });
});

// : an adapter below `high` is no better a source than the heuristic, so the heuristic banner with buttons and
// screenshot of phase B is the evidence, not an empty adapter fact of a page where the banner is hidden.
describe('CONSENT-04 primary facts: adapter below high vs heuristic', () => {
  const OTHER = 'https://www.example.de/impressum';
  const SHOT = 'shot-b-1';
  const heuristicBanner = (p: Partial<CmpFacts> = {}) =>
    visibleBanner({
      detection: {
        cmpId: null,
        method: 'heuristic',
        version: null,
        versionSupported: null,
        recognitionConfidence: 'medium',
        signals: ['adapter-hint:cookiebot', 'cookie:CookieConsent', 'heuristic:fixed'],
      },
      firstLayer: {
        bannerPresent: true,
        bannerVisible: true,
        buttons: [button('Akzeptieren', 'accept'), button('Ablehnen', 'reject')],
        purAbo: false,
        closeMeansAccept: null,
      },
      ...p,
    });
  const mediumAdapterNoBanner = (p: Partial<CmpFacts> = {}) =>
    cmpFacts({
      phase: 'A',
      pageUrl: OTHER,
      detection: {
        cmpId: 'cookiebot',
        method: 'adapter',
        version: null,
        versionSupported: null,
        recognitionConfidence: 'medium',
        signals: ['cookie:CookieConsent'],
      },
      firstLayer: {
        bannerPresent: false,
        bannerVisible: false,
        buttons: [],
        purAbo: false,
        closeMeansAccept: null,
      },
      blocking: { overlay: false, scrollLock: false, inert: false, coveredRatio: null, method: [] },
      ...p,
    });
  const withShot = (snap: Snapshot): Snapshot => {
    if (!snap.browser) throw new Error('site() builds a browser section');
    return {
      ...snap,
      browser: {
        ...snap.browser,
        screenshots: [
          {
            id: SHOT,
            phase: 'B',
            kind: 'banner',
            path: 'artifacts/banner-b.png',
            sha256: 'a'.repeat(64),
            width: 800,
            height: 120,
            viewport: 'desktop',
            pageUrl: 'https://www.example.de/' as SanitizedUrl,
          },
        ],
      },
    };
  };

  it('banner hidden on legal pages in A (adapter, medium, no banner), visible in B (heuristic) → evidence and screenshot come from B', () => {
    const snap = withShot(
      site({
        phases: [phase('A'), phase('B')],
        cmp: cmpWith(
          {
            phase: 'A',
            facts: [
              heuristicBanner({ phase: 'A', moment: 'phase-end' }),
              mediumAdapterNoBanner(),
              mediumAdapterNoBanner({ pageUrl: 'https://www.example.de/datenschutz' }),
            ],
          },
          { phase: 'B', facts: [heuristicBanner({ screenshotId: SHOT })] },
        ),
      }),
    );
    const r = runCheck(consent04, snap);
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'banner-not-recognized',
      phases: ['B'],
      pages: ['https://www.example.de/'],
    });
    expect((o?.evidence ?? []).map((e) => e.type)).toEqual(['cmp', 'screenshot']);
    const cmp = (o?.evidence ?? []).find((e) => e.type === 'cmp') as { buttons: unknown[]; page: string };
    expect(cmp.buttons).toHaveLength(2);
    expect(cmp.page).toBe('https://www.example.de/');
  });

  it('counterexample: an adapter with high recognition and a visible banner in A stays the primary facts over a heuristic fact of B', () => {
    const r = runCheck(
      createConsent04(fixed('blocking-no-reject')),
      site({
        phases: [phase('A'), phase('B')],
        cmp: cmpWith(
          { phase: 'A', facts: [visibleBanner({ phase: 'A', moment: 'phase-end' })] },
          { phase: 'B', facts: [heuristicBanner()] },
        ),
      }),
    );
    expect(r).toMatchObject({ status: 'completed' });
    const [o] = observationsOf(r);
    expect(o).toMatchObject({ variant: 'blocking-no-reject', phases: ['A'] });
    expect(o?.params).toMatchObject({ cmp: 'cookiebot' });
  });
});
