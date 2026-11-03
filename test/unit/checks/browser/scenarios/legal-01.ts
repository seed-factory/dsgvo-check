import { makeDocument, makeLink } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  cmpFacts,
  cmpWith,
  defaultDocuments,
  footerLinks,
  IMPRESSUM,
  PRIVACY,
  page,
  phase,
  START,
  site,
} from '../helpers.ts';
import type { Scenario } from './shared.ts';

export const scenarios: Scenario[] = [
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
    description: 'Pages without legal links; every attempt to reach the legal documents ends in a challenge',
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
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-impressum-link-missing-on-contact.json',
    description: 'The start page links both documents; the Kontakt page links only the Datenschutzerklärung',
    expect: { status: 'completed', variants: ['link-missing-on-some-pages'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: [page(START, 'start'), page(CONTACT, 'contact', 'A', {}, [footerLinks()[1]!])],
          }),
        ],
      }),
  },
  {
    file: 'violation-links-broken.json',
    description:
      'Impressum and Datenschutz links lead to HTTP 404, the visited legal pages answer 404 and the fallback finds nothing',
    expect: { status: 'completed', variants: ['links-broken'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start'),
              page(IMPRESSUM, 'impressum', 'A', { evaluable: false, notEvaluableReason: 'http-404' }),
              page(PRIVACY, 'privacy', 'A', { evaluable: false, notEvaluableReason: 'http-404' }),
            ],
          }),
        ],
        documents: {
          documents: [],
          attempts: [
            { kind: 'impressum', via: 'link', url: IMPRESSUM, status: 404, outcome: 'not-found' },
            { kind: 'privacy', via: 'link', url: PRIVACY, status: 404, outcome: 'not-found' },
            {
              kind: 'impressum',
              via: 'fallback',
              url: `${START}impressum-x`,
              status: 404,
              outcome: 'not-found',
            },
          ],
        },
      }),
  },
  {
    file: 'violation-impressum-only-via-contact.json',
    description: 'No page links the Impressum directly; it is found through the Kontakt page',
    expect: { status: 'completed', variants: ['reachable-via-intermediate'] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {}, [footerLinks()[1]!]),
              page(CONTACT, 'contact', 'A', {}, [footerLinks()[1]!]),
            ],
          }),
        ],
        documents: {
          documents: [
            makeDocument({ kind: 'impressum', url: IMPRESSUM, foundVia: 'hop' }),
            defaultDocuments().documents[1]!,
          ],
          attempts: [],
        },
      }),
  },
  {
    file: 'violation-impressum-fragment-link.json',
    description: 'The Impressum link is "#" on every page and no Impressum content was resolved',
    expect: { status: 'completed', variants: ['unresolved'] },
    build: () => {
      const links = [makeLink({ text: 'Impressum', href: null, hrefKind: 'fragment' }), footerLinks()[1]!];
      return site({
        phases: [
          phase('A', {
            pages: [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
          }),
        ],
        documents: { documents: [defaultDocuments().documents[1]!], attempts: [] },
      });
    },
  },
  {
    file: 'violation-banner-covers-footer.json',
    description: 'The recognised banner covers the footer and contains no link to either legal document',
    expect: { status: 'completed', variants: ['footer-covered-by-banner'] },
    build: () =>
      site({
        cmp: cmpWith({
          phase: 'B',
          facts: [
            cmpFacts({
              firstLayer: {
                bannerPresent: true,
                bannerVisible: true,
                buttons: [],
                purAbo: false,
                closeMeansAccept: null,
                coversFooter: true,
                legalLinks: [],
              },
            }),
          ],
        }),
      }),
  },
];
