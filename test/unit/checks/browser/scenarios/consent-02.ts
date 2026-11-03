import { cmpFacts, cmpWith, cookie, phase, site, storage } from '../helpers.ts';
import type { Scenario } from './shared.ts';

export const scenarios: Scenario[] = [
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
              // Consent state on the origin of the consent vendor : third-party, persistent.
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
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-unknown-persistent-cookies.json',
    description:
      'Before any interaction: an unknown persistent third-party cookie and an unknown persistent first-party cookie; a session cookie is not reported',
    expect: {
      status: 'completed',
      variants: ['unknown-first-party-persistent', 'unknown-third-party-persistent'],
    },
    build: () =>
      site({
        phases: [
          phase('A', {
            cookies: [
              cookie('wpvp1', { domain: 'unknown-tracker.com', firstParty: false }),
              cookie('pref_x'),
              cookie('tmp_x', { lifetime: { kind: 'session' } }),
            ],
          }),
        ],
      }),
  },
  {
    file: 'violation-tracking-cookie-rejected.json',
    description:
      'The browser rejected the _fbp cookie written before any interaction: an attempt, not a stored identifier',
    expect: { status: 'completed', variants: ['storage-rejected-or-attempted'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            cookies: [cookie('_fbp', { state: 'rejected', blockedReasons: ['ThirdPartyPhaseout'] })],
          }),
        ],
      }),
  },
];
