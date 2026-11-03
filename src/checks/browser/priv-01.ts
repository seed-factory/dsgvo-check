/**
 * PRIV-01 (P0): a loaded catalog service is looked up in the Datenschutzerklärung by levels named > company > domain >
 * category. Negations are not parsed, so `not-named` is capped at `medium`. A missing policy is LEGAL-01's finding.
 */

import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { DocumentRecord } from '../../core/snapshot/browser.ts';
import type { ServiceInfo } from '../../derive/types.ts';
import {
  MAX_EVIDENCE,
  requestEvidence,
  requestIndex,
  serviceFields,
  sortedUniq,
  usableDocument,
} from './shared.ts';

const ID = 'PRIV-01';

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
  const start = Math.max(0, i - 80);
  const q = text.slice(start, start + 200).trim();
  return q.length > 200 ? q.slice(0, 200) : q;
}

/**
 * The only thing missing is the content of expandable parts that were not opened (banner open); it is reported as
 * limitation `banner-open`. Every other error still makes the document incomplete.
 */
function onlyUnopened(d: DocumentRecord): boolean {
  return d.errors.length > 0 && d.errors.every((e) => e === 'expand-failed');
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
    // A page judged "not the document" or unconfirmed is no policy to search; LEGAL-01 reports it.
    const policies = documents.documents.filter(
      (d) => d.kind === 'privacy' && usableDocument(d, documents.attempts),
    );
    if (policies.length === 0)
      return { status: 'inconclusive', reason: 'privacy-policy-not-found', observations: [] };
    const html = policies.filter((d) => d.format === 'html');
    if (html.length === 0) {
      const pdf = policies.some((d) => d.format === 'pdf');
      return {
        status: 'inconclusive',
        reason: pdf ? 'pdf-not-evaluated' : 'unsupported-format',
        observations: [],
      };
    }
    const main = html[0] as DocumentRecord;
    if (main.lang && !/^(de|en)\b/i.test(main.lang)) {
      return { status: 'inconclusive', reason: 'language-unsupported', observations: [] };
    }
    if (html.some((d) => !d.complete && !onlyUnopened(d)))
      return { status: 'inconclusive', reason: 'document-incomplete', observations: [] };

    const parts = html.flatMap((d) => d.parts.map((p) => ({ ...p, documentId: d.id })));
    const visibleParts = parts.filter((p) => p.origin !== 'hidden-irrelevant');
    const visible = normalizeText(visibleParts.map((p) => p.text).join(' \n '));
    const hidden = normalizeText(
      parts
        .filter((p) => p.origin === 'hidden-irrelevant')
        .map((p) => p.text)
        .join(' \n '),
    );
    const limitations: string[] = [];
    const notOpened = html.some((d) => d.manifest.expandablesOpened < d.manifest.expandablesFound);
    if (notOpened) limitations.push('banner-open');

    const records = requestIndex(browser);
    const classified = new Map(derived.requests.map((c) => [c.requestId, c] as const));
    // What was read of the document(s): the counters of the snapshot manifest, no text.
    const manifest = {
      partCount: parts.length,
      textLength: html.reduce((n, d) => n + d.manifest.textLength, 0),
      expandablesFound: html.reduce((n, d) => n + d.manifest.expandablesFound, 0),
      expandablesOpened: html.reduce((n, d) => n + d.manifest.expandablesOpened, 0),
      framesIncluded: html.reduce((n, d) => n + d.manifest.framesIncluded, 0),
      // Absent in snapshots of older versions: then the evidence has no number rather than a wrong zero.
      ...(html.some((d) => d.manifest.framesFound !== undefined)
        ? { framesFound: html.reduce((n, d) => n + (d.manifest.framesFound ?? 0), 0) }
        : {}),
      linkedPages: html.reduce((n, d) => n + d.manifest.linkedPages, 0),
      truncated: html.some((d) => d.errors.includes('truncated')),
    };
    const documentEvidence: EvidenceInput = {
      type: 'document',
      url: main.finalUrl || main.url,
      kind: 'privacy',
      lang: main.lang,
      complete: main.complete,
      parts: sortedUniq(parts.map((p) => p.origin)).map((origin) => ({ origin })),
      errors: main.errors,
      phase: main.phase,
      ...(main.sha256 ? { sha256: main.sha256 } : {}),
      manifest,
    };
    const observations: Observation[] = [];
    let evaluated = 0;
    for (const svc of derived.services) {
      const info = derived.catalog[svc.serviceId];
      if (info?.policyRelevance !== 'required') continue;
      if (!svc.delivered && svc.stages.length === 0) continue;
      evaluated++;
      const found = matchLevel(info, visible);
      if (found.level === 'named' || found.level === 'company' || found.level === 'domain') continue;
      let variant: 'not-named' | 'category-only' | 'ambiguous-match' = 'not-named';
      const evidence: EvidenceInput[] = [documentEvidence];
      if (found.level === 'category' && found.term) {
        variant = 'category-only';
        const term = found.term;
        const part = visibleParts.find((p) => contains(normalizeText(p.text), term));
        if (part) {
          evidence.push({
            type: 'text-match',
            documentId: part.documentId,
            section: part.section ?? null,
            quote: quote(part.text, term),
            matchLevel: 'category',
            negation: 'none',
          });
        }
      } else if (matchLevel(info, hidden, false).level !== 'none') {
        variant = 'ambiguous-match';
      }
      for (const id of svc.requestIds.slice(0, MAX_EVIDENCE - evidence.length)) {
        const r = records.get(id);
        if (r) evidence.push(requestEvidence(r, classified.get(id)));
      }
      observations.push({
        checkId: ID,
        variant,
        confidence: variant === 'not-named' ? 'medium' : 'high',
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
          partCount: parts.length,
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
