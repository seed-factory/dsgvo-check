/**
 * The first-layer scenarios (blocking-no-reject … pur-abo) go through the real `classifyFirstLayer` and
 * the shipped lexicon: they exercise the first-layer classification end to end, from adapter facts to the finding.
 * The other scenarios use check-level variants or paths that return before the classifier.
 */

import type { CmpButton, CmpFacts } from '../../../../../src/cmp/types.ts';
import { makeCmpFacts } from '../../../../utils/snapshot-builder.ts';
import { click, cmpFacts, cmpWith, noBannerCmp, phase, START, site } from '../helpers.ts';
import type { Scenario } from './shared.ts';

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

export const scenarios: Scenario[] = [
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
