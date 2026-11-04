/**
 * PRIV-01 (P0): a loaded catalog service is looked up in the Datenschutzerklärung by levels named > company > domain >
 * category. Negations are not parsed, so `not-named` is capped at `medium`. A missing policy is LEGAL-01's finding.
 */

import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { DocumentPart, DocumentRecord, DocumentsSection } from '../../core/snapshot/browser.ts';
import type { ServiceInfo } from '../../derive/types.ts';
import { usableDocument } from './documents.ts';
import { MAX_EVIDENCE, requestEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields } from './services.ts';
import { requestIndex } from './snapshot.ts';

const ID = 'PRIV-01';

/** A quoted passage starts this far before the match and is at most this long. */
const QUOTE_LEAD_CHARS = 80;
const QUOTE_MAX_CHARS = 200;

export type MatchLevel = 'named' | 'company' | 'domain' | 'category' | 'none';

/** NFKC, case, ä/ae, ß/ss, soft hyphen, diacritics; punctuation and hyphens → spaces. */
export function normalizeText(s: string): string {
  return ` ${s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/­/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function contains(text: string, term: string): boolean {
  const t = normalizeText(term);
  return t.trim().length > 0 && text.includes(t);
}

export function matchLevel(
  info: ServiceInfo,
  text: string,
  withCategory = true,
): { level: MatchLevel; term: string | null } {
  const levels: Array<[MatchLevel, readonly string[]]> = [
    ['named', [info.name, ...(info.aliasesDe ?? []), ...(info.aliasesEn ?? [])]],
    ['company', info.companyAliases ?? []],
    ['domain', info.domains ?? []],
  ];
  if (withCategory) levels.push(['category', info.categoryTerms ?? []]);
  for (const [level, terms] of levels) {
    const term = terms.find((t) => contains(text, t));
    if (term) return { level, term };
  }
  return { level: 'none', term: null };
}

/** ≤ 200 characters around the first case-insensitive occurrence of `term` (or the part start). */
function quote(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  const start = Math.max(0, i - QUOTE_LEAD_CHARS);
  const q = text.slice(start, start + QUOTE_MAX_CHARS).trim();
  return q.length > QUOTE_MAX_CHARS ? q.slice(0, QUOTE_MAX_CHARS) : q;
}

/**
 * The only thing missing is the content of expandable parts that were not opened (banner open); it is reported as
 * limitation `banner-open`. Every other error still makes the document incomplete.
 */
function onlyUnopened(d: DocumentRecord): boolean {
  return d.errors.length > 0 && d.errors.every((e) => e === 'expand-failed');
}

type PolicyPart = DocumentPart & { documentId: string };

type Variant = 'not-named' | 'category-only' | 'ambiguous-match';

/** The searchable text of the policy: normalized, split into what the page shows and what it keeps hidden. */
interface PolicyText {
  parts: PolicyPart[];
  visibleParts: PolicyPart[];
  visible: string;
  hidden: string;
}

/** The HTML policy documents to search, or the reason the policy cannot be searched. */
function policyDocuments(documents: DocumentsSection): { html: DocumentRecord[] } | { reason: string } {
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

function policyText(html: readonly DocumentRecord[]): PolicyText {
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

function policyEvidence(
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

/**
 * How the policy mentions a service: null when it does (named, company or domain), otherwise the variant to report
 * and, for a category-only mention, the passage that contains it.
 */
function mentionVerdict(
  info: ServiceInfo,
  text: PolicyText,
): { variant: Variant; textMatch: EvidenceInput | null } | null {
  const found = matchLevel(info, text.visible);
  if (found.level === 'named' || found.level === 'company' || found.level === 'domain') return null;

  if (found.level === 'category' && found.term) {
    const term = found.term;
    const part = text.visibleParts.find((p) => contains(normalizeText(p.text), term));
    const textMatch: EvidenceInput | null = part
      ? {
          type: 'text-match',
          documentId: part.documentId,
          section: part.section ?? null,
          quote: quote(part.text, term),
          matchLevel: 'category',
          negation: 'none',
        }
      : null;
    return { variant: 'category-only', textMatch };
  }

  // Named only in a part the page hides: neither confirmed nor missing.
  const onlyHidden = matchLevel(info, text.hidden, false).level !== 'none';
  return { variant: onlyHidden ? 'ambiguous-match' : 'not-named', textMatch: null };
}

export const priv01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'documents', 'derived'],
  variants: [
    { variant: 'not-named', variantGroup: 'policy-mention', maxConfidence: 'medium' },
    { variant: 'category-only', variantGroup: 'policy-mention' },
    { variant: 'ambiguous-match', variantGroup: 'policy-mention' },
  ],
  run({ browser, documents, derived }) {
    const found = policyDocuments(documents);
    if ('reason' in found) return { status: 'inconclusive', reason: found.reason, observations: [] };

    const { html } = found;
    const main = html[0] as DocumentRecord;
    const text = policyText(html);
    const documentEvidence = policyEvidence(main, html, text.parts);

    const limitations: string[] = [];
    const notOpened = html.some((d) => d.manifest.expandablesOpened < d.manifest.expandablesFound);
    if (notOpened) limitations.push('banner-open');

    const records = requestIndex(browser);
    const classified = new Map(derived.requests.map((c) => [c.requestId, c] as const));
    const observations: Observation[] = [];
    let evaluated = 0;

    for (const svc of derived.services) {
      const info = derived.catalog[svc.serviceId];
      if (info?.policyRelevance !== 'required') continue;
      if (!svc.delivered && svc.stages.length === 0) continue;
      evaluated++;

      const verdict = mentionVerdict(info, text);
      if (!verdict) continue;

      const evidence: EvidenceInput[] = [documentEvidence, ...(verdict.textMatch ? [verdict.textMatch] : [])];
      for (const id of svc.requestIds.slice(0, MAX_EVIDENCE - evidence.length)) {
        const r = records.get(id);
        if (r) evidence.push(requestEvidence(r, classified.get(id)));
      }

      observations.push({
        checkId: ID,
        variant: verdict.variant,
        confidence: verdict.variant === 'not-named' ? 'medium' : 'high',
        subject: subjects.service(svc.serviceId),
        category: info.category,
        phases: [...svc.phases].sort() as Phase[],
        pages: [...svc.pages].sort(),
        evidence,
        params: {
          service: info.name,
          policyUrl: main.finalUrl || main.url,
          pageCount: svc.pages.length,
          category: info.category,
          partCount: text.parts.length,
          complete: main.complete,
        },
        ...serviceFields(derived, svc.serviceId),
      });
    }

    return {
      status: notOpened ? 'partial' : 'completed',
      observations,
      limitations,
      coverage: { evaluated, note: `negation-not-parsed` },
    };
  },
});
