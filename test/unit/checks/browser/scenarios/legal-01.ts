import type {
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
  PageVisit,
  PhaseRecord,
} from '../../../../../src/core/snapshot/browser.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import { makeDocument, makeLink } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  cmpFacts,
  cmpWith,
  defaultDocuments,
  firstLayer,
  footerLinks,
  IMPRESSUM,
  PRIVACY,
  page,
  phase,
  START,
  site,
} from '../helpers.ts';
import type { Scenario } from './shared.ts';

/** Generic provider details of three kinds: register entry, representative and VAT ID. */
export const PROVIDER_DETAILS =
  'Beispiel GmbH, Musterstraße 1, 10115 Berlin. Geschäftsführung: Erika Mustermann. Registergericht: Amtsgericht Musterstadt, HRB 12345. USt-IdNr.: DE123456789.';

export type PartSpec = Partial<Pick<DocumentPart, 'section' | 'place' | 'origin'>> & { text: string };

const partsOf = (prefix: string, url: string, specs: readonly PartSpec[]): DocumentPart[] =>
  specs.map((p, i) => ({ id: `${prefix}-p-${i + 1}`, origin: 'visible', sourceUrl: url, ...p }));

/** A page the collector read for Impressum details without taking it for the Impressum. */
export function candidate(
  url: string,
  parts: readonly PartSpec[],
  contentHeadings?: string[],
): DocumentRecord {
  return makeDocument({
    kind: 'impressum',
    id: `cand-${url.split('/').pop() || 'start'}`,
    url,
    foundVia: 'hop',
    phase: 'A',
    complete: false,
    errors: ['unconfirmed'],
    parts: partsOf(`cand-${url.split('/').pop() || 'start'}`, url, parts),
    ...(contentHeadings ? { contentHeadings } : {}),
  });
}

export interface UnlinkedImpressum {
  /** Parts of the privacy policy; omitted: a policy without Impressum details. */
  privacyParts?: PartSpec[];
  /** `false`: no privacy policy was found either. */
  policy?: boolean;
  contentHeadings?: string[];
  candidates?: DocumentRecord[];
  attempts?: DocumentsSection['attempts'];
  pages?: PageVisit[];
  phaseA?: Partial<PhaseRecord>;
}

/**
 * Every page links only the privacy policy; the Impressum was searched via the Kontakt page and the usual path and not
 * found, as the collector records it.
 */
export function unlinkedImpressum(spec: UnlinkedImpressum = {}): Snapshot {
  const links = [footerLinks()[1]!];
  const privacy = makeDocument({
    kind: 'privacy',
    id: 'doc-privacy',
    url: PRIVACY,
    phase: 'A',
    linkedFrom: [{ pageUrl: START, text: 'Datenschutz' }],
    parts: partsOf('doc-privacy', PRIVACY, [
      { section: 'Datenschutzerklärung', text: 'Wir verarbeiten personenbezogene Daten nach der DSGVO.' },
      ...(spec.privacyParts ?? []),
    ]),
    ...(spec.contentHeadings ? { contentHeadings: spec.contentHeadings } : {}),
  });
  return site({
    phases: [
      phase('A', {
        pages: spec.pages ?? [page(START, 'start', 'A', {}, links), page(CONTACT, 'contact', 'A', {}, links)],
        ...spec.phaseA,
      }),
    ],
    documents: {
      documents: spec.policy === false ? [] : [privacy],
      attempts: spec.attempts ?? [
        { kind: 'impressum', via: 'hop', url: CONTACT, status: 200, outcome: 'not-found' },
        { kind: 'impressum', via: 'fallback', url: IMPRESSUM, status: 404, outcome: 'not-found' },
      ],
      ...(spec.candidates ? { candidates: spec.candidates } : {}),
    },
  });
}

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
    file: 'violation-impressum-details-in-footer.json',
    description:
      'Only the privacy policy is linked, Kontakt and /impressum (404) hold no Impressum; the footer of the policy page shows a section "Impressum" with register entry, management and VAT ID',
    expect: { status: 'completed', variants: ['provider-details-without-link'] },
    build: () =>
      unlinkedImpressum({
        privacyParts: [
          { section: 'Datenschutzerklärung > Impressum', place: 'chrome', text: PROVIDER_DETAILS },
        ],
        contentHeadings: ['Datenschutzerklärung'],
      }),
  },
  {
    file: 'violation-impressum-details-on-contact.json',
    description:
      'Only the privacy policy is linked, /impressum answers 404; the Kontakt page holds register entry, management and VAT ID without a heading of their own',
    expect: { status: 'completed', variants: ['provider-details-without-link'] },
    build: () =>
      unlinkedImpressum({
        candidates: [candidate(CONTACT, [{ text: `Schreiben Sie uns. ${PROVIDER_DETAILS}` }])],
      }),
  },
  {
    file: 'inconclusive-targets-blocked-with-details.json',
    description:
      'Every attempt to reach the legal documents ends in a challenge; the Kontakt page holds provider details, which settle nothing about the Impressum',
    expect: { status: 'inconclusive', variants: [], reason: 'legal-targets-not-evaluable' },
    build: () =>
      unlinkedImpressum({
        policy: false,
        pages: [page(START, 'start', 'A', {}, []), page(CONTACT, 'contact', 'A', {}, [])],
        attempts: [
          { kind: 'impressum', via: 'fallback', url: IMPRESSUM, status: 403, outcome: 'error' },
          { kind: 'privacy', via: 'fallback', url: PRIVACY, status: 403, outcome: 'error' },
        ],
        candidates: [candidate(CONTACT, [{ text: PROVIDER_DETAILS }])],
      }),
  },
  {
    file: 'clean-impressum-link-and-details-on-contact.json',
    description:
      'Working Impressum and Datenschutz links on every page; the Kontakt page repeats the provider details',
    expect: { status: 'completed', variants: [] },
    build: () => {
      const snap = site();
      return {
        ...snap,
        documents: {
          ...(snap.documents as DocumentsSection),
          candidates: [candidate(CONTACT, [{ section: 'Kontakt', text: PROVIDER_DETAILS }])],
        },
      };
    },
  },
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
              firstLayer: firstLayer({ coversFooter: true, legalLinks: [] }),
            }),
          ],
        }),
      }),
  },
];
