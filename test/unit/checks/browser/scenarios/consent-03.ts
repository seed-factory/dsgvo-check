import { makeCmpFacts } from '../../../../utils/snapshot-builder.ts';
import { cmpWith, cookie, phase, req, START, site } from '../helpers.ts';
import { ga, type Scenario } from './shared.ts';

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
