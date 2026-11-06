import {
  bannerCandidate,
  candidateCmp,
  click,
  cmpFacts,
  cmpWith,
  cookie,
  noBannerCmp,
  phase,
  req,
  site,
  unopenedDialogCmp,
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

/** Shopware's permission cookies, named by the adapter: none present after "Nur technisch notwendige". */
const SHOPWARE_DENIED = {
  'google-analytics-enabled': 'denied',
  'google-ads-enabled': 'denied',
  'wishlist-enabled': 'denied',
  'youtube-video': 'denied',
  'vimeo-video': 'denied',
} as const;

/**
 * A Shopware reject read from the cookie source: our click set the answer cookie, no permission cookie the adapter knows
 * is present, and the same holds after the reload. With one of them present the reject is not confirmed.
 */
const shopwareReject = (categories: Record<string, 'denied' | 'granted'> = SHOPWARE_DENIED) => {
  const answered = {
    source: 'cookie',
    ready: 'ready',
    categories,
    decision: { responded: true, method: 'explicit' },
  } as const;
  const confirmed = Object.values(categories).every((v) => v === 'denied');
  return cmpWith({
    phase: 'B',
    facts: [cmpFacts(), cmpFacts({ moment: 'after-reload', state: [{ ...answered, origin: 'stored' }] })],
    click: {
      action: 'reject',
      clicked: true,
      button: { name: 'Nur technisch notwendige', role: 'button', kind: 'reject', kindConfidence: 'high' },
    },
    verify: {
      action: 'reject',
      verified: confirmed,
      method: confirmed ? ['cookie:known-flags-absent', 'decision:responded', 'origin:action'] : [],
      stateAfter: [{ ...answered, origin: 'action' }],
      persistedAfterReload: confirmed,
      ...(confirmed ? {} : { reason: 'cookie:not-all-denied' }),
    },
  });
};

/** After the Shopware reject: a Google Ads conversion hit with `auid` and the conversion linker cookie, a GA4 ping. */
const shopwareAfterReject = () =>
  phase('B', {
    click: { ...click('reject'), cmpId: 'shopware', name: 'Nur technisch notwendige' },
    reloaded: true,
    requests: [
      req(
        'B-1',
        'https://www.googleadservices.com/pagead/conversion/123456789/?auid=[redacted]&en=page_view',
        {
          phase: 'B',
          afterClick: true,
          tRef: 'click',
          tStartMs: 2_500,
          resourceType: 'image',
          identifierPresent: true,
          identifierNames: ['auid'],
        },
      ),
      req('B-2', 'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST1&gcs=G100&en=page_view', {
        phase: 'B',
        afterClick: true,
        tRef: 'click',
        tStartMs: 2_600,
        resourceType: 'ping',
      }),
    ],
    cookies: [cookie('_gcl_au', { phase: 'B', afterClick: true })],
  });

const shopwareScenarios: Scenario[] = [
  {
    file: 'violation-shopware-known-flags-absent.json',
    description:
      'Shopware reject confirmed by its answer cookie and the absence of every known permission cookie; afterwards Google Ads with the conversion linker cookie and a cookieless GA4 ping',
    expect: { status: 'completed', variants: ['cookieless-ping-after-reject', 'tracking-after-reject'] },
    build: () => site({ phases: [phase('A'), shopwareAfterReject()], cmp: shopwareReject() }),
  },
  {
    file: 'inconclusive-shopware-known-flag-set-by-reject.json',
    description:
      'Counterexample: the Shopware reject set the analytics permission cookie, so it is not confirmed and the same traffic gives no finding',
    expect: { status: 'inconclusive', variants: [], reason: 'reject-not-confirmed' },
    build: () =>
      site({
        phases: [phase('A'), shopwareAfterReject()],
        cmp: shopwareReject({ ...SHOPWARE_DENIED, 'google-analytics-enabled': 'granted' }),
      }),
  },
];

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
  {
    file: 'inconclusive-cmp-dialog-not-opened.json',
    description:
      'CCM19 recognised, its dialog in the page but not opened for the scanner: no reject was clicked, the reason says why',
    expect: { status: 'inconclusive', variants: [], reason: 'cmp-dialog-not-opened' },
    build: () =>
      site({
        phases: [phase('A'), phase('B', { requests: [ga.hit('B-1', { phase: 'B' })] })],
        cmp: unopenedDialogCmp(),
      }),
  },
];

export const scenarios: Scenario[] = [
  ...bannerScenarios,
  ...shopwareScenarios,
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
