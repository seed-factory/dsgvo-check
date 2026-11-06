/**
 * PRIV-02 (P0): a statement of the privacy policy about how a service is embedded ("Google Fonts lokal installiert",
 * "erst geladen, wenn Sie zustimmen") held against the requests the browser observed. The statements come from the
 * dictionary test/data/legal/claims.yaml; a statement not in it is not recognised, so no finding is no confirmation of
 * the policy. PRIV-01 and EMBED-01 keep their own findings; assess links them by service.
 */
import type { CmpSection } from '../../cmp/types.ts';
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type { BrowserSection, DocumentRecord, RequestRecord } from '../../core/snapshot/browser.ts';
import type {
  ClassifiedHint,
  ClassifiedRequest,
  DerivedSection,
  ServiceCategory,
} from '../../derive/types.ts';
import { isSupplement, policyDocuments, policyEvidence, policyText } from './documents.ts';
import { MAX_EVIDENCE, requestEvidencePerContext } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import {
  type ClaimScope,
  claimsFromData,
  type PolicyClaim,
  type PolicyDisclosure,
  QUOTE_MAX_CHARS,
  readPolicyClaims,
  type ServiceVocabulary,
  serviceVocabulary,
} from './policy-claims.ts';
import { type RejectFacts, rejectFacts } from './reject-moment.ts';
import { serviceFields, serviceName } from './services.ts';
import { bannerState, consentSignals, signalOutcome } from './signals.ts';
import { hasPhaseA, noPhaseAReason, pageIndex, requestIndex, throttleAware } from './snapshot.ts';

const ID = 'PRIV-02';

/** Strongest first; one finding per service. */
const RANK = ['contradiction-replicated', 'contradiction-single', 'wording-to-review'] as const;
type Variant = (typeof RANK)[number];

/** Order of the kinds in the `claim` param (`self-hosted+no-connection`), as the texts select them. */
const KIND_ORDER = ['self-hosted', 'no-connection', 'consent-gated'];
/** Quotes per finding: the statements first, then the disclosures of a template that describes both variants. */
const MAX_CLAIM_QUOTES = 4;
const MAX_DISCLOSURE_QUOTES = 2;
/**
 * A map or video service in the main frame loads its own fonts (Maps JavaScript API): its navigation is left out. Such
 * an embed shows nothing without its connection, so a statement that there is none holds until consent at most.
 */
const EMBED_CATEGORIES: ReadonlySet<ServiceCategory> = new Set(['maps', 'video']);

interface Item {
  r: RequestRecord;
  c: ClassifiedRequest;
}

/** What the browser observed of one service: delivered requests, requests without a response, connection hints. */
interface Use {
  /** Delivered requests of the site's own frames, or of the service's own embed frame. */
  delivered: Item[];
  /** Requests that got no network response (failed, aborted, blocked). */
  attempted: Item[];
  hints: ClassifiedHint[];
}

interface Basis {
  confirmedReject: boolean;
  /** Navigations with a map or video service in the main frame. */
  embedNavigations: ReadonlySet<string>;
}

/** The page of a request, a subframe's by its frame's document (`pageIndex`). */
type PageOf = (r: RequestRecord) => string;

const navigationOf = (r: RequestRecord) => `${r.phase}\n${r.navigationId ?? r.pageUrl}`;
const contextOf = (r: RequestRecord, pageOf: PageOf) => `${r.phase}\n${pageOf(r)}`;

/**
 * Requests of a service the site itself made: not a resource of another service's embed frame (a map frame's fonts
 * belong to the map), but the requests of the service's own frame (the map frame itself) count.
 */
function ownRequest(c: ClassifiedRequest): boolean {
  if (!c.serviceId || !c.thirdParty || c.source === 'embed-frame') return false;
  return !c.frameServiceId || c.frameServiceId === c.serviceId;
}

function usesByService(derived: DerivedSection, records: Map<string, RequestRecord>): Map<string, Use> {
  const out = new Map<string, Use>();
  const use = (id: string) => {
    let u = out.get(id);
    if (!u) {
      u = { delivered: [], attempted: [], hints: [] };
      out.set(id, u);
    }
    return u;
  };
  for (const c of derived.requests) {
    const r = records.get(c.requestId);
    if (!r || !c.serviceId || !ownRequest(c)) continue;
    (c.delivered ? use(c.serviceId).delivered : use(c.serviceId).attempted).push({ r, c });
  }
  for (const h of derived.hints ?? []) {
    if (!h.serviceId || !h.thirdParty || (h.rel !== 'preconnect' && h.rel !== 'dns-prefetch')) continue;
    use(h.serviceId).hints.push(h);
  }
  return out;
}

function embedNavigations(derived: DerivedSection, records: Map<string, RequestRecord>): Set<string> {
  const out = new Set<string>();
  for (const c of derived.requests) {
    const r = records.get(c.requestId);
    if (!r?.isMainFrame || !c.serviceId || c.source === 'embed-frame') continue;
    if (EMBED_CATEGORIES.has(c.category)) out.add(navigationOf(r));
  }
  return out;
}

type Counted = 'yes' | 'no' | 'excluded';

/**
 * Whether a request contradicts a statement of `scope`. Before an interaction it always does. After the reject, an
 * unconditional statement is contradicted by any load, a statement "until consent" only after a confirmed reject.
 * After the accept only an unconditional statement is, and not in a navigation with a map or video service in the
 * main frame, whose own fonts look like the site's.
 */
function counted(item: Item, scope: ClaimScope, basis: Basis): Counted {
  switch (item.c.timing ?? 'before-interaction') {
    case 'before-interaction':
      return 'yes';
    case 'after-reject':
      return scope === 'unconditional' || basis.confirmedReject ? 'yes' : 'no';
    case 'after-accept':
      if (scope !== 'unconditional') return 'no';
      return basis.embedNavigations.has(navigationOf(item.r)) ? 'excluded' : 'yes';
  }
}

/** Hints carry no click time: those of phase A count, those of phase B as a request after the reject would. */
function hintCounted(h: ClassifiedHint, scope: ClaimScope, basis: Basis): boolean {
  if (h.phase === 'A') return true;
  return h.phase === 'B' && (scope === 'unconditional' || basis.confirmedReject);
}

interface Held {
  claim: PolicyClaim;
  delivered: Item[];
  attempted: Item[];
  hints: ClassifiedHint[];
  excluded: number;
}

/**
 * The scope a statement is held to for a service. "Keine Verbindung" about a map or a video is the two-click text of a
 * consent solution ("Vorher wird keine Verbindung zu Google hergestellt"): the embed cannot show without the connection,
 * so the statement holds until consent, and a load after the accept does not contradict it.
 */
function scopeFor(claim: PolicyClaim, category: ServiceCategory | undefined): ClaimScope {
  if (claim.kind === 'no-connection' && category && EMBED_CATEGORIES.has(category)) return 'until-consent';
  return claim.scope;
}

function holdAgainst(
  claim: PolicyClaim,
  category: ServiceCategory | undefined,
  use: Use | undefined,
  basis: Basis,
): Held {
  const scope = scopeFor(claim, category);
  const delivered: Item[] = [];
  let excluded = 0;
  for (const item of use?.delivered ?? []) {
    const k = counted(item, scope, basis);
    if (k === 'yes') delivered.push(item);
    else if (k === 'excluded') excluded++;
  }
  return {
    claim,
    delivered,
    attempted: (use?.attempted ?? []).filter((i) => counted(i, scope, basis) === 'yes'),
    hints: (use?.hints ?? []).filter((h) => hintCounted(h, scope, basis)),
    excluded,
  };
}

function union(items: Iterable<Item>): Item[] {
  const byId = new Map<string, Item>();
  for (const i of items) byId.set(i.r.id, i);
  return [...byId.values()];
}

type BasisCode = 'request' | 'disclosure' | 'attempt' | 'hint' | 'attempt-and-hint';

interface Verdict {
  variant: Variant;
  basis: BasisCode;
  held: Held[];
  items: Item[];
  hints: ClassifiedHint[];
}

/**
 * The verdict for one service over its statements. Delivered requests against a statement its document does not also
 * contradict itself: replicated or single by the number of contexts. Delivered requests against a statement next to a
 * disclosure of the same kind in the same document, or only failed requests and connection hints: wording-to-review.
 */
function verdictOf(
  held: readonly Held[],
  disclosed: (claim: PolicyClaim) => boolean,
  minContexts: number,
  pageOf: PageOf,
): Verdict | null {
  const clear = held.filter((h) => h.delivered.length > 0 && !disclosed(h.claim));
  if (clear.length > 0) {
    const items = union(clear.flatMap((h) => h.delivered));
    const contexts = new Set(items.map((i) => contextOf(i.r, pageOf))).size;
    const variant = contexts >= minContexts ? 'contradiction-replicated' : 'contradiction-single';
    return { variant, basis: 'request', held: clear, items, hints: [] };
  }
  const both = held.filter((h) => h.delivered.length > 0);
  if (both.length > 0) {
    const items = union(both.flatMap((h) => h.delivered));
    return { variant: 'wording-to-review', basis: 'disclosure', held: both, items, hints: [] };
  }
  const weak = held.filter((h) => h.attempted.length > 0 || h.hints.length > 0);
  if (weak.length === 0) return null;
  const items = union(weak.flatMap((h) => h.attempted));
  const hints = [...new Set(weak.flatMap((h) => h.hints))];
  const basis = items.length === 0 ? 'hint' : hints.length === 0 ? 'attempt' : 'attempt-and-hint';
  return { variant: 'wording-to-review', basis, held: weak, items, hints };
}

/** One item per moment in turn, so the evidence shows the load before the interaction and after the reject alike. */
function interleavedByMoment(items: readonly Item[]): Item[] {
  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const key = `${i.r.phase}\n${i.c.timing ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const lists = [...groups.values()];
  const out: Item[] = [];
  for (let n = 0; out.length < items.length; n++) for (const l of lists) if (l[n]) out.push(l[n] as Item);
  return out;
}

function quoteEvidence(
  part: PolicyClaim['part'],
  sentence: string,
  matchLevel: 'named' | 'category',
  claim?: string,
): EvidenceInput {
  return {
    type: 'text-match',
    documentId: part.documentId,
    section: part.section ?? null,
    quote: sentence,
    matchLevel,
    negation: 'none',
    ...(claim ? { claim } : {}),
  };
}

/** The first words of the service's companies ("Google"), else its name: whose servers the policy speaks of. */
function companyOf(vocab: ServiceVocabulary, serviceId: string, name: string): string {
  const brands = [...(vocab.byId.get(serviceId)?.brands ?? [])].sort();
  return brands.join(', ') || name;
}

interface RunContext {
  browser: BrowserSection;
  cmp: CmpSection;
  derived: DerivedSection;
  records: Map<string, RequestRecord>;
  vocab: ServiceVocabulary;
  documents: ReadonlyMap<string, DocumentRecord>;
  documentEvidence: EvidenceInput;
  policyUrl: string;
  reject: RejectFacts;
  pageOf: PageOf;
  minCandidatePages: number;
}

/**
 * High when the service comes from the sentence or its heading in a complete document; medium for a statement that
 * inherits its service from the previous sentence, covers a category, or stands in a document with parts not read
 * (the core caps medium at `warning`).
 */
function confidenceOf(held: readonly Held[], documents: ReadonlyMap<string, DocumentRecord>) {
  const high = held.some(
    (h) =>
      (h.claim.via === 'sentence' || h.claim.via === 'heading') &&
      documents.get(h.claim.part.documentId)?.complete === true,
  );
  return high ? 'high' : 'medium';
}

function observationOf(
  serviceId: string,
  verdict: Verdict,
  disclosures: readonly PolicyDisclosure[],
  run: RunContext,
): Observation {
  const info = run.derived.catalog[serviceId];
  const service = serviceName(run.derived, serviceId);
  const kinds = sortedUniq(verdict.held.map((h) => h.claim.kind)).sort(
    (a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b),
  );
  // After a confirmed reject only where it is in effect: a control page that shows the banner again had no answer.
  const afterReject =
    run.reject.proof.length > 0 &&
    verdict.items.some((i) => i.c.timing === 'after-reject' && run.reject.inEffect(run.pageOf(i.r)));

  const evidence: EvidenceInput[] = [run.documentEvidence];
  const quoted = new Set<string>();
  for (const h of verdict.held) {
    const key = `${h.claim.kind}\n${h.claim.sentence}`;
    if (quoted.has(key) || quoted.size >= MAX_CLAIM_QUOTES) continue;
    quoted.add(key);
    const level = h.claim.via === 'category' ? 'category' : 'named';
    evidence.push(quoteEvidence(h.claim.part, h.claim.sentence, level, h.claim.kind));
  }
  if (verdict.basis === 'disclosure') {
    const documents = new Set(verdict.held.map((h) => h.claim.part.documentId));
    // A disclosure too long to quote whole still counts, it is only left out of the evidence.
    const own = disclosures.filter(
      (d) =>
        d.serviceIds.includes(serviceId) &&
        kinds.includes(d.kind) &&
        documents.has(d.part.documentId) &&
        d.sentence.length <= QUOTE_MAX_CHARS,
    );
    for (const sentence of sortedUniq(own.map((d) => d.sentence)).slice(0, MAX_DISCLOSURE_QUOTES)) {
      const d = own.find((x) => x.sentence === sentence) as PolicyDisclosure;
      evidence.push(quoteEvidence(d.part, sentence, 'named'));
    }
  }
  if (afterReject) evidence.push(...run.reject.proof);
  evidence.push(
    ...requestEvidencePerContext(interleavedByMoment(verdict.items), MAX_EVIDENCE - evidence.length),
  );
  for (const h of verdict.hints.slice(0, Math.max(0, MAX_EVIDENCE - evidence.length))) {
    evidence.push({ type: 'link', href: h.href, text: `rel=${h.rel}`, phase: h.phase, page: h.pageUrl });
  }

  const pages = sortedUniq([
    ...verdict.items.map((i) => run.pageOf(i.r)),
    ...verdict.hints.map((h) => h.pageUrl),
  ]);
  const contexts = new Set([
    ...verdict.items.map((i) => contextOf(i.r, run.pageOf)),
    ...verdict.hints.map((h) => `${h.phase}\n${h.pageUrl}`),
  ]);
  const hosts = sortedUniq([...verdict.items.map((i) => i.c.host), ...verdict.hints.map((h) => h.host)]);

  return {
    checkId: ID,
    variant: verdict.variant,
    confidence: confidenceOf(verdict.held, run.documents),
    subject: subjects.service(serviceId),
    ...(info ? { category: info.category } : {}),
    phases: sortedUniq([
      ...verdict.items.map((i) => i.r.phase),
      ...verdict.hints.map((h) => h.phase),
    ]) as Phase[],
    pages,
    evidence,
    params: {
      service,
      company: companyOf(run.vocab, serviceId, service),
      claim: kinds.join('+'),
      policyUrl: run.policyUrl,
      contextCount: contexts.size,
      pageCount: pages.length,
      requestCount: verdict.items.length,
      hosts: hosts.join(', '),
      afterReject,
      bannerFound: bannerState(run.cmp, run.browser, run.minCandidatePages),
      basis: verdict.basis,
    },
    ...serviceFields(run.derived, serviceId),
  };
}

/** Services the site loaded, by category: what a statement about a whole category covers. */
function observedByCategory(derived: DerivedSection): Map<ServiceCategory, string[]> {
  const out = new Map<ServiceCategory, string[]>();
  for (const s of derived.services)
    out.set(s.category, sortedUniq([...(out.get(s.category) ?? []), s.serviceId]));
  return out;
}

export const priv02 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'documents', 'derived', 'cmp'],
  data: ['legal'],
  variants: RANK.map((variant) => ({ variant, variantGroup: 'policy-claim' })),
  run({ browser, documents, derived, cmp }, ctx) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    if (!hasPhaseA(browser)) {
      const reason = noPhaseAReason(browser, 'no-network-observation');
      return { status: 'inconclusive', reason, observations: [] };
    }
    const found = policyDocuments(documents);
    if ('reason' in found) return { status: 'inconclusive', reason: found.reason, observations: [] };

    // Only the policy: the finding names it as the page that makes the statement, and a further notice of the site
    // could neither be quoted under that name nor disclose a load for a statement of the policy.
    const html = found.html.filter((d) => !isSupplement(d));
    const main = html[0] as DocumentRecord;
    const text = policyText(html);
    const vocab = serviceVocabulary(derived.serviceNames ?? []);
    const read = readPolicyClaims(
      text.parts,
      claimsFromData(ctx.data.legal),
      vocab,
      observedByCategory(derived),
    );

    const records = requestIndex(browser);
    const reject = rejectFacts(browser, cmp);
    const basis: Basis = {
      confirmedReject: reject.proof.length > 0,
      embedNavigations: embedNavigations(derived, records),
    };
    const run: RunContext = {
      browser,
      cmp,
      derived,
      records,
      vocab,
      documents: new Map(html.map((d) => [d.id, d])),
      documentEvidence: policyEvidence(main, html, text.parts),
      policyUrl: main.finalUrl || main.url,
      reject,
      pageOf: pageIndex(browser),
      minCandidatePages: ctx.thresholds.cmp.minCandidatePages,
    };

    const uses = usesByService(derived, records);
    const byService = new Map<string, Held[]>();
    const ambiguousByService = new Map<string, Held[]>();
    let excluded = 0;
    for (const claim of read.claims) {
      for (const serviceId of claim.serviceIds) {
        const category = derived.catalog[serviceId]?.category ?? vocab.byId.get(serviceId)?.category;
        const held = holdAgainst(claim, category, uses.get(serviceId), basis);
        const target = claim.ambiguous ? ambiguousByService : byService;
        target.set(serviceId, [...(target.get(serviceId) ?? []), held]);
        if (!claim.ambiguous) excluded += held.excluded;
      }
    }

    const minContexts = ctx.thresholds.legal.policyClaimMinContexts;
    const observations: Observation[] = [];
    let ambiguousOnly = false;
    for (const serviceId of [...new Set([...byService.keys(), ...ambiguousByService.keys()])].sort()) {
      const disclosed = (claim: PolicyClaim) =>
        read.disclosures.some(
          (d) =>
            d.kind === claim.kind &&
            d.part.documentId === claim.part.documentId &&
            d.serviceIds.includes(serviceId),
        );
      const verdict = verdictOf(byService.get(serviceId) ?? [], disclosed, minContexts, run.pageOf);
      if (verdict) {
        observations.push(observationOf(serviceId, verdict, read.disclosures, run));
        continue;
      }
      const ambiguous = verdictOf(
        ambiguousByService.get(serviceId) ?? [],
        disclosed,
        minContexts,
        run.pageOf,
      );
      if (ambiguous) ambiguousOnly = true;
    }

    const limitations: string[] = [];
    if (html.some((d) => d.manifest.expandablesOpened < d.manifest.expandablesFound))
      limitations.push('banner-open');
    if (excluded > 0) limitations.push('embed-navigation-excluded');
    const coverage = { evaluated: read.claims.filter((c) => !c.ambiguous).length };

    if (observations.length === 0 && ambiguousOnly) {
      return { status: 'inconclusive', reason: 'claim-ambiguous', observations, limitations, coverage };
    }
    const outcome = throttleAware(browser, { status: 'completed', observations, limitations, coverage });
    return outcome.limitations?.length ? { ...outcome, status: 'partial' } : outcome;
  },
});
