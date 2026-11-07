/**
 * The privacy policy every policy check reads: which stored documents count as the HTML policy, why none can be read,
 * and its text split into what the page shows and what it hides, normalised for word search.
 */
import { describe, expect, it } from 'vitest';
import { policyDocuments, policyText } from '../../../../../src/checks/browser/documents.ts';
import type {
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
} from '../../../../../src/core/snapshot/browser.ts';
import { makeDocument } from '../../../../utils/snapshot-builder.ts';

const POLICY = 'https://www.example.test/datenschutz';
const part = (id: string, text: string, origin: DocumentPart['origin'] = 'visible'): DocumentPart => ({
  id,
  text,
  origin,
  sourceUrl: POLICY,
});
const policy = (p: Partial<DocumentRecord> = {}) =>
  makeDocument({
    kind: 'privacy',
    id: 'doc-privacy-1',
    url: POLICY,
    phase: 'A',
    parts: [part('p1', 'Text.')],
    ...p,
  });
const section = (
  documents: DocumentRecord[],
  attempts: DocumentsSection['attempts'] = [],
): DocumentsSection => ({
  documents,
  attempts,
});

describe('policyDocuments', () => {
  it('gives the usable HTML policies, the first one as the main document', () => {
    const second = policy({ id: 'doc-privacy-2', url: `${POLICY}/kurse` });
    const impressum = makeDocument({
      kind: 'impressum',
      id: 'doc-impressum-1',
      url: 'https://www.example.test/impressum',
    });
    expect(policyDocuments(section([impressum, policy(), second]))).toEqual({ html: [policy(), second] });
  });

  it('a further notice of the site comes after the policy, whatever the order of the records', () => {
    const notice = policy({ id: 'doc-privacy-2', url: `${POLICY}-kurse`, role: 'supplement' });
    expect(policyDocuments(section([notice, policy()]))).toEqual({ html: [policy(), notice] });
  });

  it('a further notice with unopened expandable parts is searched like the policy, without a limitation', () => {
    const notice = policy({
      id: 'doc-privacy-2',
      url: `${POLICY}-kurse`,
      role: 'supplement',
      complete: false,
      errors: ['expand-failed'],
    });
    expect(policyDocuments(section([policy(), notice]))).toEqual({ html: [policy(), notice] });
  });

  it('an unopened expandable part (banner open) does not make the policy unreadable', () => {
    const doc = policy({ complete: false, errors: ['expand-failed'] });
    expect(policyDocuments(section([doc]))).toEqual({ html: [doc] });
  });

  it.each<[string, string, DocumentsSection]>([
    ['no policy', 'privacy-policy-not-found', section([])],
    ['a page judged no policy', 'privacy-policy-not-found', section([policy({ errors: ['soft-404'] })])],
    [
      'an attempt that found the page unconfirmed',
      'privacy-policy-not-found',
      section(
        [policy()],
        [{ kind: 'privacy', via: 'link', url: POLICY, status: 200, outcome: 'unconfirmed' }],
      ),
    ],
    ['a PDF policy', 'pdf-not-evaluated', section([policy({ format: 'pdf' })])],
    ['another format', 'unsupported-format', section([policy({ format: 'other' })])],
    ['a main policy in another language', 'language-unsupported', section([policy({ lang: 'fr' })])],
    [
      'a truncated policy',
      'document-incomplete',
      section([policy({ complete: false, errors: ['truncated'] })]),
    ],
    [
      'a second policy that is incomplete',
      'document-incomplete',
      section([
        policy(),
        policy({ id: 'doc-privacy-2', complete: false, errors: ['expand-failed', 'truncated'] }),
      ]),
    ],
  ])('%s gives the reason %s', (_case, reason, documents) => {
    expect(policyDocuments(documents)).toEqual({ reason });
  });
});

describe('policyText', () => {
  it('keeps every part with its document and searches visible and hidden text apart', () => {
    const first = policy({
      parts: [part('a', 'Wir nutzen Google Fonts.'), part('b', 'Matomo', 'hidden-irrelevant')],
    });
    const second = policy({ id: 'doc-privacy-2', parts: [part('c', 'Weitere Dienste.', 'expandable')] });
    const text = policyText([first, second]);
    expect(text.parts.map((p) => [p.id, p.documentId])).toEqual([
      ['a', 'doc-privacy-1'],
      ['b', 'doc-privacy-1'],
      ['c', 'doc-privacy-2'],
    ]);
    expect(text.visibleParts.map((p) => p.id)).toEqual(['a', 'c']);
    expect(text.visible).toBe(' wir nutzen google fonts weitere dienste ');
    expect(text.hidden).toBe(' matomo ');
  });
});
