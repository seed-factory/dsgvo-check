/**
 * PRIV-01 (P0): a loaded catalog service is looked up in the Datenschutzerklärung by levels named > company > domain >
 * category. Negations are not parsed, so `not-named` is capped at `medium`. A missing policy is LEGAL-01's finding.
 */

import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { DocumentRecord, RequestRecord } from '../../core/snapshot/browser.ts';
import type { ServiceInfo, ServiceObservation } from '../../derive/types.ts';
import { normalizeText, type PolicyPart, type PolicyText, policyDocuments, policyText } from './documents.ts';
import { distinctRequestEvidence, MAX_EVIDENCE } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields } from './services.ts';
import { requestIndex } from './snapshot.ts';
import { type StoredIdentifier, storedIdentifiersByService } from './stored.ts';

const ID = 'PRIV-01';

/** A quoted passage starts this far before the match and is at most this long. */
const QUOTE_LEAD_CHARS = 80;
const QUOTE_MAX_CHARS = 200;

export type MatchLevel = 'named' | 'company' | 'domain' | 'category' | 'none';

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

type Variant = 'not-named' | 'category-only' | 'ambiguous-match';

/**
 * The legal names of provider and parent the text names as searched (their other spellings are searched too); a
 * mention of the same company for another of its services is no mention of this one.
 */
function companyNames(info: ServiceInfo): string | null {
  const names = sortedUniq([info.provider?.name, info.parent?.name].filter((n): n is string => !!n));
  return names.join(', ') || info.companyAliases?.[0] || null;
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

/** Phases and pages of a service's requests and stored identifiers; the service's own lists when neither is known. */
function observedAt(
  requests: readonly { r: RequestRecord }[],
  identifiers: readonly StoredIdentifier[],
  svc: ServiceObservation,
): { phases: Phase[]; pages: string[] } {
  const phases = sortedUniq([...requests.map(({ r }) => r.phase), ...identifiers.map((s) => s.phase)]);
  const pages = sortedUniq([...requests.map(({ r }) => r.pageUrl), ...identifiers.map((s) => s.page)]);
  if (pages.length === 0) return { phases: [...svc.phases].sort() as Phase[], pages: [...svc.pages].sort() };
  return { phases: phases as Phase[], pages };
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
    const stored = storedIdentifiersByService(browser, derived);
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
      const requests = svc.requestIds.flatMap((id) => {
        const r = records.get(id);
        return r ? [{ r, c: classified.get(id) }] : [];
      });
      const identifiers = stored.get(svc.serviceId) ?? [];
      evidence.push(...distinctRequestEvidence(requests, MAX_EVIDENCE - evidence.length));
      evidence.push(...identifiers.slice(0, MAX_EVIDENCE - evidence.length).map((s) => s.ev));

      // Where the service was seen: its requests and the identifiers it stored, as in the inventory of TRACK-01. An
      // entry the catalog names without an identifier (a test cookie) is no sighting of the service.
      const seen = observedAt(requests, identifiers, svc);
      observations.push({
        checkId: ID,
        variant: verdict.variant,
        confidence: verdict.variant === 'not-named' ? 'medium' : 'high',
        subject: subjects.service(svc.serviceId),
        category: info.category,
        phases: seen.phases,
        pages: seen.pages,
        evidence,
        params: {
          service: info.name,
          companies: companyNames(info),
          policyUrl: main.finalUrl || main.url,
          pageCount: seen.pages.length,
          category: info.category,
          partCount: text.parts.length,
          complete: main.complete,
          requestCount: requests.length,
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
