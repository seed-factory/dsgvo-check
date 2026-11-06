import {
  bannerCandidate,
  candidateCmp,
  click,
  cmpFacts,
  cmpWith,
  noBannerCmp,
  phase,
  req,
  site,
} from '../helpers.ts';
import { ga, type Scenario } from './shared.ts';

/** Reject confirmed by state: changed by our click (`action`), then read back after the reload. */
const confirmedReject = () => {
  const denied = {
    source: 'api',
    ready: 'ready',
    categories: { statistics: 'denied', marketing: 'denied' },
    decision: { responded: true, method: 'explicit' },
  } as const;
  return cmpWith({
    phase: 'B',
    facts: [cmpFacts(), cmpFacts({ moment: 'after-reload', state: [{ ...denied, origin: 'stored' }] })],
    click: {
      action: 'reject',
      clicked: true,
      button: { name: 'Ablehnen', role: 'button', kind: 'reject', kindConfidence: 'high' },
    },
    verify: {
      action: 'reject',
      verified: true,
      method: ['api:all-denied', 'persisted-after-reload'],
      stateAfter: [{ ...denied, origin: 'action' }],
      persistedAfterReload: true,
    },
  });
};

/** Without a recognised banner nothing was clicked: a banner observed but not recognised leaves the reject open. */
const bannerScenarios: Scenario[] = [
  {
    file: 'inconclusive-banner-candidate.json',
    description:
      'The heuristic dismissed a fixed box with one consent keyword and a settings button on start and Impressum: no reject was clicked',
    expect: { status: 'inconclusive', variants: [], reason: 'banner-not-recognized' },
    build: () =>
      site({
        phases: [phase('A'), phase('B', { requests: [ga.hit('B-1', { phase: 'B' })] })],
        cmp: candidateCmp(bannerCandidate()),
      }),
  },
  {
    file: 'clean-no-banner.json',
    description: 'Counterexample: no banner and no candidate on any page: there is no reject to evaluate',
    expect: { status: 'not_applicable', variants: [], reason: 'no-banner' },
    build: () =>
      site({
        phases: [phase('A'), phase('B', { requests: [ga.hit('B-1', { phase: 'B' })] })],
        cmp: noBannerCmp(['A', 'B']),
      }),
  },
];

export const scenarios: Scenario[] = [
  ...bannerScenarios,
  {
    file: 'violation-tracking-after-reject.json',
    description:
      'Reject confirmed by CMP state and persisted after reload; afterwards a GA4 page_view with identifier',
    expect: { status: 'completed', variants: ['tracking-after-reject'] },
    build: () =>
      site({
        phases: [
          phase('A'),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            requests: [ga.hit('B-1', { phase: 'B', afterClick: true, tRef: 'click', tStartMs: 2_500 })],
          }),
        ],
        cmp: confirmedReject(),
      }),
  },
  {
    file: 'clean-confirmed-reject.json',
    description:
      'Reject confirmed; after the click only the CMP consent update; a GA request that started before the click is not new',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A'),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            requests: [
              ga.hit('B-1', { phase: 'B', afterClick: false, tStartMs: 800 }),
              req('B-2', 'https://consent.cookiebot.com/logconsent.ashx', {
                phase: 'B',
                afterClick: true,
                resourceType: 'xhr',
              }),
            ],
          }),
        ],
        cmp: confirmedReject(),
      }),
  },
  {
    file: 'inconclusive-reject-not-confirmed.json',
    description: 'The dialog closes after the click but the CMP state stays granted: reject not confirmed',
    expect: { status: 'inconclusive', variants: [], reason: 'reject-not-confirmed' },
    build: () =>
      site({
        phases: [
          phase('A'),
          phase('B', {
            click: click('reject'),
            requests: [ga.hit('B-1', { phase: 'B', afterClick: true })],
          }),
        ],
        cmp: cmpWith({
          phase: 'B',
          facts: [cmpFacts()],
          click: { action: 'reject', clicked: true, button: null },
          verify: {
            action: 'reject',
            verified: false,
            method: [],
            stateAfter: [
              { source: 'api', ready: 'loading', categories: { statistics: 'granted' }, origin: 'default' },
            ],
            persistedAfterReload: null,
          },
        }),
      }),
  },
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-cookieless-ping-after-reject.json',
    description:
      'Reject confirmed by CMP state and persisted after reload; afterwards a GA4 Consent Mode ping with denied storage',
    expect: { status: 'completed', variants: ['cookieless-ping-after-reject'] },
    build: () =>
      site({
        phases: [
          phase('A'),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            requests: [
              req(
                'B-1',
                'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]&en=page_view',
                {
                  phase: 'B',
                  afterClick: true,
                  tRef: 'click',
                  tStartMs: 2_500,
                  resourceType: 'ping',
                  identifierPresent: true,
                  identifierNames: ['cid'],
                },
              ),
            ],
          }),
        ],
        cmp: confirmedReject(),
      }),
  },
];
