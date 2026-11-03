import { makeDocument } from '../../../../utils/snapshot-builder.ts';
import { defaultDocuments, PRIVACY, phase, privacyDoc, req, site } from '../helpers.ts';
import { ORIGIN_IMG, type Scenario } from './shared.ts';

const trustindexLoaded = () =>
  phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] });

const policyPart = (id: string, text: string, origin: 'visible' | 'hidden-irrelevant' = 'visible') => ({
  id,
  text,
  origin,
  sourceUrl: PRIVACY,
});

export const scenarios: Scenario[] = [
  {
    file: 'violation-trustindex-not-named.json',
    description:
      'Trustindex widget is loaded; the complete German policy mentions neither product, operator, domain nor category',
    expect: { status: 'completed', variants: ['not-named'] },
    build: () =>
      site({
        phases: [phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] })],
      }),
  },
  {
    file: 'clean-operator-in-frame.json',
    description:
      'Same service; the operator is named in an expandable section inside a frame (company level)',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] })],
        documents: {
          attempts: [],
          documents: [
            defaultDocuments().documents[0]!,
            privacyDoc(
              [
                {
                  id: 'p1',
                  text: 'Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.',
                  origin: 'visible',
                  sourceUrl: PRIVACY,
                },
                {
                  id: 'p2',
                  section: '7 > Bewertungen',
                  text: 'Wir binden ein Widget der Trustindex Kft., Ungarn, ein.',
                  origin: 'frame',
                  sourceUrl: PRIVACY,
                  frameUrl: 'https://policy-generator.example.net/frame',
                },
              ],
              {
                manifest: {
                  expandablesFound: 1,
                  expandablesOpened: 1,
                  framesIncluded: 1,
                  linkedPages: 0,
                  textLength: 120,
                },
              },
            ),
          ],
        },
      }),
  },
  {
    file: 'inconclusive-pdf.json',
    description: 'The privacy policy is only available as PDF: not evaluated in 1.0',
    expect: { status: 'inconclusive', variants: [], reason: 'pdf-not-evaluated' },
    build: () =>
      site({
        phases: [phase('A', { requests: [req('A-1', 'https://cdn.trustindex.io/loader.js?wp-widget')] })],
        documents: {
          documents: [
            makeDocument({
              kind: 'privacy',
              id: 'doc-privacy',
              url: `${ORIGIN_IMG}/datenschutz.pdf`,
              format: 'pdf',
              parts: [],
            }),
          ],
          attempts: [],
        },
      }),
  },
];

export const variantScenarios: Scenario[] = [
  {
    file: 'violation-category-only.json',
    description:
      'Trustindex is loaded; the policy describes only an external review widget without naming it',
    expect: { status: 'completed', variants: ['category-only'] },
    build: () =>
      site({
        phases: [trustindexLoaded()],
        documents: {
          documents: [
            defaultDocuments().documents[0]!,
            privacyDoc([
              policyPart('p1', 'Datenschutzerklärung der Beispiel GmbH.'),
              policyPart('p2', 'Wir zeigen Kundenbewertungen über ein externes Bewertungs-Widget an.'),
            ]),
          ],
          attempts: [],
        },
      }),
  },
  {
    file: 'violation-name-only-in-hidden-template.json',
    description:
      'Trustindex is loaded; its name appears only in a hidden template part of the policy, not in the evaluated text',
    expect: { status: 'completed', variants: ['ambiguous-match'] },
    build: () =>
      site({
        phases: [trustindexLoaded()],
        documents: {
          documents: [
            defaultDocuments().documents[0]!,
            privacyDoc([
              policyPart('p1', 'Datenschutzerklärung der Beispiel GmbH.'),
              policyPart('p2', 'Trustindex Widget Vorlage', 'hidden-irrelevant'),
            ]),
          ],
          attempts: [],
        },
      }),
  },
];
