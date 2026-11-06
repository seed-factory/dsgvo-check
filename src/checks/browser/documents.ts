/**
 * Whether a legal document the collector fetched can be relied on as that document (LEGAL-01, PRIV-01, PRIV-02), and
 * the privacy policy the policy checks read: its HTML documents, their text normalised for word search, and the
 * evidence of what was read.
 */
import type { EvidenceInput } from '../../core/api.ts';
import type { DocumentPart, DocumentRecord, DocumentsSection } from '../../core/snapshot/browser.ts';
import { sortedUniq } from './lists.ts';

/** Errors by which the collector marks a fetched page as not being the legal document. */
const NOT_A_DOCUMENT: ReadonlySet<string> = new Set(['soft-404', 'keyword-missing', 'unconfirmed']);

/** The probe's page was judged an error page (`soft-404`) or not confirmed as the document. */
export function judgedNotDocument(a: DocumentsSection['attempts'][number]): boolean {
  return a.outcome === 'soft-404' || a.outcome === 'unconfirmed';
}

/**
 * 2xx and not judged "no document" by the collector, neither on the document nor on the attempt that fetched it.
 * A linked PDF counts even when it was not fetched (status null).
 */
export function usableDocument(d: DocumentRecord, attempts: DocumentsSection['attempts']): boolean {
  if (d.errors.some((e) => NOT_A_DOCUMENT.has(e))) return false;
  const judgedNot = attempts.some(
    (a) => a.kind === d.kind && judgedNotDocument(a) && (a.url === d.url || a.url === d.finalUrl),
  );
  if (judgedNot) return false;
  if (d.status === null) return d.format === 'pdf';
  return d.status >= 200 && d.status < 300;
}

/** NFKC, case, ä/ae, ß/ss, soft hyphen, diacritics; punctuation and hyphens → spaces. */
export function normalizeText(s: string): string {
  return ` ${s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u00AD/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * The only thing missing is the content of expandable parts that were not opened (banner open); it is reported as
 * limitation `banner-open`. Every other error still makes the document incomplete.
 */
function onlyUnopened(d: DocumentRecord): boolean {
  return d.errors.length > 0 && d.errors.every((e) => e === 'expand-failed');
}

export type PolicyPart = DocumentPart & { documentId: string };

/** The searchable text of the policy: normalized, split into what the page shows and what it keeps hidden. */
export interface PolicyText {
  parts: PolicyPart[];
  visibleParts: PolicyPart[];
  visible: string;
  hidden: string;
}

/** The HTML policy documents to search (the first is the main one), or the reason the policy cannot be searched. */
export function policyDocuments(
  documents: DocumentsSection,
): { html: DocumentRecord[] } | { reason: string } {
  // A page judged "not the document" or unconfirmed is no policy to search; LEGAL-01 reports it.
  const policies = documents.documents.filter(
    (d) => d.kind === 'privacy' && usableDocument(d, documents.attempts),
  );
  if (policies.length === 0) return { reason: 'privacy-policy-not-found' };

  const html = policies.filter((d) => d.format === 'html');
  if (html.length === 0) {
    return { reason: policies.some((d) => d.format === 'pdf') ? 'pdf-not-evaluated' : 'unsupported-format' };
  }

  const main = html[0] as DocumentRecord;
  if (main.lang && !/^(de|en)\b/i.test(main.lang)) return { reason: 'language-unsupported' };
  if (html.some((d) => !d.complete && !onlyUnopened(d))) return { reason: 'document-incomplete' };
  return { html };
}

export function policyText(html: readonly DocumentRecord[]): PolicyText {
  const parts = html.flatMap((d) => d.parts.map((p) => ({ ...p, documentId: d.id })));
  const visibleParts = parts.filter((p) => p.origin !== 'hidden-irrelevant');
  const hiddenParts = parts.filter((p) => p.origin === 'hidden-irrelevant');
  return {
    parts,
    visibleParts,
    visible: normalizeText(visibleParts.map((p) => p.text).join(' \n ')),
    hidden: normalizeText(hiddenParts.map((p) => p.text).join(' \n ')),
  };
}

/** What was read of the document(s): the counters of the snapshot manifest, no text. */
function readManifest(html: readonly DocumentRecord[], partCount: number) {
  const sum = (count: (d: DocumentRecord) => number) => html.reduce((n, d) => n + count(d), 0);
  return {
    partCount,
    textLength: sum((d) => d.manifest.textLength),
    expandablesFound: sum((d) => d.manifest.expandablesFound),
    expandablesOpened: sum((d) => d.manifest.expandablesOpened),
    framesIncluded: sum((d) => d.manifest.framesIncluded),
    // Absent in snapshots of older versions: then the evidence has no number rather than a wrong zero.
    ...(html.some((d) => d.manifest.framesFound !== undefined)
      ? { framesFound: sum((d) => d.manifest.framesFound ?? 0) }
      : {}),
    linkedPages: sum((d) => d.manifest.linkedPages),
    truncated: html.some((d) => d.errors.includes('truncated')),
  };
}

/** `document` evidence of the policy: where it was read, its parts by origin and the counters of what was read. */
export function policyEvidence(
  main: DocumentRecord,
  html: readonly DocumentRecord[],
  parts: PolicyPart[],
): EvidenceInput {
  return {
    type: 'document',
    url: main.finalUrl || main.url,
    kind: 'privacy',
    lang: main.lang,
    complete: main.complete,
    parts: sortedUniq(parts.map((p) => p.origin)).map((origin) => ({ origin })),
    errors: main.errors,
    phase: main.phase,
    ...(main.sha256 ? { sha256: main.sha256 } : {}),
    manifest: readManifest(html, parts.length),
  };
}
