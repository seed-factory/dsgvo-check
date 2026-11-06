import { makeDom, makeLink } from '../../../../utils/snapshot-builder.ts';
import { CONTACT, click, defaultPages, page, phase, rejectCmp, req, START, site } from '../helpers.ts';
import { ORIGIN_IMG, type Scenario } from './shared.ts';

export const scenarios: Scenario[] = [
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
    file: 'violation-maps-after-reject.json',
    description:
      'The Kontakt page embeds Google Maps before any interaction and again as a control page after the reject, which the CMP state confirms',
    expect: { status: 'completed', variants: ['maps-loaded'] },
    build: () => {
      const map = (id: string, p = {}) =>
        req(id, 'https://www.google.com/maps/embed?pb=[redacted]', {
          pageUrl: CONTACT,
          resourceType: 'document',
          isNavigation: true,
          isMainFrame: false,
          frameUrl: 'https://www.google.com/maps/embed?pb=[redacted]',
          ...p,
        });
      return site({
        phases: [
          phase('A', { requests: [map('A-1')] }),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            pages: [
              page(START, 'start', 'B'),
              page(START, 'start', 'B', { reload: true }),
              page(CONTACT, 'contact', 'B'),
            ],
            requests: [map('B-1', { phase: 'B', afterClick: true })],
          }),
        ],
        cmp: rejectCmp({ confirmed: true, pages: { [CONTACT]: 'in-effect' } }),
      });
    },
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
            requests: [req('A-1', `${ORIGIN_IMG}/anfahrt.png`, { pageUrl: CONTACT, resourceType: 'image' })],
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
];
