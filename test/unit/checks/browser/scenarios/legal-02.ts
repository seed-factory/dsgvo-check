import type {
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
} from '../../../../../src/core/snapshot/browser.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import { makeDocument, makeSnapshot, makeTarget } from '../../../../utils/snapshot-builder.ts';
import type { Scenario } from './shared.ts';

export const LEGAL02_ORIGIN = 'https://www.example.test';
export const LEGAL02_IMPRESSUM = `${LEGAL02_ORIGIN}/impressum`;
export const LEGAL02_PRIVACY = `${LEGAL02_ORIGIN}/datenschutz`;

/** A part of a document as the collector stores it: text with its heading path and where it was read. */
export const docPart = (
  id: string,
  text: string,
  o: { section?: string; origin?: DocumentPart['origin']; sourceUrl?: string } = {},
): DocumentPart => ({
  id,
  ...(o.section ? { section: o.section } : {}),
  text,
  origin: o.origin ?? 'visible',
  sourceUrl: o.sourceUrl ?? LEGAL02_PRIVACY,
});

export const impressumDocument = (parts: DocumentPart[], p: Partial<DocumentRecord> = {}): DocumentRecord =>
  makeDocument({ kind: 'impressum', id: 'doc-impressum', url: LEGAL02_IMPRESSUM, phase: 'A', parts, ...p });

export const policyDocument = (parts: DocumentPart[], p: Partial<DocumentRecord> = {}): DocumentRecord =>
  makeDocument({ kind: 'privacy', id: 'doc-privacy', url: LEGAL02_PRIVACY, phase: 'A', parts, ...p });

/** The Impressum of the example site with current designations only. */
export const currentImpressum = (): DocumentRecord =>
  impressumDocument([
    docPart(
      'i1',
      'Impressum. Angaben gemäß § 5 DDG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: Erika Mustermann, Anschrift wie oben.',
      { section: 'Impressum', sourceUrl: LEGAL02_IMPRESSUM },
    ),
  ]);

/** The privacy policy of the example site with current designations only. */
export const currentPolicy = (): DocumentRecord =>
  policyDocument([
    docPart('p1', 'Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.', {
      section: 'Datenschutzerklärung > 1. Verantwortlicher',
    }),
    docPart(
      'p2',
      'Wir speichern Informationen auf Ihrem Endgerät nur nach § 25 TDDDG. Google ist nach dem EU-U.S. Data Privacy Framework (DPF) zertifiziert.',
      { section: 'Datenschutzerklärung > 5. Analyse' },
    ),
  ]);

/** A snapshot of the example site that holds only the legal documents the collector read. */
export function legalSite(
  documents: DocumentRecord[],
  attempts: DocumentsSection['attempts'] = [],
): Snapshot {
  return makeSnapshot({
    target: makeTarget(`${LEGAL02_ORIGIN}/`),
    documents: { documents, attempts },
  });
}

export const scenarios: Scenario[] = [
  {
    file: 'violation-privacy-shield-in-policy.json',
    description:
      'The privacy policy says a provider is certified under the EU-US Privacy Shield, which the CJEU declared invalid',
    expect: { status: 'completed', variants: ['outdated-reference'] },
    build: () =>
      legalSite([
        currentImpressum(),
        policyDocument([
          docPart('p1', 'Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.', {
            section: 'Datenschutzerklärung > 1. Verantwortlicher',
          }),
          docPart('p2', 'Google ist unter dem EU-US Privacy Shield zertifiziert.', {
            section: 'Datenschutzerklärung > 5. Plugins und Tools > Analytics',
          }),
        ]),
      ]),
  },
  {
    file: 'violation-tmg-rstv-in-impressum.json',
    description: 'The Impressum cites § 5 TMG and § 55 Abs. 2 RStV: one observation per designation',
    expect: { status: 'completed', variants: ['outdated-reference'] },
    build: () =>
      legalSite([
        impressumDocument([
          docPart(
            'i1',
            'Impressum. Angaben gemäß § 5 TMG: Beispiel GmbH, Musterstraße 1, 10115 Berlin. Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV: Erika Mustermann, Anschrift wie oben.',
            { section: 'Impressum', sourceUrl: LEGAL02_IMPRESSUM },
          ),
        ]),
        currentPolicy(),
      ]),
  },
  {
    file: 'clean-current-references.json',
    description:
      'Impressum and policy use the current designations (§ 5 DDG, § 18 Abs. 2 MStV, § 25 TDDDG, DPF)',
    expect: { status: 'completed', variants: [] },
    build: () => legalSite([currentImpressum(), currentPolicy()]),
  },
  {
    file: 'inconclusive-no-documents.json',
    description: 'The policy is only a PDF and the Impressum link answered with an error: no text to search',
    expect: { status: 'inconclusive', variants: [], reason: 'no-documents' },
    build: () =>
      legalSite(
        [
          policyDocument([], {
            id: 'doc-privacy-pdf',
            url: `${LEGAL02_ORIGIN}/datenschutz.pdf`,
            finalUrl: `${LEGAL02_ORIGIN}/datenschutz.pdf`,
            format: 'pdf',
          }),
        ],
        [{ kind: 'impressum', via: 'link', url: LEGAL02_IMPRESSUM, status: 403, outcome: 'error' }],
      ),
  },
];

export const variantScenarios: Scenario[] = [
  {
    file: 'clean-historical-and-successor-mentions.json',
    description:
      'Counterexample: the old designations appear only in sentences that call them former or name their successor',
    expect: { status: 'completed', variants: [] },
    build: () =>
      legalSite([
        impressumDocument([
          docPart(
            'i1',
            'Angaben gemäß § 5 DDG (vormals § 5 TMG): Beispiel GmbH, Musterstraße 1, 10115 Berlin.',
            {
              section: 'Impressum',
              sourceUrl: LEGAL02_IMPRESSUM,
            },
          ),
        ]),
        policyDocument([
          docPart(
            'p1',
            'Das EU-US Privacy Shield wurde vom EuGH am 16.07.2020 für ungültig erklärt. Google ist nach dem EU-US Data Privacy Framework zertifiziert (Nachfolger des Privacy Shield).',
            { section: 'Datenschutzerklärung > 6. Übermittlung in Drittländer' },
          ),
        ]),
      ]),
  },
  {
    file: 'violation-tmg-with-policy-pdf.json',
    description: 'The Impressum cites § 5 TMG; the policy is only a PDF, so it was not searched',
    expect: { status: 'partial', variants: ['outdated-reference'] },
    build: () =>
      legalSite([
        impressumDocument([
          docPart('i1', 'Angaben gemäß § 5 TMG: Beispiel GmbH, Musterstraße 1, 10115 Berlin.', {
            section: 'Impressum',
            sourceUrl: LEGAL02_IMPRESSUM,
          }),
        ]),
        policyDocument([], {
          url: `${LEGAL02_ORIGIN}/datenschutz.pdf`,
          finalUrl: `${LEGAL02_ORIGIN}/datenschutz.pdf`,
          format: 'pdf',
        }),
      ]),
  },
];
