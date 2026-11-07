/**
 * The first-layer scenarios (blocking-no-reject … pur-abo) run through the real `classifyFirstLayer` and the shipped
 * lexicon, end to end from adapter facts to the finding; the others use check-level variants or early-return paths.
 */

import type { CmpButton, CmpFacts } from '../../../../../src/cmp/types.ts';
import { makeCmpFacts } from '../../../../utils/snapshot-builder.ts';
import {
  bannerCandidate,
  candidateCmp,
  click,
  cmpFacts,
  cmpWith,
  noBannerCmp,
  phase,
  START,
  site,
  unopenedDialogCmp,
  unopenedDialogFacts,
} from '../helpers.ts';
import { crawlerTestSignal, type Scenario } from './shared.ts';

/** First-layer button as the adapter reports it; `kind` is left to the classifier and the lexicon. */
const button = (name: string, p: Partial<CmpButton> = {}): CmpButton => ({
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
  ...p,
});

const OVERLAY: CmpFacts['blocking'] = {
  overlay: true,
  scrollLock: true,
  inert: false,
  coveredRatio: 1,
  method: ['overlay-grid', 'overflow-hidden'],
};
const BAR: CmpFacts['blocking'] = {
  overlay: false,
  scrollLock: false,
  inert: false,
  coveredRatio: 0.18,
  method: ['overlay-grid'],
};

/** Cookiebot (supported, high recognition) shows its first layer on the first screen of phase B. */
const firstLayerSite = (
  buttons: CmpButton[],
  blocking: CmpFacts['blocking'],
  p: { closeMeansAccept?: boolean; purAbo?: boolean } = {},
) =>
  site({
    cmp: cmpWith({
      phase: 'B',
      facts: [
        cmpFacts({
          firstLayer: {
            bannerPresent: true,
            bannerVisible: true,
            buttons,
            purAbo: p.purAbo ?? false,
            closeMeansAccept: p.closeMeansAccept ?? null,
          },
          blocking,
        }),
      ],
    }),
  });

/** Wix recognised by its policy API, the banner script and the banner root, as the adapter reports it. */
const WIX: CmpFacts['detection'] = {
  cmpId: 'wix',
  method: 'adapter',
  version: null,
  versionSupported: null,
  recognitionConfidence: 'high',
  signals: [
    'global:consentPolicyManager',
    'script:static.parastorage.com/services/cookie-consent-banner-for-uou',
    'dom:[data-hook="consent-banner-root"]',
  ],
};

/** The Wix bar at the bottom of the first screen with its policy link and the × in the corner. */
const wixSite = (controls: CmpButton[]) =>
  site({
    cmp: cmpWith({
      phase: 'B',
      facts: [
        cmpFacts({
          detection: WIX,
          firstLayer: {
            bannerPresent: true,
            bannerVisible: true,
            buttons: [
              button('Zur Datenschutzerklärung', { role: 'link', tag: 'a' }),
              ...controls,
              button('Schließen', { vendorRole: 'close', box: { x: 1240, y: 600, width: 32, height: 32 } }),
            ],
            purAbo: false,
            closeMeansAccept: null,
          },
          blocking: { ...BAR, coveredRatio: 0.17 },
        }),
      ],
    }),
  });

/**
 * A Wix first layer with only settings and accept next to its × does not block the page and has no reject; the × is a
 * close button, never taken for one. With "Alle ablehnen" on the first layer there is nothing to report.
 */
const wixScenarios: Scenario[] = [
  {
    file: 'violation-wix-settings-and-accept-only.json',
    description:
      'Wix bar with "Cookie-Einstellungen", "Zustimmen" and ×, not blocking: no reject on the first layer, the × does not count as one',
    expect: { status: 'completed', variants: ['nonblocking-no-reject'] },
    build: () =>
      wixSite([
        button('Cookie-Einstellungen', { vendorRole: 'settings' }),
        button('Zustimmen', { vendorRole: 'accept' }),
      ]),
  },
  {
    file: 'clean-wix-reject-at-first-layer.json',
    description:
      'Counterexample: the same Wix bar with "Alle ablehnen" next to "Zustimmen": nothing to report',
    expect: { status: 'completed', variants: [] },
    build: () =>
      wixSite([
        button('Einstellungen', { role: 'button', tag: 'span', vendorRole: 'settings' }),
        button('Alle ablehnen', { vendorRole: 'reject' }),
        button('Zustimmen', { vendorRole: 'accept' }),
      ]),
  },
];

/** A banner observed but not recognised gets the same info as a banner the heuristic found; header chrome does not. */
const candidateScenarios: Scenario[] = [
  {
    file: 'inconclusive-banner-candidate.json',
    description:
      'The heuristic dismissed a fixed box with one consent keyword and a settings button on start and Impressum: info "Banner nicht erkannt"',
    expect: {
      status: 'inconclusive',
      variants: ['banner-not-recognized'],
      reason: 'banner-not-recognized',
    },
    build: () => site({ cmp: candidateCmp(bannerCandidate()) }),
  },
  {
    file: 'clean-candidate-in-page-footer.json',
    description:
      'Counterexample: the dismissed candidate is a settings link strip inside the page footer: no banner, nothing to evaluate',
    expect: { status: 'not_applicable', variants: [], reason: 'no-banner' },
    build: () => site({ cmp: candidateCmp(bannerCandidate({ reason: 'page-section', keywordHits: 2 })) }),
  },
];

/**
 * A CCM19 dialog that stayed closed for the scanner: the scan says so without implying what visitors see, and clicks
 * nothing; a hidden dialog with a stored answer and a bot signal are not that case.
 */
const unopenedDialogScenarios: Scenario[] = [
  {
    file: 'inconclusive-cmp-dialog-not-opened.json',
    description:
      'CCM19 recognised; its dialog is in the page, hidden with disabled controls and no answer stored, also after the wait in phase B: nothing clicked, no finding',
    expect: { status: 'inconclusive', variants: [], reason: 'cmp-dialog-not-opened' },
    build: () => site({ phases: [phase('A'), phase('B')], cmp: unopenedDialogCmp() }),
  },
  {
    file: 'inconclusive-hidden-dialog-answered.json',
    description:
      'Counterexample: the same hidden dialog with an answer stored is not "not opened"; the first layer stays not visible',
    expect: { status: 'inconclusive', variants: [], reason: 'first-layer-not-visible' },
    build: () =>
      site({
        phases: [phase('A'), phase('B')],
        cmp: cmpWith({
          phase: 'B',
          facts: [
            unopenedDialogFacts(
              {
                state: [
                  {
                    source: 'api',
                    ready: 'ready',
                    categories: { embeddings: 'denied' },
                    origin: 'stored',
                    decision: { responded: true, method: 'explicit' },
                  },
                ],
              },
              false,
            ),
          ],
        }),
      }),
  },
  {
    file: 'inconclusive-cmp-bot-user-agent.json',
    description:
      "CCM19's own crawler test matched the scanner's User-Agent and its dialog stayed closed: the reason names the crawler test, nothing clicked, no finding",
    expect: { status: 'inconclusive', variants: [], reason: 'cmp-bot-user-agent' },
    build: () =>
      site({
        phases: [phase('A'), phase('B')],
        cmp: unopenedDialogCmp({ botSignals: [crawlerTestSignal] }),
      }),
  },
  {
    file: 'inconclusive-dialog-not-opened-bot-signal.json',
    description:
      'Counterexample: the adapter reports a bot branch next to the closed dialog: the bot signal decides (bot-mode)',
    expect: { status: 'inconclusive', variants: [], reason: 'bot-mode' },
    build: () =>
      site({
        phases: [phase('A'), phase('B')],
        cmp: unopenedDialogCmp({ botSignals: [{ cmpId: 'ccm19', signal: 'ccm19:bot-branch' }] }),
      }),
  },
];

export const scenarios: Scenario[] = [
  ...candidateScenarios,
  ...wixScenarios,
  ...unopenedDialogScenarios,
  {
    file: 'violation-consent-without-action.json',
    description:
      'Cookiebot (2 signals, supported) reports statistics and marketing granted from stored state without any click',
    expect: { status: 'completed', variants: ['consent-without-action'] },
    build: () =>
      site({
        phases: [phase('A')],
        cmp: cmpWith({
          phase: 'A',
          facts: [
            cmpFacts({
              phase: 'A',
              moment: 'phase-end',
              firstLayer: {
                bannerPresent: true,
                bannerVisible: false,
                buttons: [],
                purAbo: false,
                closeMeansAccept: null,
              },
              state: [
                {
                  source: 'api',
                  ready: 'ready',
                  categories: { necessary: 'granted', statistics: 'granted', marketing: 'granted' },
                  origin: 'stored',
                },
              ],
            }),
          ],
        }),
      }),
  },
  {
    file: 'clean-no-banner.json',
    description:
      'No banner candidate and no CMP state: nothing to evaluate for the first layer (CONSENT-03 territory)',
    expect: { status: 'not_applicable', variants: [], reason: 'no-banner' },
    build: () => site({ cmp: noBannerCmp(['A', 'B']) }),
  },
  {
    file: 'inconclusive-banner-not-recognized.json',
    description:
      'Heuristic banner candidate without a supported adapter: info "Banner nicht erkannt", no verdict',
    expect: {
      status: 'inconclusive',
      variants: ['banner-not-recognized'],
      reason: 'banner-not-recognized',
    },
    build: () =>
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            makeCmpFacts({
              phase: 'B',
              pageUrl: START,
              detection: {
                cmpId: null,
                method: 'heuristic',
                version: null,
                versionSupported: null,
                recognitionConfidence: 'low',
                signals: ['heuristic:fixed-bottom-dialog'],
              },
              firstLayer: {
                bannerPresent: true,
                bannerVisible: true,
                buttons: [],
                purAbo: false,
                closeMeansAccept: null,
              },
            }),
          ],
        }),
      }),
  },
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-reject-ineffective.json',
    description:
      'Cookiebot recognised, first layer not visible on the recorded screen; the reject was clicked, but the ready CMP state afterwards still grants statistics',
    expect: { status: 'completed', variants: ['reject-ineffective'] },
    build: () =>
      site({
        phases: [phase('A'), phase('B', { click: click('reject') })],
        cmp: cmpWith({
          phase: 'B',
          facts: [cmpFacts()],
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
  },
  {
    file: 'inconclusive-cmp-version-not-supported.json',
    description:
      'Cookiebot recognised with high confidence, but in a version outside the supported range: info, no verdict',
    expect: { status: 'inconclusive', variants: ['cmp-not-supported'], reason: 'cmp-not-supported' },
    build: () =>
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            cmpFacts({
              detection: { ...cmpFacts().detection, version: '1.0.0', versionSupported: false },
              firstLayer: {
                bannerPresent: true,
                bannerVisible: true,
                buttons: [],
                purAbo: false,
                closeMeansAccept: null,
              },
            }),
          ],
        }),
      }),
  },
  {
    file: 'violation-blocking-no-reject.json',
    description: 'Blocking overlay with "Alle akzeptieren" and "Einstellungen"; no reject on the first layer',
    expect: { status: 'completed', variants: ['blocking-no-reject'] },
    build: () => firstLayerSite([button('Alle akzeptieren'), button('Einstellungen')], OVERLAY),
  },
  {
    file: 'violation-nonblocking-no-reject.json',
    description: 'Non-blocking bar with "Akzeptieren" and "Mehr Optionen"; no reject on the first layer',
    expect: { status: 'completed', variants: ['nonblocking-no-reject'] },
    build: () => firstLayerSite([button('Akzeptieren'), button('Mehr Optionen')], BAR),
  },
  {
    file: 'violation-settings-only.json',
    description:
      'Blocking overlay that offers only "Einstellungen": neither accept nor reject on the first layer',
    expect: { status: 'completed', variants: ['no-choice-at-first-layer'] },
    build: () => firstLayerSite([button('Einstellungen')], OVERLAY),
  },
  {
    file: 'violation-close-means-accept.json',
    description: 'Bar with reject, accept and a × button that the CMP configuration treats as accept',
    expect: { status: 'completed', variants: ['close-means-accept'] },
    build: () =>
      firstLayerSite([button('Ablehnen'), button('Alle akzeptieren'), button('×')], BAR, {
        closeMeansAccept: true,
      }),
  },
  {
    file: 'violation-reject-not-actionable.json',
    description:
      'Blocking overlay; "Ablehnen" is rendered but covered on the first screen, "Alle akzeptieren" works',
    expect: { status: 'completed', variants: ['reject-not-actionable'] },
    build: () =>
      firstLayerSite(
        [
          button('Ablehnen', { actionableAtFirstScreen: false, hitTestOk: false }),
          button('Alle akzeptieren'),
        ],
        OVERLAY,
      ),
  },
  {
    file: 'violation-reject-as-link.json',
    description: 'Blocking overlay; the reject is a text link while the accept is a button',
    expect: { status: 'completed', variants: ['reject-as-link'] },
    build: () =>
      firstLayerSite([button('Ablehnen', { role: 'link', tag: 'a' }), button('Alle akzeptieren')], OVERLAY),
  },
  {
    file: 'violation-pur-abo.json',
    description:
      'Bar with reject and accept; the CMP reports a paid subscription as the alternative to consent',
    expect: { status: 'completed', variants: ['pur-abo'] },
    build: () => firstLayerSite([button('Ablehnen'), button('Alle akzeptieren')], BAR, { purAbo: true }),
  },
];
