/**
 * PRIV-01 (P0): a loaded catalog service is looked up in the Datenschutzerklärung by levels named > company > domain >
 * category. The further privacy notices of the site that phase A read beside the policy are searched with it: a
 * mention in any of them counts. A service no document names, but that the consent dialog of the site names itself
 * (the catalog services the collector found in its text, collapsed details included, once in phase A for a CMP its own
 * adapter recognised), is `named-in-cmp-only`; a dialog text that was cut or could not be read is a limitation while a
 * service stays unnamed. Negations are not parsed, so `not-named` and `named-in-cmp-only` are capped at `medium`. A
 * missing policy is LEGAL-01's finding.
 */

import {
  containsTerm,
  defineCheck,
  type EvidenceInput,
  firstTermIn,
  normalizeText,
  type Observation,
  type Phase,
  serviceNameTerms,
  subjects,
} from '../../core/api.ts';
import type { DocumentRecord, RequestRecord } from '../../core/snapshot/browser.ts';
import type { CmpDialogMentions } from '../../core/snapshot/cmp-dialog.ts';
import type { ServiceInfo, ServiceObservation } from '../../derive/types.ts';
import { type PolicyText, policyDocuments, policyText } from './documents.ts';
import { distinctRequestEvidence, MAX_EVIDENCE } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields } from './services.ts';
import { requestIndex } from './snapshot.ts';
import { type StoredIdentifier, storedIdentifiersByService } from './stored.ts';

const ID = 'PRIV-01';

/** A quoted passage starts this far before the match and is at most this long. */
const QUOTE_LEAD_CHARS = 80;
const QUOTE_MAX_CHARS = 200;
/** The id under which evidence names the consent dialog as the text searched. */
const DIALOG_DOCUMENT_ID = 'cmp-dialog';

export type MatchLevel = 'named' | 'company' | 'domain' | 'category' | 'none';

/**
 * The first level at which `text` (as `normalizeText` gives it) names the service. The browser collector searches the
 * consent dialog at the `named` level with the same terms and the same search (`serviceNameTerms`, `firstTermIn`).
 */
export function matchLevel(
  info: ServiceInfo,
  text: string,
  withCategory = true,
): { level: MatchLevel; term: string | null } {
  const levels: Array<[MatchLevel, readonly string[]]> = [
    ['named', serviceNameTerms(info)],
    ['company', info.companyAliases ?? []],
    ['domain', info.domains ?? []],
  ];
  if (withCategory) levels.push(['category', info.categoryTerms ?? []]);
  for (const [level, terms] of levels) {
    const term = firstTermIn(text, terms);
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

type Variant = 'not-named' | 'category-only' | 'ambiguous-match' | 'named-in-cmp-only';

/**
 * The catalog term by which the consent dialog names the service: its name or an alias, as the collector found it in
 * the dialog's text. Its company, domain or category there do not count: a dialog gives the provider and the purpose of
 * each service it lists, so they name another service of the same company as well. A term that is not one of the
 * service's own names (an edited snapshot) is no mention.
 */
function dialogMention(info: ServiceInfo, dialog: CmpDialogMentions): string | null {
  const own = serviceNameTerms(info);
  return dialog.services.find((m) => m.serviceId === info.serviceId && own.includes(m.term))?.term ?? null;
}

/**
 * The CMP whose dialog was read and what in it names the service: the catalog term, not text of the page, which the
 * snapshot does not keep.
 */
function dialogEvidence(d: CmpDialogMentions, term: string): EvidenceInput[] {
  return [
    {
      type: 'cmp',
      cmpId: d.cmpId,
      version: d.version,
      recognitionConfidence: 'high',
      phase: d.phase,
      page: d.pageUrl,
    },
    {
      type: 'text-match',
      documentId: DIALOG_DOCUMENT_ID,
      section: null,
      quote: term,
      matchLevel: 'named',
      negation: 'none',
      phase: d.phase,
      page: d.pageUrl,
    },
  ];
}

/**
 * The legal names of provider and parent the text names as searched (their other spellings are searched too); a
 * mention of the same company for another of its services is no mention of this one.
 */
function companyNames(info: ServiceInfo): string | null {
  const names = sortedUniq([info.provider?.name, info.parent?.name].filter((n): n is string => !!n));
  return names.join(', ') || info.companyAliases?.[0] || null;
}

/** What was read of one document: the counters of its snapshot manifest, no text. */
function readManifest(d: DocumentRecord) {
  return {
    partCount: d.parts.length,
    textLength: d.manifest.textLength,
    expandablesFound: d.manifest.expandablesFound,
    expandablesOpened: d.manifest.expandablesOpened,
    framesIncluded: d.manifest.framesIncluded,
    // Absent in snapshots of older versions: then the evidence has no number rather than a wrong zero.
    ...(d.manifest.framesFound !== undefined ? { framesFound: d.manifest.framesFound } : {}),
    linkedPages: d.manifest.linkedPages,
    truncated: d.errors.includes('truncated'),
  };
}

/** One document evidence per searched document, the policy first: what was read of each and how. */
function documentEvidence(d: DocumentRecord): EvidenceInput {
  return {
    type: 'document',
    url: d.finalUrl || d.url,
    kind: 'privacy',
    lang: d.lang,
    complete: d.complete,
    parts: sortedUniq(d.parts.map((p) => p.origin)).map((origin) => ({ origin })),
    errors: d.errors,
    phase: d.phase,
    ...(d.sha256 ? { sha256: d.sha256 } : {}),
    manifest: readManifest(d),
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
    const part = text.visibleParts.find((p) => containsTerm(normalizeText(p.text), term));
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
  optional: ['cmp'],
  variants: [
    { variant: 'not-named', variantGroup: 'policy-mention', maxConfidence: 'medium' },
    { variant: 'category-only', variantGroup: 'policy-mention' },
    { variant: 'ambiguous-match', variantGroup: 'policy-mention' },
    { variant: 'named-in-cmp-only', variantGroup: 'policy-mention', maxConfidence: 'medium' },
  ],
  run({ browser, documents, derived, cmp }) {
    const found = policyDocuments(documents);
    if ('reason' in found) return { status: 'inconclusive', reason: found.reason, observations: [] };

    const { html } = found;
    const main = html[0] as DocumentRecord;
    const text = policyText(html);
    const searched = html.map(documentEvidence);
    const policyUrls = html.map((d) => d.finalUrl || d.url).join(', ');

    const limitations: string[] = [];
    const notOpened = html.some((d) => d.manifest.expandablesOpened < d.manifest.expandablesFound);
    if (notOpened) limitations.push('banner-open');
    if (found.supplementNotEvaluated) limitations.push('supplement-not-evaluated');

    const dialog = cmp?.dialogMentions ?? null;
    // What keeps the dialog from settling a service no document names: its text was cut, or could not be read.
    const dialogGap = dialog?.truncated
      ? 'cmp-dialog-truncated'
      : !dialog && cmp?.dialogMentionsFailed === true
        ? 'cmp-dialog-unread'
        : null;
    let dialogGapMatters = false;

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

      // A name only in hidden text of the policy stays that finding: whether the policy names the service is open.
      const dialogTerm = dialog && verdict.variant !== 'ambiguous-match' ? dialogMention(info, dialog) : null;
      const variant: Variant = dialogTerm ? 'named-in-cmp-only' : verdict.variant;
      if (!dialogTerm && verdict.variant !== 'ambiguous-match' && dialogGap) dialogGapMatters = true;

      const evidence: EvidenceInput[] = [
        ...searched,
        ...(dialog && dialogTerm ? dialogEvidence(dialog, dialogTerm) : []),
        ...(verdict.textMatch ? [verdict.textMatch] : []),
      ];
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
        variant,
        confidence: variant === 'not-named' || variant === 'named-in-cmp-only' ? 'medium' : 'high',
        subject: subjects.service(svc.serviceId),
        category: info.category,
        phases: seen.phases,
        pages: seen.pages,
        evidence,
        params: {
          service: info.name,
          companies: companyNames(info),
          policyUrl: main.finalUrl || main.url,
          policyUrls,
          documentCount: html.length,
          pageCount: seen.pages.length,
          category: info.category,
          partCount: text.parts.length,
          complete: main.complete,
          requestCount: requests.length,
          ...(dialog && dialogTerm
            ? {
                cmp: dialog.cmpName,
                cmpTerm: dialogTerm,
                categoryOnly: verdict.variant === 'category-only',
              }
            : {}),
        },
        ...serviceFields(derived, svc.serviceId),
      });
    }
    // The rest of a cut dialog text, or the text that could not be read, may name a service no document names.
    if (dialogGapMatters && dialogGap) limitations.push(dialogGap);

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      observations,
      limitations,
      coverage: { evaluated, note: `negation-not-parsed` },
    };
  },
});
