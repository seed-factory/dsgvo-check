/**
 * LEGAL-01 case tables: builders for legal links, documents and search attempts, and `verify`, which runs one case and
 * checks only the expectations it names.
 */
import { expect } from 'vitest';
import { legal01 } from '../../../../../src/checks/browser/legal-01.ts';
import type { DocumentsSection, LinkFact } from '../../../../../src/core/snapshot/browser.ts';
import type { Snapshot } from '../../../../../src/core/snapshot/index.ts';
import { makeLink, observationsOf, runCheck } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  defaultDocuments,
  IMPRESSUM,
  PRIVACY,
  page,
  phase,
  type SiteSpec,
  START,
  site,
} from '../helpers.ts';

export type Attempt = DocumentsSection['attempts'][number];

export const att = (
  kind: Attempt['kind'],
  via: Attempt['via'],
  url: string,
  status: number | null,
  outcome: Attempt['outcome'],
): Attempt => ({ kind, via, url, status, outcome });
export const fallback = (kind: Attempt['kind'] = 'impressum') =>
  att(kind, 'fallback', kind === 'privacy' ? PRIVACY : IMPRESSUM, 404, 'not-found');

export const doc = (kind: 'impressum' | 'privacy') =>
  defaultDocuments().documents.find((d) => d.kind === kind)!;
export const documents = (
  stored: DocumentsSection['documents'],
  attempts: Attempt[] = [],
): DocumentsSection => ({
  documents: stored,
  attempts,
});

export const link = (text: string, href: string, extra: Partial<LinkFact> = {}) =>
  makeLink({ text, href, hrefKind: 'https', sameSite: true, ...extra });
export const impressum = (href = IMPRESSUM) => link('Impressum', href);
export const privacy = (href = PRIVACY) => link('Datenschutz', href);

export const twoPages = (links: LinkFact[]) => [
  page(START, 'start', 'A', {}, links),
  page(CONTACT, 'contact', 'A', {}, links),
];
/** The start and Kontakt pages carry `links`; `stored` and `attempts` are what the document search recorded. */
export const linked = (
  links: LinkFact[],
  stored: DocumentsSection['documents'],
  attempts: Attempt[] = [],
): SiteSpec => ({ phases: [phase('A', { pages: twoPages(links) })], documents: documents(stored, attempts) });

export const missing = (kind = 'impressum', variant = 'document-not-found') => [[kind, variant]];

export interface Expected {
  /** Every observation as [subject, variant], in order. */
  kinds?: string[][];
  status?: string;
  reason?: string;
  limitations?: string[];
  first?: Record<string, unknown>;
  firstSubject?: string;
  emptySubject?: string;
  pages?: string[];
  coverage?: Record<string, unknown>;
}
export interface Scenario {
  name: string;
  /** A site spec, or a snapshot built already (a scenario fixture). */
  input: SiteSpec | Snapshot;
  expected: Expected;
}
export function verify(input: SiteSpec | Snapshot, expected: Expected) {
  const result = runCheck(legal01, 'target' in input ? input : site(input));
  const observations = observationsOf(result);
  const first = expected.firstSubject
    ? observations.find((o) => o.subject === expected.firstSubject)
    : observations[0];

  if (expected.kinds) expect(observations.map((o) => [o.subject, o.variant])).toEqual(expected.kinds);
  if (expected.status) expect(result.status).toBe(expected.status);
  if (expected.reason) expect(result.reason).toBe(expected.reason);
  if (expected.limitations) expect(result.outcome?.limitations ?? []).toEqual(expected.limitations);
  if (expected.first) expect(first).toMatchObject(expected.first);
  if (expected.pages) expect(first?.pages).toEqual(expected.pages);
  if (expected.emptySubject)
    expect(observations.filter((o) => o.subject === expected.emptySubject)).toEqual([]);
  if (expected.coverage) expect(result.outcome?.coverage).toMatchObject(expected.coverage);
}
