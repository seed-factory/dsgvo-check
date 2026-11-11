import { makeDom } from '../../../../utils/snapshot-builder.ts';
import { defaultPages, page, phase, START, site } from '../helpers.ts';
import { ga, type Scenario } from './shared.ts';

export const scenarios: Scenario[] = [
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
];
