import { describe, expect, it } from 'vitest';
import { consent04, createConsent04, lexiconFrom } from '../../../../../src/checks/browser/consent-04.ts';
import type {
  CmpButton,
  CmpFacts,
  CmpLexicon,
  FirstLayerClassification,
} from '../../../../../src/cmp/types.ts';
import { parseConfigInput } from '../../../../../src/core/config/load.ts';
import { checkThresholds } from '../../../../../src/core/config/thresholds.ts';
import { loadDataDir, loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import { EvidenceSchema } from '../../../../../src/core/report/schema.ts';
import type { SanitizedUrl } from '../../../../../src/core/snapshot/common.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import { makeBrowserPlan, observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import { cmpFacts, cmpWith, phase, site, unopenedDialogCmp, unopenedDialogFacts } from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

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

  it('hands the blocking threshold of the settings to the classifier', () => {
    const seen: Array<number | undefined> = [];
    const check = createConsent04((_facts, _lexicon, options) => {
      seen.push(options.blockingCoveredRatio);
      return fixed('ok')();
    });
    const snapshot = site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) });
    runCheck(check, snapshot);
    runCheck(check, snapshot, {
      thresholds: checkThresholds(parseConfigInput({ cmp: { blockingCoveredRatio: 0.6 } })),
    });
    expect(seen).toEqual([0.85, 0.6]);
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

  it('a banner an adapter recognised with high confidence whose first layer the classifier cannot read says so', () => {
    const r = runCheck(
      createConsent04(fixed('banner-not-recognized')),
      site({ cmp: cmpWith({ phase: 'B', facts: [visibleBanner()] }) }),
    );
    const [o] = observationsOf(r);
    expect(o?.params).toMatchObject({ cmp: 'cookiebot', bannerRecognized: true });
    const text = renderMessage(loadTexts('de'), 'CONSENT-04.banner-not-recognized', o?.params as never);
    expect(text.title).toBe('Erste Banner-Ebene nicht eindeutig');
    expect(text.body).toMatch(/^Das Einwilligungsbanner \(cookiebot\) wurde erkannt/);
    expect(renderMessage(loadTexts('en'), 'CONSENT-04.banner-not-recognized', o?.params as never).title).toBe(
      'First banner layer ambiguous',
    );
  });

  describe('only own adapters with high recognition give a verdict', () => {
    const det = visibleBanner().detection;

    it('medium recognition → banner-not-recognized', () => {
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
    });

    it('version out of range → cmp-not-supported', () => {
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
    });

    it('a heuristic match of a named CMP → cmp-not-supported', () => {
      const named = runCheck(
        consent04,
        site({
          cmp: cmpWith({
            phase: 'B',
            facts: [
              visibleBanner({
                detection: {
                  ...det,
                  cmpId: 'onetrust',
                  method: 'heuristic',
                  recognitionConfidence: 'medium',
                },
              }),
            ],
          }),
        }),
      );

      expect(variantsOf(named)).toEqual(['cmp-not-supported']);
    });
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

  // A CMP whose state cannot list its categories (Shopware) proves no failed reject by that state alone.
  it.each([
    ['the answer recorded, no category listed', {}, true, [], 'reject-unverified'],
    ['the answer recorded, every category unknown', { statistics: 'unknown' }, true, [], 'reject-unverified'],
    ['no answer recorded after the click', {}, false, ['reject-ineffective'], null],
    [
      'the answer recorded, a category granted',
      { statistics: 'granted' },
      true,
      ['reject-ineffective'],
      null,
    ],
  ] as const)(
    'reject clicked, state after: %s → %j',
    (_case, categories, responded, variants, limitation) => {
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
              button: {
                name: 'Nur technisch notwendige',
                role: 'button',
                kind: 'reject',
                kindConfidence: 'high',
              },
            },
            verify: {
              action: 'reject',
              verified: false,
              method: ['ui-closed'],
              stateAfter: [
                {
                  source: 'cookie',
                  ready: 'ready',
                  categories,
                  origin: responded ? 'action' : 'default',
                  decision: { responded, method: responded ? 'explicit' : 'unknown' },
                },
              ],
              persistedAfterReload: false,
              reason: 'no-categories',
            },
          }),
        }),
      );
      expect(variantsOf(r)).toEqual(variants);
      if (limitation) expect(r.outcome?.limitations).toContain(limitation);
      else expect(r.outcome?.limitations ?? []).not.toContain('reject-unverified');
    },
  );

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

  describe('a dialog the CMP did not open for the scanner', () => {
    it('names that reason and nothing else: no observation, no limitation about visibility', () => {
      const r = runCheck(consent04, scenario('inconclusive-cmp-dialog-not-opened.json'));

      expect(r.outcome).toEqual({
        status: 'inconclusive',
        reason: 'cmp-dialog-not-opened',
        observations: [],
      });
    });

    it('also no consent-without-action from a default state the closed dialog reports', () => {
      const granted = {
        source: 'api',
        ready: 'ready',
        categories: { embeddings: 'granted' },
        origin: 'default',
        decision: { responded: false, method: 'unknown' },
      } as const;
      const r = runCheck(
        consent04,
        site({ phases: [phase('A'), phase('B')], cmp: unopenedDialogCmp({ state: [granted] }) }),
      );

      expect(r).toMatchObject({ status: 'inconclusive', reason: 'cmp-dialog-not-opened' });
      expect(observationsOf(r)).toEqual([]);
    });

    it('a flag on facts of phase A, taken without waiting for the banner, does not decide', () => {
      const r = runCheck(
        consent04,
        site({
          phases: [phase('A')],
          cmp: cmpWith({ phase: 'A', facts: [unopenedDialogFacts({ phase: 'A' })] }),
        }),
      );

      expect(r).toMatchObject({ status: 'inconclusive', reason: 'first-layer-not-visible' });
    });

    it('a bot signal of the adapter takes precedence (bot-mode)', () => {
      const r = runCheck(consent04, scenario('inconclusive-dialog-not-opened-bot-signal.json'));

      expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
      expect(r.outcome?.diagnostics?.[0]).toMatchObject({ code: 'SCAN-BOTMODE' });
    });
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
      negations: ['nicht'],
      necessity: ['notwendige'],
      restrictions: ['nur'],
      paid: ['abo'],
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

// the CMP markup role of a button is a fact of the adapter and belongs to the report evidence.
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

// An incomplete or still-moving measurement is a limitation, never a verdict about the reject.
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

// an adapter below `high` is no better a source than the heuristic, so the heuristic banner with buttons and
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

describe('CONSENT-04 takes its vocabulary from test/data/cmp', () => {
  const cmp = loadDataDir('cmp');
  const statisticsGranted = () =>
    site({
      cmp: cmpWith({
        phase: 'B',
        facts: [
          visibleBanner({
            state: [
              {
                source: 'api',
                ready: 'ready',
                categories: { statistics: 'granted', marketing: 'denied' },
                origin: 'default',
              },
            ],
          }),
        ],
      }),
    });

  it('a category the file lists as essential is not "granted without action"', () => {
    const check = createConsent04(fixed('ok'));
    expect(variantsOf(runCheck(check, statisticsGranted()))).toEqual(['consent-without-action']);
    const custom = { ...cmp, essentialCategories: ['statistics'] };
    expect(variantsOf(runCheck(check, statisticsGranted(), { data: { cmp: custom } }))).toEqual([]);
  });

  it('a banner named by a CMP the adapters know is not "not supported"; one they do not know is', () => {
    const det = visibleBanner().detection;
    const heuristic = (cmpId: string) =>
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            visibleBanner({
              detection: { ...det, cmpId, method: 'heuristic', recognitionConfidence: 'medium' },
            }),
          ],
        }),
      });
    expect(variantsOf(runCheck(consent04, heuristic('cookiehub')))).toEqual(['banner-not-recognized']);
    expect(variantsOf(runCheck(consent04, heuristic('onetrust')))).toEqual(['cmp-not-supported']);
  });

  it('data without the adapter section is a check error that names the section', () => {
    const { adapters: _adapters, ...withoutAdapters } = cmp;
    const det = visibleBanner().detection;
    const r = runCheck(
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
      { data: { cmp: withoutAdapters } },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/test\/data\/cmp: section "adapters:" is missing/);
  });
});
