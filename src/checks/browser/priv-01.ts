/**
 * PRIV-01 (P0): a loaded catalog service is looked up in the Datenschutzerklärung by levels named > company > domain >
 * category. The further privacy notices of the site that phase A read beside the policy are searched with it: a
 * mention in any of them counts. A service no document names, but that the consent dialog of the site names itself
 * (its collapsed service details, read once in phase A for a CMP its own adapter recognised), is `named-in-cmp-only`;
 * a dialog text that was cut or could not be read is a limitation while a service stays unnamed. Negations are not
 * parsed, so `not-named` and `named-in-cmp-only` are capped at `medium`. A missing policy is LEGAL-01's finding.
 */

import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { DocumentRecord, RequestRecord } from '../../core/snapshot/browser.ts';
import type { CmpDialogText } from '../../core/snapshot/cmp-dialog.ts';
import type { ServiceInfo, ServiceObservation } from '../../derive/types.ts';
import { normalizeText, type PolicyText, policyDocuments, policyText } from './documents.ts';
import { distinctRequestEvidence, MAX_EVIDENCE } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields } from './services.ts';
import { requestIndex } from './snapshot.ts';
import { type StoredIdentifier, storedIdentifiersByService } from './stored.ts';

const ID = 'PRIV-01';

/** A quoted passage starts this far before the match and is at most this long. */
const QUOTE_LEAD_CHARS = 80;
const QUOTE_MAX_CHARS = 200;
/** A quote of the dialog text is shorter: it goes into the finding's text as well. */
const DIALOG_QUOTE_LEAD_CHARS = 40;
const DIALOG_QUOTE_MAX_CHARS = 120;

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

type Variant = 'not-named' | 'category-only' | 'ambiguous-match' | 'named-in-cmp-only';

/**
 * The dialog text with its search form: `text` as `normalizeText` gives it (lower case, umlauts spelled out, every run
 * of other characters one space), `from` the index in the dialog text that each character of `text` comes from. A name
 * found in the search form is quoted where the dialog writes it, on the same word boundaries and whatever its spelling
 * there (`Google-Tag-Manager`, `Übersetzer`).
 */
interface DialogSearch {
  record: CmpDialogText;
  text: string;
  from: number[];
}

/** A letter with its combining marks, folded together as `normalizeText` folds the whole text. */
const FOLD_UNIT_RE = /\P{M}\p{M}*|\p{M}+/gu;

function dialogSearch(record: CmpDialogText): DialogSearch {
  let text = ' ';
  const from = [0];
  const separate = (at: number) => {
    if (text.endsWith(' ')) return;
    text += ' ';
    from.push(at);
  };
  for (const m of record.text.matchAll(FOLD_UNIT_RE)) {
    const unit = m[0];
    const folded = /^[A-Za-z0-9]$/.test(unit) ? unit.toLowerCase() : normalizeText(unit).trim();
    // A soft hyphen and a lone combining mark vanish in `normalizeText`; every other character it drops separates.
    if (folded === '') {
      if (unit !== '\u00AD' && !/^\p{M}+$/u.test(unit)) separate(m.index);
      continue;
    }
    for (const c of folded) {
      if (c === ' ') separate(m.index);
      else {
        text += c;
        from.push(m.index);
      }
    }
  }
  separate(record.text.length);
  return { record, text, from };
}

/** At most 120 characters of the dialog text around `[at, end)`, cut at spaces, `…` where it goes on. */
function dialogQuote(text: string, at: number, end: number): string {
  let start = Math.max(0, at - DIALOG_QUOTE_LEAD_CHARS);
  const space = start > 0 && text[start - 1] !== ' ' ? text.indexOf(' ', start) : -1;
  if (space !== -1 && space < at) start = space + 1;
  let stop = Math.min(text.length, start + DIALOG_QUOTE_MAX_CHARS);
  const last = stop < text.length ? text.lastIndexOf(' ', stop) : -1;
  if (last >= end) stop = last;
  return `${start > 0 ? '…' : ''}${text.slice(start, stop).trim()}${stop < text.length ? '…' : ''}`;
}

/**
 * Whether the consent dialog names the service: by its name or an alias only. Its company, domain or category there
 * do not count: a dialog gives the provider and the purpose of each service it lists, so they name another service of
 * the same company as well.
 */
function dialogMention(
  info: ServiceInfo,
  dialog: DialogSearch,
): { record: CmpDialogText; quote: string } | null {
  const found = matchLevel(info, dialog.text, false);
  if (found.level !== 'named' || !found.term) return null;
  // `contains` found the term in the search form, between spaces: its first and last letter map back to the text.
  const term = normalizeText(found.term);
  const i = dialog.text.indexOf(term);
  const at = dialog.from[i + 1];
  const end = dialog.from[i + term.length - 1];
  if (at === undefined || end === undefined) return null;
  return { record: dialog.record, quote: dialogQuote(dialog.record.text, at, end) };
}

/** The CMP whose dialog was read and the passage that names the service. */
function dialogEvidence(d: CmpDialogText, quoted: string): EvidenceInput[] {
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
      documentId: d.id,
      section: null,
      quote: quoted,
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

    const dialog = cmp?.dialogText ? dialogSearch(cmp.dialogText) : null;
    // What keeps the dialog from settling a service no document names: its text was cut, or could not be read.
    const dialogGap = dialog?.record.truncated
      ? 'cmp-dialog-truncated'
      : !dialog && cmp?.dialogTextFailed === true
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
      const inDialog = dialog && verdict.variant !== 'ambiguous-match' ? dialogMention(info, dialog) : null;
      const variant: Variant = inDialog ? 'named-in-cmp-only' : verdict.variant;
      if (!inDialog && verdict.variant !== 'ambiguous-match' && dialogGap) dialogGapMatters = true;

      const evidence: EvidenceInput[] = [
        ...searched,
        ...(inDialog ? dialogEvidence(inDialog.record, inDialog.quote) : []),
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
          ...(inDialog
            ? {
                cmp: inDialog.record.cmpName,
                cmpQuote: inDialog.quote,
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
