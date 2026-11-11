import { CONTACT, click, cmpFacts, cmpWith, phase, req, START, site } from '../helpers.ts';
import { ga, type Scenario } from './shared.ts';

export const scenarios: Scenario[] = [
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
    description: 'Cookiebot reports isSpider(): the consent evaluation is not representative (SCAN-BOTMODE)',
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
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-cookieless-ping.json',
    description: 'GA4 Consent Mode ping with denied storage (gcs=G100) before any interaction',
    expect: { status: 'completed', variants: ['cookieless-ping'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-1', 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]', {
                resourceType: 'ping',
                identifierPresent: true,
              }),
            ],
          }),
        ],
      }),
  },
  {
    file: 'violation-first-party-proxy.json',
    description:
      'GA4 collect call with identifier through a first-party tag gateway path before any interaction',
    expect: { status: 'completed', variants: ['first-party-proxy'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-1', `${START}metrics/g/collect?v=2&tid=G-TEST1&cid=[redacted]`, {
                identifierPresent: true,
              }),
            ],
          }),
        ],
      }),
  },
  {
    file: 'violation-libraries-and-unknown-hosts.json',
    description:
      'Before any interaction: the GTM library without a hit, the Stripe SDK and scripts and images of an unknown third-party domain on two pages',
    expect: { status: 'completed', variants: ['library-loaded', 'third-party-resource', 'unknown-host'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-1', 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST1'),
              req('A-2', 'https://js.stripe.com/v3/'),
              req('A-3', 'https://cdn.unknown-widget.net/a.js'),
              req('A-4', 'https://img.unknown-widget.net/b.png', {
                resourceType: 'image',
                pageUrl: CONTACT,
              }),
            ],
          }),
        ],
      }),
  },
  {
    file: 'violation-request-blocked.json',
    description: 'A GA4 hit before any interaction was blocked by the browser and never answered',
    expect: { status: 'completed', variants: ['request-not-completed'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [ga.hit('A-1', { state: 'blocked-by-browser', status: undefined })],
          }),
        ],
      }),
  },
];
