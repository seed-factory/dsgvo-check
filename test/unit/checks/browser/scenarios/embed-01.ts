import { makeDom } from '../../../../utils/snapshot-builder.ts';
import { defaultPages, footerLinks, page, phase, req, START, site } from '../helpers.ts';
import type { Scenario } from './shared.ts';

export const scenarios: Scenario[] = [
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
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-preconnect-only.json',
    description: 'The start page preconnects to fonts.gstatic.com, but no font is downloaded',
    expect: { status: 'completed', variants: ['preconnect-only'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {
                dom: makeDom({
                  links: footerLinks(),
                  linkRels: [{ rel: 'preconnect', href: 'https://fonts.gstatic.com/', source: 'dom' }],
                }),
              }),
              ...defaultPages('A').slice(1),
            ],
          }),
        ],
      }),
  },
];
