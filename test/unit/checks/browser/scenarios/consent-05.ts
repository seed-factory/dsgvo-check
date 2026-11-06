import type { CmpFacts } from '../../../../../src/cmp/types.ts';
import {
  bannerCandidate,
  CONTACT,
  candidateCmp,
  click,
  cmpFacts,
  cmpWith,
  consentPages,
  controlPageFacts,
  cookie,
  IMPRESSUM,
  noBannerCmp,
  phase,
  req,
  SHOP_HOST,
  settingsClick,
  settingsRejectCmp,
  settingsRejectPlan,
  site,
  unopenedDialogCmp,
} from '../helpers.ts';
import { confirmedReject, ga, type Scenario } from './shared.ts';

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

/**
 * A Wix-like bar with only "Cookie-Einstellungen" and "Zustimmen": phase B rejects with the save control of the
 * settings layer, where every optional group was already off. GA4 sends a page_view with identifier after the save.
 */
const afterSettingsSave = (hits: boolean) =>
  phase('B', {
    click: settingsClick(),
    reloaded: true,
    requests: hits
      ? [ga.hit('B-1', { phase: 'B', afterClick: true, tRef: 'click', tStartMs: 2_500 })]
      : [ga.hit('B-1', { phase: 'B', afterClick: false, tStartMs: 800 })],
  });

const settingsScenarios: Scenario[] = [
  {
    file: 'violation-tracking-after-settings-reject.json',
    description:
      'No reject on the first layer; the reject was saved in the settings layer with every optional group off and confirmed by the platform policy; afterwards a GA4 page_view with identifier',
    expect: { status: 'completed', variants: ['tracking-after-reject'] },
    build: () =>
      site({
        phases: [phase('A'), afterSettingsSave(true)],
        cmp: settingsRejectCmp(),
        plan: settingsRejectPlan(),
      }),
  },
  {
    file: 'clean-settings-reject.json',
    description:
      'Reject saved in the settings layer and confirmed; GA4 sent its page_view only before the save, while the settings were open',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [phase('A'), afterSettingsSave(false)],
        cmp: settingsRejectCmp(),
        plan: settingsRejectPlan(),
      }),
  },
  {
    file: 'inconclusive-settings-reject-not-confirmed.json',
    description:
      'The save in the settings layer left the platform policy at its default: reject not confirmed, the GA4 page_view after it is no finding',
    expect: { status: 'inconclusive', variants: [], reason: 'reject-not-confirmed' },
    build: () =>
      site({
        phases: [phase('A'), afterSettingsSave(true)],
        cmp: settingsRejectCmp({ confirmed: false }),
        plan: settingsRejectPlan(),
      }),
  },
  {
    file: 'inconclusive-settings-preselected-groups.json',
    description:
      'Counterexample: an optional group in the settings layer was already on, so nothing was saved (switches are never toggled): no reject click, the reason names the pre-checked group',
    expect: { status: 'inconclusive', variants: [], reason: 'no-reject-click' },
    build: () =>
      site({
        phases: [phase('A'), phase('B', { requests: [ga.hit('B-1', { phase: 'B' })] })],
        cmp: settingsRejectCmp({ pressed: false }),
        plan: settingsRejectPlan('preselected-groups'),
      }),
  },
];

/** The confirmed reject of `confirmedReject`, plus the facts read on the control pages. */
const rejectWithControlPages = (control: CmpFacts[]) => {
  const cmp = confirmedReject();
  const b = cmp.phases[0]!;
  return cmpWith({ ...b, facts: [...b.facts, ...control] });
};

const OTHER_HOST_PAGE = `${SHOP_HOST}/kontakt`;

/**
 * After the confirmed reject, phase B visits `control` and GA sends a page_view on each page of `hitsOn`: the start
 * page after the click, the reload and the control pages.
 */
const afterRejectOn = (control: string[], hitsOn: string[]) =>
  phase('B', {
    click: click('reject'),
    reloaded: true,
    pages: consentPages('B', control),
    requests: hitsOn.map((pageUrl, i) =>
      ga.hit(`B-${i + 1}`, { phase: 'B', afterClick: true, tRef: 'click', tStartMs: 2_500, pageUrl }),
    ),
  });

/**
 * Each control page counts only where the CMP facts recorded there show the reject in effect: a control page that shows
 * the banner again without an answer (a consent cookie bound to the host of the click page) is no page after the reject.
 */
const controlPageScenarios: Scenario[] = [
  {
    file: 'violation-tracking-on-control-page-after-reject.json',
    description:
      'Reject confirmed; the contact page reads the stored reject back, and GA4 sends a page_view with identifier there',
    expect: { status: 'completed', variants: ['tracking-after-reject'] },
    build: () =>
      site({
        phases: [phase('A'), afterRejectOn([CONTACT], [CONTACT])],
        cmp: rejectWithControlPages([controlPageFacts(CONTACT, 'B', true)]),
      }),
  },
  {
    file: 'inconclusive-reject-not-in-effect-on-control-page.json',
    description:
      'Reject confirmed on the start page; the control page on another host shows the banner again without an answer, so its GA4 page_view is no tracking after the reject and the page is not evaluated',
    expect: { status: 'partial', variants: [] },
    build: () =>
      site({
        phases: [phase('A'), afterRejectOn([CONTACT, OTHER_HOST_PAGE], [OTHER_HOST_PAGE])],
        cmp: rejectWithControlPages([
          controlPageFacts(CONTACT, 'B', true),
          controlPageFacts(OTHER_HOST_PAGE, 'B', false),
        ]),
      }),
  },
  {
    file: 'clean-control-pages-after-reject.json',
    description: 'Reject confirmed; both control pages read the stored reject back and send nothing',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [phase('A'), afterRejectOn([CONTACT, IMPRESSUM], [])],
        cmp: rejectWithControlPages([
          controlPageFacts(CONTACT, 'B', true),
          controlPageFacts(IMPRESSUM, 'B', true),
        ]),
      }),
  },
  {
    file: 'violation-tracking-on-other-host-with-shared-reject.json',
    description:
      'Counterexample: the control page on another host of the site reads the stored reject back (a consent cookie for the whole domain), so its GA4 page_view counts after the reject',
    expect: { status: 'completed', variants: ['tracking-after-reject'] },
    build: () =>
      site({
        phases: [phase('A'), afterRejectOn([OTHER_HOST_PAGE], [OTHER_HOST_PAGE])],
        cmp: rejectWithControlPages([controlPageFacts(OTHER_HOST_PAGE, 'B', true)]),
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
  ...settingsScenarios,
  ...controlPageScenarios,
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
