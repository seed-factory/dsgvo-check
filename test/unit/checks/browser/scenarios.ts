/**
 * Fixture scenarios for test/fixtures/snapshots/browser/<ID>/ (violation / clean / inconclusive per check).
 * `generate-fixtures.ts` writes them as JSON; `fixtures.test.ts` checks that the files are up to date.
 * Scenarios must not depend on the CMP first-layer classifier (owner M2): CONSENT-04 fixtures use check-level
 * variants or paths that do not call it.
 */

import type { Snapshot } from '../../../../src/core/snapshot.ts';
import type { FixtureExpect } from '../../../utils/snapshot-builder.ts';
import { makeCmpFacts, makeDocument, makeDom, makeLink } from '../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  cmpFacts,
  cmpWith,
  cookie,
  defaultDocuments,
  defaultPages,
  IMPRESSUM,
  noBannerCmp,
  PRIVACY,
  page,
  phase,
  privacyDoc,
  req,
  START,
  site,
  storage,
} from './helpers.ts';

const ORIGIN_IMG = 'https://www.example.de/wp-content/uploads';

export interface Scenario {
  file: string;
  description: string;
  expect: FixtureExpect;
  build: () => Snapshot;
}

const ga = {
  lib: (id: string, p = {}) => req(id, 'https://www.googletagmanager.com/gtag/js?id=G-TEST1', p),
  /** GA4 page_view whose non-empty `cid` (catalog identifier param) was seen by the collector before redaction. */
  hit: (id: string, p = {}) =>
    req(id, 'https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST1&cid=[redacted]&en=page_view', {
      resourceType: 'ping',
      identifierPresent: true,
      identifierNames: ['cid'],
      eventType: 'page_view',
      ...p,
    }),
};

/** Reject confirmed by state (03-checks §4): changed by our click (`action`), then read back after the reload. */
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

export const SCENARIOS: Record<string, Scenario[]> = {
  'CONSENT-01': [
    {
      file: 'violation-ga4-hit.json',
      description:
        'GA4 library and a page_view hit before any interaction whose cid matches the stored _ga (stored-match); replicated in B before the click; Google Fonts is routed to EMBED-01',
      expect: { status: 'completed', variants: ['tracking-completed'] },
      build: () =>
        site({
          phases: [
            phase('A', {
              requests: [
                ga.lib('A-1'),
                ga.hit('A-2', { matchesStoredIdentifier: true }),
                req('A-3', 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet' }),
              ],
            }),
            phase('B', { click: click('reject'), requests: [ga.hit('B-1', { phase: 'B' })] }),
          ],
        }),
    },
    {
      file: 'clean-after-accept-only.json',
      description:
        'GA4 is loaded only after "Alle akzeptieren" in phase C; before that only first-party requests',
      expect: { status: 'completed', variants: [] },
      build: () =>
        site({
          phases: [
            phase('A', { requests: [req('A-1', `${START}wp-content/themes/x/app.js`)] }),
            phase('C', {
              click: click('accept'),
              requests: [
                ga.lib('C-1', { phase: 'C', afterClick: true }),
                ga.hit('C-2', { phase: 'C', afterClick: true }),
              ],
            }),
          ],
        }),
    },
    {
      file: 'inconclusive-bot-mode.json',
      description:
        'Cookiebot reports isSpider(): the consent evaluation is not representative (SCAN-BOTMODE)',
      expect: { status: 'inconclusive', variants: [], reason: 'bot-mode' },
      build: () =>
        site({
          phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] })],
          cmp: cmpWith({
            phase: 'A',
            facts: [
              cmpFacts({ phase: 'A', botSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] }),
            ],
          }),
        }),
    },
  ],

  'CONSENT-02': [
    {
      file: 'violation-ga-cookie.json',
      description: '_ga written by script before any interaction; the CMP consent cookie is allowlisted',
      expect: { status: 'completed', variants: ['tracking-identifier-stored'] },
      build: () =>
        site({
          phases: [
            phase('A', {
              cookies: [
                cookie('_ga', { setter: 'script', setterHost: 'www.googletagmanager.com' }),
                cookie('CookieConsent', { setter: 'script' }),
              ],
            }),
          ],
        }),
    },
    {
      file: 'clean-allowlist-only.json',
      description:
        'Only allowlisted session, CSRF and consent-state keys (own CMP, consentmanager, Usercentrics, Sourcepoint, Funding Choices) before any interaction',
      expect: { status: 'completed', variants: [] },
      build: () =>
        site({
          phases: [
            phase('A', {
              cookies: [
                cookie('PHPSESSID', {
                  lifetime: { kind: 'session' },
                  setter: 'http-response',
                  httpOnly: true,
                }),
                cookie('XSRF-TOKEN', { setter: 'http-response' }),
                cookie('borlabs-cookie'),
                // Consent state on the origin of the consent vendor (G36): third-party, persistent.
                ...['__cmpcpc', '__cmpcccx144007_expire', 'FCNEC', '_sp_su'].map((name) =>
                  cookie(name, {
                    domain: 'cmp.consent-vendor.test',
                    firstParty: false,
                    setter: 'http-response',
                  }),
                ),
              ],
              storage: ['ucData_abc123', '_sp_local_state'].map((key) =>
                storage(key, { origin: 'https://cmp.consent-vendor.test', firstParty: false }),
              ),
            }),
          ],
        }),
    },
    {
      file: 'inconclusive-bot-mode.json',
      description:
        'Real Cookie Banner accepts everything for bots: storage before interaction is not evaluated',
      expect: { status: 'inconclusive', variants: [], reason: 'bot-mode' },
      build: () =>
        site({
          phases: [phase('A', { cookies: [cookie('_ga')] })],
          cmp: cmpWith({
            phase: 'A',
            facts: [
              cmpFacts({
                phase: 'A',
                detection: { ...cmpFacts().detection, cmpId: 'real-cookie-banner' },
                botSignals: [{ cmpId: 'real-cookie-banner', signal: 'rcb:accept-all-for-bots' }],
              }),
            ],
          }),
        }),
    },
  ],

  'CONSENT-03': [
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
  ],

  'CONSENT-04': [
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
  ],

  'CONSENT-05': [
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
  ],

  'TRACK-01': [
    {
      file: 'violation-ga4-event-sent.json',
      description: 'GA4 library and page_view before any interaction: inventory with stage event-sent',
      expect: { status: 'completed', variants: ['service-inventory'] },
      build: () => site({ phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] })] }),
    },
    {
      file: 'clean-source-reference-only.json',
      description: 'GTM and GA are only mentioned in an inline script without any executed request',
      expect: { status: 'completed', variants: [] },
      build: () =>
        site({
          phases: [
            phase('A', {
              pages: [
                page(START, 'start', 'A', {
                  dom: makeDom({ scripts: [{ src: null, inline: true }], links: [] }),
                }),
                ...defaultPages('A').slice(1),
              ],
            }),
          ],
        }),
    },
    {
      file: 'inconclusive-no-network.json',
      description: 'The browser section has no visited pages: the network slice is missing',
      expect: { status: 'inconclusive', variants: [], reason: 'no-network-observation' },
      build: () => site({ phases: [phase('A', { status: 'failed', pages: [] })] }),
    },
  ],

  'EMBED-01': [
    {
      file: 'violation-google-fonts.json',
      description: 'Google Fonts CSS and a font file from fonts.gstatic.com before any interaction',
      expect: { status: 'completed', variants: ['fonts-loaded'] },
      build: () =>
        site({
          phases: [
            phase('A', {
              requests: [
                req('A-1', 'https://fonts.googleapis.com/css2?family=Roboto&display=swap', {
                  resourceType: 'stylesheet',
                }),
                req('A-2', 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2', {
                  resourceType: 'font',
                }),
              ],
            }),
          ],
        }),
    },
    {
      file: 'clean-self-hosted.json',
      description: 'The same fonts are served from the site itself',
      expect: { status: 'completed', variants: [] },
      build: () =>
        site({
          phases: [
            phase('A', {
              requests: [
                req('A-1', `${START}wp-content/uploads/fonts/roboto.css`, { resourceType: 'stylesheet' }),
                req('A-2', `${START}wp-content/uploads/fonts/roboto.woff2`, { resourceType: 'font' }),
              ],
            }),
          ],
        }),
    },
    {
      file: 'inconclusive-no-network.json',
      description: 'Phase A did not run: whether fonts are loaded cannot be established',
      expect: { status: 'inconclusive', variants: [], reason: 'no-network-observation' },
      build: () => site({ phases: [phase('A', { status: 'skipped', pages: [] })] }),
    },
  ],

  'EMBED-02': [
    {
      file: 'violation-maps-contact.json',
      description: 'The Kontakt page embeds Google Maps (iframe) without any action',
      expect: { status: 'completed', variants: ['maps-loaded'] },
      build: () =>
        site({
          phases: [
            phase('A', {
              requests: [
                req('A-1', 'https://www.google.com/maps/embed?pb=[redacted]', {
                  pageUrl: CONTACT,
                  resourceType: 'document',
                  isNavigation: true,
                  isMainFrame: false,
                  frameUrl: 'https://www.google.com/maps/embed?pb=[redacted]',
                }),
                req('A-2', 'https://maps.googleapis.com/maps/vt?pb=[redacted]', {
                  pageUrl: CONTACT,
                  resourceType: 'image',
                }),
              ],
            }),
          ],
        }),
    },
    {
      file: 'clean-two-click-placeholder.json',
      description:
        'Kontakt shows a two-click placeholder and a plain link to Google Maps; no request to a map service',
      expect: { status: 'completed', variants: [] },
      build: () =>
        site({
          phases: [
            phase('A', {
              pages: [
                ...defaultPages('A').slice(0, 3),
                page(CONTACT, 'contact', 'A', {
                  dom: makeDom({
                    links: [
                      makeLink({
                        text: 'Route planen',
                        href: 'https://maps.google.com/?q=[redacted]',
                        region: 'main',
                      }),
                    ],
                    embedPlaceholders: [{ kind: 'maps', text: 'Karte laden' }],
                  }),
                }),
              ],
              requests: [
                req('A-1', `${ORIGIN_IMG}/anfahrt.png`, { pageUrl: CONTACT, resourceType: 'image' }),
              ],
            }),
          ],
        }),
    },
    {
      file: 'inconclusive-contact-blocked.json',
      description:
        'The Kontakt page was behind a challenge and could not be evaluated; no map request elsewhere',
      expect: { status: 'inconclusive', variants: [], reason: 'contact-page-not-evaluable' },
      build: () =>
        site({
          phases: [
            phase('A', {
              pages: [
                ...defaultPages('A').slice(0, 3),
                page(CONTACT, 'contact', 'A', {
                  evaluable: false,
                  notEvaluableReason: 'challenge',
                  challenge: { detected: true, kind: 'cloudflare', signals: ['title:Just a moment'] },
                }),
              ],
            }),
          ],
        }),
    },
  ],

  'LEGAL-01': [
    {
      file: 'violation-no-documents.json',
      description:
        'No legal links on any page, no document via Kontakt, fallbacks /impressum and /datenschutz return 404',
      expect: { status: 'completed', variants: ['document-not-found'] },
      build: () =>
        site({
          phases: [
            phase('A', {
              pages: [page(START, 'start', 'A', {}, []), page(CONTACT, 'contact', 'A', {}, [])],
            }),
          ],
          documents: {
            documents: [],
            attempts: [
              { kind: 'impressum', via: 'hop', url: CONTACT, status: 200, outcome: 'not-found' },
              { kind: 'impressum', via: 'fallback', url: IMPRESSUM, status: 404, outcome: 'not-found' },
              { kind: 'privacy', via: 'fallback', url: PRIVACY, status: 404, outcome: 'not-found' },
            ],
          },
        }),
    },
    {
      file: 'clean-footer-links.json',
      description: 'Working Impressum and Datenschutz links on every evaluated page',
      expect: { status: 'completed', variants: [] },
      build: () => site(),
    },
    {
      file: 'inconclusive-targets-blocked.json',
      description:
        'Pages without legal links; every attempt to reach the legal documents ends in a challenge',
      expect: { status: 'inconclusive', variants: [], reason: 'legal-targets-not-evaluable' },
      build: () =>
        site({
          phases: [
            phase('A', { pages: [page(START, 'start', 'A', {}, []), page(CONTACT, 'contact', 'A', {}, [])] }),
          ],
          documents: {
            documents: [],
            attempts: [
              { kind: 'impressum', via: 'fallback', url: IMPRESSUM, status: 403, outcome: 'error' },
              { kind: 'privacy', via: 'fallback', url: PRIVACY, status: 403, outcome: 'error' },
            ],
          },
        }),
    },
  ],

  'PRIV-01': [
    {
      file: 'violation-trustindex-not-named.json',
      description:
        'Trustindex widget is loaded; the complete German policy mentions neither product, operator, domain nor category',
      expect: { status: 'completed', variants: ['not-named'] },
      build: () =>
        site({
          phases: [phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] })],
        }),
    },
    {
      file: 'clean-operator-in-frame.json',
      description:
        'Same service; the operator is named in an expandable section inside a frame (company level)',
      expect: { status: 'completed', variants: [] },
      build: () =>
        site({
          phases: [phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] })],
          documents: {
            attempts: [],
            documents: [
              defaultDocuments().documents[0]!,
              privacyDoc(
                [
                  {
                    id: 'p1',
                    text: 'Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.',
                    origin: 'visible',
                    sourceUrl: PRIVACY,
                  },
                  {
                    id: 'p2',
                    section: '7 > Bewertungen',
                    text: 'Wir binden ein Widget der Trustindex Kft., Ungarn, ein.',
                    origin: 'frame',
                    sourceUrl: PRIVACY,
                    frameUrl: 'https://policy-generator.example.net/frame',
                  },
                ],
                {
                  manifest: {
                    expandablesFound: 1,
                    expandablesOpened: 1,
                    framesIncluded: 1,
                    linkedPages: 0,
                    textLength: 120,
                  },
                },
              ),
            ],
          },
        }),
    },
    {
      file: 'inconclusive-pdf.json',
      description: 'The privacy policy is only available as PDF: not evaluated in 1.0',
      expect: { status: 'inconclusive', variants: [], reason: 'pdf-not-evaluated' },
      build: () =>
        site({
          phases: [phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] })],
          documents: {
            documents: [
              makeDocument({
                kind: 'privacy',
                id: 'doc-privacy',
                url: `${ORIGIN_IMG}/datenschutz.pdf`,
                format: 'pdf',
                parts: [],
              }),
            ],
            attempts: [],
          },
        }),
    },
  ],
};
