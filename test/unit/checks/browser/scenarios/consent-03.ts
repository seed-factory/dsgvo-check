import { makeCmpFacts } from '../../../../utils/snapshot-builder.ts';
import {
  bannerCandidate,
  bannerLink,
  CONTACT,
  candidateCmp,
  cmpWith,
  cookie,
  IMPRESSUM,
  noBannerCmp,
  PRIVACY,
  pagesWithLinks,
  phase,
  req,
  START,
  site,
  unopenedDialogCmp,
} from '../helpers.ts';
import { ga, type Scenario } from './shared.ts';

/** Scenarios of a banner observed but not recognised, and what does not count as one. */
const candidateScenarios: Scenario[] = [
  {
    file: 'inconclusive-banner-candidate.json',
    description:
      'The heuristic dismissed a fixed box with one consent keyword and a settings button on start and Impressum; GA hit with identifier: no "no banner" conclusion',
    expect: { status: 'inconclusive', variants: [], reason: 'banner-candidate-unrecognized' },
    build: () =>
      site({
        phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] })],
        cmp: candidateCmp(bannerCandidate()),
      }),
  },
  {
    file: 'inconclusive-banner-undetermined-older-snapshot.json',
    description:
      'Snapshot without the candidate fact: the same visible link of a banner-named container on start and Impressum, a banner or a menu; GA hit with identifier',
    expect: { status: 'inconclusive', variants: [], reason: 'banner-undetermined' },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: pagesWithLinks({ [START]: [bannerLink()], [IMPRESSUM]: [bannerLink()] }),
            requests: [ga.lib('A-1'), ga.hit('A-2')],
          }),
        ],
        cmp: noBannerCmp(),
      }),
  },
  {
    file: 'violation-banner-links-on-one-page-each.json',
    description:
      'Counterexample, older snapshot: banner-named links of the policy table of contents and of the navigation, each on one page only; GA hit with identifier',
    expect: { status: 'completed', variants: ['no-banner-consent-services'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: pagesWithLinks({
              [PRIVACY]: [bannerLink({ text: 'Welche Cookies wir setzen', href: `${PRIVACY}#cookies` })],
              [CONTACT]: [bannerLink({ text: 'Kontakt', href: CONTACT })],
            }),
            requests: [ga.lib('A-1'), ga.hit('A-2')],
          }),
        ],
        cmp: noBannerCmp(),
      }),
  },
  {
    file: 'violation-candidate-newsletter-without-cookie-wording.json',
    description:
      'Counterexample: the dismissed candidate is a fixed newsletter box with the word "Datenschutz" and a "Mehr Informationen" link, no cookie wording; GA hit with identifier',
    expect: { status: 'completed', variants: ['no-banner-consent-services'] },
    build: () =>
      site({
        phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] })],
        cmp: candidateCmp(bannerCandidate({ controls: ['settings', 'other'], cookieWording: false })),
      }),
  },
  {
    file: 'violation-candidate-chat-widget.json',
    description:
      'Counterexample: the dismissed candidate is a fixed chat box with the word "Datenschutz" and no control the lexicon knows; GA hit with identifier',
    expect: { status: 'completed', variants: ['no-banner-consent-services'] },
    build: () =>
      site({
        phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] })],
        cmp: candidateCmp(bannerCandidate({ controls: ['other'] })),
      }),
  },
];

/**
 * A CMP whose dialog stayed closed for the scanner: whether a banner was shown before the services loaded is not known,
 * so no conclusion either way; without anything that needs consent there is nothing to conclude about.
 */
const unopenedDialogScenarios: Scenario[] = [
  {
    file: 'inconclusive-cmp-dialog-not-opened.json',
    description:
      'CCM19 recognised, its dialog in the page but not opened for the scanner; GA hit with identifier before any interaction',
    expect: { status: 'inconclusive', variants: [], reason: 'cmp-dialog-not-opened' },
    build: () =>
      site({
        phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] }), phase('B')],
        cmp: unopenedDialogCmp(),
      }),
  },
  {
    file: 'clean-dialog-not-opened-fonts-only.json',
    description:
      'Counterexample: the same closed CCM19 dialog, but only Google Fonts and a CDN library loaded: nothing needs consent',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-1', 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet' }),
              req('A-2', 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js'),
            ],
          }),
          phase('B'),
        ],
        cmp: unopenedDialogCmp(),
      }),
  },
];

export const scenarios: Scenario[] = [
  {
    file: 'violation-no-banner-ga-region-asserted.json',
    description:
      'No banner candidate on start and Kontakt; GA hit with identifier; EEA region asserted by the user',
    expect: { status: 'completed', variants: ['no-banner-strong-tracking'] },
    build: () =>
      site({
        phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')], cookies: [cookie('_ga')] })],
        environment: {
          egress: { mode: 'direct', region: 'asserted', assertedRegion: 'de', source: 'laut Nutzerangabe' },
        },
      }),
  },
  {
    file: 'clean-fonts-only.json',
    description: 'No banner, but only Google Fonts and a CDN library are loaded: not CONSENT-03',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-1', 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet' }),
              req('A-2', 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js'),
            ],
          }),
        ],
      }),
  },
  {
    file: 'inconclusive-geo.json',
    description: 'TCF reports gdprApplies=false: out-of-region branch (SCAN-GEO)',
    expect: { status: 'inconclusive', variants: [], reason: 'geo' },
    build: () =>
      site({
        phases: [phase('A', { requests: [ga.hit('A-1')] })],
        cmp: cmpWith({
          phase: 'A',
          facts: [
            makeCmpFacts({
              phase: 'A',
              pageUrl: START,
              geoSignals: [{ cmpId: 'tcf', signal: 'tcf:gdprApplies=false' }],
            }),
          ],
        }),
      }),
  },
  ...candidateScenarios,
  ...unopenedDialogScenarios,
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-no-banner-region-unknown.json',
    description:
      'No banner candidate on start and Kontakt; GA hit with identifier, but the region was not asserted by the user',
    expect: { status: 'completed', variants: ['no-banner-consent-services'] },
    build: () => site({ phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] })] }),
  },
];
