import type { RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { makeDom } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  defaultPages,
  footerLinks,
  page,
  phase,
  rejectCmp,
  req,
  START,
  site,
  unopenedDialogCmp,
} from '../helpers.ts';
import { crawlerTestSignal, type Scenario } from './shared.ts';

export const MAP_EMBED = 'https://www.google.com/maps/embed?pb=[redacted]';
export const FRAME_CSS = 'https://fonts.googleapis.com/css?family=Roboto:300,400,500';
export const FRAME_FONT = 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2';

/** A request of the Google Maps frame on Kontakt; the frame id names its phase, as the collector records it. */
export const inMapFrame = (
  id: string,
  url: string,
  resourceType: RequestRecord['resourceType'],
  p: Partial<RequestRecord> = {},
): RequestRecord =>
  req(id, url, {
    pageUrl: CONTACT,
    isMainFrame: false,
    frameId: `${p.phase ?? 'A'}-map`,
    frameUrl: MAP_EMBED,
    resourceType,
    ...p,
  });

/** The map document of the frame, then the Google Fonts stylesheet and font file the frame loads. */
export const mapWithFonts = (prefix: string, p: Partial<RequestRecord> = {}): RequestRecord[] => [
  inMapFrame(`${prefix}-1`, MAP_EMBED, 'document', { isNavigation: true, ...p }),
  inMapFrame(`${prefix}-2`, FRAME_CSS, 'stylesheet', p),
  inMapFrame(`${prefix}-3`, FRAME_FONT, 'font', p),
];

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
    file: 'violation-fonts-after-reject.json',
    description:
      'Google Fonts before any interaction and again on the start page after the reject, which the CMP state confirms',
    expect: { status: 'completed', variants: ['fonts-loaded'] },
    build: () => {
      const css = (id: string, p = {}) =>
        req(id, 'https://fonts.googleapis.com/css2?family=Roboto&display=swap', {
          resourceType: 'stylesheet',
          ...p,
        });
      return site({
        phases: [
          phase('A', { requests: [css('A-1')] }),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            pages: [page(START, 'start', 'B'), page(START, 'start', 'B', { reload: true })],
            requests: [css('B-1', { phase: 'B', afterClick: true })],
          }),
        ],
        cmp: rejectCmp({ confirmed: true }),
      });
    },
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
  {
    file: 'violation-fonts-in-map-frame.json',
    description:
      'Kontakt embeds Google Maps, whose frame loads a Google Fonts stylesheet and font file before any interaction',
    expect: { status: 'completed', variants: ['fonts-in-embed-frame'] },
    build: () => site({ phases: [phase('A', { requests: mapWithFonts('A') })] }),
  },
  {
    file: 'clean-map-frame-fonts-after-accept.json',
    description:
      'The map on Kontakt and the fonts of its frame load only after "Alle akzeptieren"; nothing before or after the reject',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A'),
          phase('B', { click: click('reject') }),
          phase('C', {
            click: click('accept'),
            pages: [page(START, 'start', 'C'), page(CONTACT, 'contact', 'C')],
            requests: mapWithFonts('C', { phase: 'C', afterClick: true }),
          }),
        ],
      }),
  },
  {
    file: 'inconclusive-frame-fonts-cmp-bot-user-agent.json',
    description:
      "The map frame on Kontakt loads Google Fonts, and the CMP's own crawler test matched the scanner's User-Agent: whether a visitor gets the fonts before consent is open",
    expect: { status: 'inconclusive', variants: [], reason: 'cmp-bot-user-agent' },
    build: () =>
      site({
        phases: [phase('A', { requests: mapWithFonts('A') }), phase('B')],
        cmp: unopenedDialogCmp({ botSignals: [crawlerTestSignal] }),
      }),
  },
  {
    file: 'clean-map-frame-without-fonts.json',
    description:
      'Counterexample: the map frame on Kontakt loads tiles and a helper host but no font; the map is EMBED-02, EMBED-01 has nothing to report',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              inMapFrame('A-1', MAP_EMBED, 'document', { isNavigation: true }),
              inMapFrame('A-2', 'https://maps.googleapis.com/maps/vt?pb=[redacted]', 'image'),
              inMapFrame('A-3', 'https://helper.unknown-host.example/t.js', 'script'),
            ],
          }),
        ],
      }),
  },
  {
    file: 'violation-site-fonts-beside-map-frame-fonts.json',
    description:
      "Counterexample: the start page loads Google Fonts itself and the map frame on Kontakt loads them too: the site's request stays fonts-loaded, the frame's fonts are a finding of their own",
    expect: { status: 'completed', variants: ['fonts-in-embed-frame', 'fonts-loaded'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            requests: [
              req('A-0', 'https://fonts.googleapis.com/css2?family=Roboto&display=swap', {
                resourceType: 'stylesheet',
              }),
              ...mapWithFonts('A'),
            ],
          }),
        ],
      }),
  },
];
