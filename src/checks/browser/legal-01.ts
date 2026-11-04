/** LEGAL-01 (P0): Impressum and Datenschutzerklärung reachable from the evaluated pages; one verdict per document kind. */

import type { CmpSection } from '../../cmp/types.ts';
import {
  isUnconfirmedDocument,
  type LegalLexicon,
  legalLexiconFromData,
  matchLegalLinks,
  matchNav,
  pageKey,
  pathOfUrl,
} from '../../collectors/browser/legal/lexicon.ts';
import {
  defineCheck,
  type EvidenceInput,
  isHttpHref,
  type Observation,
  type Phase,
  subjects,
} from '../../core/api.ts';
import type {
  BrowserSection,
  DocumentKind,
  DocumentRecord,
  DocumentsSection,
  LinkFact,
  PageVisit,
} from '../../core/snapshot/browser.ts';
import { judgedNotDocument, usableDocument } from './documents.ts';
import { pageEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { allCmpFacts } from './signals.ts';
import { phaseRecord, visitedPages } from './snapshot.ts';

const ID = 'LEGAL-01';
const KINDS: readonly DocumentKind[] = ['impressum', 'privacy'];

/** Link kinds without a target to check: `#`, `javascript:` and empty hrefs. */
const UNRESOLVED_HREFS = new Set(['fragment', 'javascript', 'empty']);

/** At most this many pages or attempts go into the evidence of one observation. */
const MAX_LEGAL_EVIDENCE = 6;

function linkInput(l: { text: string; accessibleName?: string; href: string | null }) {
  return {
    text: l.text,
    ...(l.accessibleName ? { accessibleName: l.accessibleName } : {}),
    path: l.href ? pathOfUrl(l.href) : '',
  };
}

/**
 * Links of a page that point to the document `kind`. A hidden consent-banner link to another registrable domain is a
 * CMP vendor's policy link, not the site's. A weak key loses against an exact label of the other kind on the same target.
 */
function linksOfKind(lex: LegalLexicon, links: readonly LinkFact[], kind: DocumentKind): LinkFact[] {
  const own = links.filter((l) => !(l.region === 'banner' && !l.visible && l.sameSite === false));
  const found = matchLegalLinks(
    lex,
    kind,
    own.map((l) => ({
      input: linkInput(l),
      page: l.href !== null && isHttpHref(l.hrefKind) ? pageKey(l.href) : '',
    })),
  );
  return own.filter((_, i) => found[i] !== null);
}

function isBlockedPage(p: PageVisit): boolean {
  return (
    !p.evaluable &&
    (p.challenge.detected ||
      p.notEvaluableReason === 'challenge' ||
      (p.notEvaluableReason ?? '').startsWith('navigation-failed'))
  );
}

function sameDoc(p: PageVisit, kind: DocumentKind, docs: readonly DocumentRecord[]): boolean {
  const url = p.finalUrl || p.url;
  return p.role === kind || docs.some((d) => d.url === url || d.finalUrl === url);
}

/** The link list was cut at the collector's limit, so a missing link proves nothing. */
function linksTruncated(p: PageVisit): boolean {
  return p.dom?.linksTruncated === true;
}

type Attempt = DocumentsSection['attempts'][number];

/** Found through the site's own link: a link on a page, or the one the configuration names. */
const foundByLink = (d: DocumentRecord): boolean => d.foundVia === 'link' || d.foundVia === 'config';

/** The attempt proves the URL answers with an error (4xx or an error page); `hop` attempts also record "no link". */
function provesBroken(a: Attempt): boolean {
  if (a.outcome === 'soft-404') return true;
  if (a.outcome !== 'not-found') return false;
  return a.status === null ? a.via !== 'hop' : a.status >= 400;
}

type LinkClass = 'working' | 'broken' | 'blocked' | 'unconfirmed' | 'unverified';

type Variant =
  | 'document-not-found'
  | 'links-broken'
  | 'link-missing-on-some-pages'
  | 'reachable-via-intermediate'
  | 'unresolved'
  | 'footer-covered-by-banner';

type ObservationParams = Record<string, string | number | boolean | null>;

type Emit = (
  variant: Variant,
  confidence: Observation['confidence'],
  evidence: EvidenceInput[],
  params: ObservationParams,
  pages: string[],
) => void;

/** Shared facts of one run, the same for both document kinds. */
interface Env {
  lex: LegalLexicon;
  documents: DocumentsSection;
  pages: PageVisit[];
  evaluated: PageVisit[];
  /** A target behind a challenge or a failed navigation proves nothing about the document. */
  blockedKeys: ReadonlySet<string>;
  phaseA: ReturnType<typeof phaseRecord>;
  /** The collector could have visited an intermediate page: a same-site contact/rechtliches/über-uns link. */
  hopCandidates: boolean;
  hopVisited: boolean;
}

/** What the check has concluded so far, over all document kinds. */
interface Verdicts {
  observations: Observation[];
  limitations: string[];
  blockedKinds: number;
}

interface PageLinks {
  /** A link that is neither known broken nor blocked: the page does have a link to the document. */
  present: boolean;
  toBlocked: boolean;
  unresolved: boolean;
  hrefs: string[];
}

interface PageStatus {
  p: PageVisit;
  s: PageLinks;
}

/** Everything the verdict for one document kind rests on. */
interface KindAnalysis {
  docs: DocumentRecord[];
  /** Documents not judged an error page or "not the document". */
  good: DocumentRecord[];
  attempts: Attempt[];
  classify: (href: string) => LinkClass;
  blocked: boolean;
  status: PageStatus[];
  /** Pages without a link to the document whose link list is complete. */
  missing: PageStatus[];
  /** Pages without a link, but with a link list that was cut: they prove nothing. */
  missingTruncated: PageStatus[];
  unresolvedOnly: PageStatus[];
  pageTotal: number;
  allHrefs: string[];
  /** Every link of the kind is confirmed broken: one working or unchecked link is enough to say otherwise. */
  allBroken: boolean;
  /** The site's own link (or hop) leads to a page not confirmed as the document. A fallback path serving another page is negative evidence for that path only. */
  unconfirmedLink: boolean;
  /** The target of the direct link is open: "not reachable by a direct link" cannot be said. */
  unconfirmedDirect: boolean;
  attemptEvidence: EvidenceInput[];
}

const docEvidence = (d: DocumentRecord): EvidenceInput => ({
  type: 'document',
  url: d.finalUrl || d.url,
  kind: d.kind,
  lang: d.lang,
  complete: d.complete,
  errors: d.errors,
  phase: d.phase,
  ...(d.sha256 ? { sha256: d.sha256 } : {}),
});

const pageUrl = (p: PageVisit): string => p.finalUrl || p.url;
const sortedPageUrls = (xs: readonly PageStatus[]): string[] => xs.map((x) => pageUrl(x.p)).sort();
const pageEvidenceOf = (xs: readonly PageStatus[]): EvidenceInput[] =>
  xs.slice(0, MAX_LEGAL_EVIDENCE).map((x) => pageEvidence(x.p));

/**
 * The pages the verdict rests on. A probe judged an error page or not the document is no checked page of the site and
 * stays only in the observed coverage; likewise a page behind a legal link judged an error page for the other kind.
 * A merely unconfirmed page is substantive and stays.
 */
function judgedPages(browser: BrowserSection, documents: DocumentsSection) {
  const pages = visitedPages(browser, ['A', 'B']).filter((p) => !p.reload);
  const unjudged = new Set(documents.attempts.filter(judgedNotDocument).map((a) => pageKey(a.url)));
  const soft404 = new Set(
    documents.attempts.filter((a) => a.outcome === 'soft-404').map((a) => pageKey(a.url)),
  );
  const hits = (p: PageVisit, keys: ReadonlySet<string>) =>
    [p.url, p.finalUrl].some((u) => u && keys.has(pageKey(u)));
  const isProbeOfError = (p: PageVisit) =>
    ((p.role === 'fallback' || p.role === 'legal-hop') && hits(p, unjudged)) ||
    ((p.role === 'impressum' || p.role === 'privacy') && hits(p, soft404));

  const probes = pages.filter(isProbeOfError);
  const evaluated = pages.filter((p) => p.evaluable && p.dom && !isProbeOfError(p));
  const coverage = {
    observed: pages.length,
    evaluated: evaluated.length,
    ...(probes.length > 0 ? { note: `error-page-probes:${probes.length}` } : {}),
  };
  return { pages, evaluated, coverage };
}

function hasHopCandidate(lex: LegalLexicon, evaluated: readonly PageVisit[]): boolean {
  const startLinks = evaluated.filter((p) => p.role === 'start').flatMap((p) => p.dom?.links ?? []);
  return startLinks.some(
    (l) =>
      isHttpHref(l.hrefKind) &&
      l.sameSite !== false &&
      (matchNav(lex.contact, linkInput(l)) !== null || matchNav(lex.hop, linkInput(l)) !== null),
  );
}

function buildEnv(lex: LegalLexicon, browser: BrowserSection, documents: DocumentsSection) {
  const { pages, evaluated, coverage } = judgedPages(browser, documents);
  const env: Env = {
    lex,
    documents,
    pages,
    evaluated,
    blockedKeys: new Set(
      pages.filter(isBlockedPage).flatMap((p) => [pageKey(p.url), pageKey(p.finalUrl || p.url)]),
    ),
    phaseA: phaseRecord(browser, 'A'),
    hopCandidates: hasHopCandidate(lex, evaluated),
    hopVisited: pages.some((p) => p.role === 'contact' || p.role === 'legal-hop'),
  };
  return { env, coverage };
}

/** Classifies every link of the evaluated pages against the attempts and documents of one kind. */
function analyzeKind(kind: DocumentKind, env: Env): KindAnalysis {
  const { lex, documents, pages, evaluated, blockedKeys } = env;
  const docs = documents.documents.filter((d) => d.kind === kind);
  const good = docs.filter((d) => usableDocument(d, documents.attempts));
  const attempts = documents.attempts.filter((a) => a.kind === kind);
  const unconfirmedAttempts = attempts.filter((a) => a.outcome === 'unconfirmed');

  const keysOf = (xs: Iterable<string>) => new Set([...xs].map(pageKey));
  const goodKeys = keysOf(good.flatMap((d) => [d.url, d.finalUrl]));
  const foundKeys = keysOf(attempts.filter((a) => a.outcome === 'found').map((a) => a.url));
  const brokenKeys = keysOf(attempts.filter(provesBroken).map((a) => a.url));
  const unconfirmedKeys = keysOf(unconfirmedAttempts.map((a) => a.url));
  const classify = (href: string): LinkClass => {
    const key = pageKey(href);
    if (blockedKeys.has(key)) return 'blocked';
    if (goodKeys.has(key) || foundKeys.has(key)) return 'working';
    if (brokenKeys.has(key)) return 'broken';
    if (unconfirmedKeys.has(key)) return 'unconfirmed';
    return 'unverified';
  };
  const blocked =
    attempts.some((a) => a.outcome === 'error' || blockedKeys.has(pageKey(a.url))) ||
    pages.some((p) => p.role === kind && isBlockedPage(p));

  const linkStatus = (p: PageVisit): PageLinks => {
    const links = linksOfKind(lex, p.dom?.links ?? [], kind);
    const http = links.filter((l) => l.href !== null && !UNRESOLVED_HREFS.has(l.hrefKind));
    const classes = http.map((l) => classify(l.href as string));
    return {
      present: classes.some((c) => c === 'working' || c === 'unverified' || c === 'unconfirmed'),
      toBlocked: classes.includes('blocked'),
      unresolved: links.some((l) => UNRESOLVED_HREFS.has(l.hrefKind)),
      hrefs: http.map((l) => l.href as string),
    };
  };
  const status = evaluated.filter((p) => !sameDoc(p, kind, docs)).map((p) => ({ p, s: linkStatus(p) }));
  const missingAll = status.filter((x) => !x.s.present && !x.s.unresolved && !x.s.toBlocked);
  const missingTruncated = missingAll.filter((x) => linksTruncated(x.p));
  const allHrefs = status.flatMap((x) => x.s.hrefs);

  return {
    docs,
    good,
    attempts,
    classify,
    blocked,
    status,
    missing: missingAll.filter((x) => !linksTruncated(x.p)),
    missingTruncated,
    unresolvedOnly: status.filter((x) => !x.s.present && x.s.unresolved),
    pageTotal: status.length - missingTruncated.length,
    allHrefs,
    allBroken:
      allHrefs.length > 0 &&
      allHrefs.every((h) => classify(h) === 'broken') &&
      !status.some((x) => x.s.unresolved),
    unconfirmedLink:
      unconfirmedAttempts.some((a) => a.via !== 'fallback') ||
      docs.some((d) => d.foundVia !== 'fallback' && isUnconfirmedDocument(d, documents.attempts)),
    unconfirmedDirect:
      unconfirmedAttempts.some((a) => a.via === 'link') ||
      docs.some((d) => foundByLink(d) && isUnconfirmedDocument(d, documents.attempts)),
    attemptEvidence: attempts
      .filter((a) => a.outcome !== 'found')
      .slice(0, MAX_LEGAL_EVIDENCE)
      .map((a) => ({ type: 'link', href: a.url, text: `${a.via}:${a.outcome}`, status: a.status })),
  };
}

/** The document was found through a link: only pages without that link, or with unresolvable ones, are reported. */
function judgeFoundByLink(a: KindAnalysis, doc: DocumentRecord, emit: Emit): void {
  if (a.missing.length > 0) {
    emit(
      'link-missing-on-some-pages',
      'high',
      [...pageEvidenceOf(a.missing), docEvidence(doc)],
      { missingCount: a.missing.length, foundVia: 'link', reachableViaHop: null },
      sortedPageUrls(a.missing),
    );
  } else if (a.unresolvedOnly.length > 0) {
    emit(
      'unresolved',
      'high',
      pageEvidenceOf(a.unresolvedOnly),
      { missingCount: a.unresolvedOnly.length, foundVia: 'link', reachableViaHop: null },
      sortedPageUrls(a.unresolvedOnly),
    );
  }
}

/** The document was found by the intermediate page or the usual paths, not by a link of the evaluated pages. */
function judgeFoundIndirectly(
  kind: DocumentKind,
  a: KindAnalysis,
  doc: DocumentRecord,
  foundByFallbackOnly: boolean,
  emit: Emit,
  limitations: string[],
): void {
  const missingPages = sortedPageUrls(a.missing);

  if (foundByFallbackOnly && a.allBroken) {
    emit(
      'links-broken',
      'high',
      [...a.attemptEvidence, docEvidence(doc)],
      { missingCount: a.missing.length, foundVia: doc.foundVia, reachableViaHop: false },
      missingPages,
    );
  } else if (a.unconfirmedDirect) {
    // A document found by fallback or hop does not settle a fetched, unconfirmed direct link: a limitation, not "no direct link".
    limitations.push(`${kind}-type-unconfirmed`);
  } else if (a.missing.length > 0 || a.missingTruncated.length === 0) {
    // (Not when the only pages without a link are pages whose link list was cut: "no direct link" is open.)
    emit(
      'reachable-via-intermediate',
      'medium',
      [docEvidence(doc), ...a.attemptEvidence],
      { missingCount: a.missing.length, foundVia: doc.foundVia, reachableViaHop: doc.foundVia === 'hop' },
      missingPages,
    );
  }
}

/** No document was found: unusable links, blocked targets and an unfinished search come before "not found". */
function judgeNoDocument(
  kind: DocumentKind,
  a: KindAnalysis,
  env: Env,
  emit: Emit,
  verdicts: Verdicts,
): void {
  const { limitations } = verdicts;
  const unresolvedAttempt = a.attempts.some((x) => x.outcome === 'unresolved');

  if (a.allBroken && !unresolvedAttempt) {
    emit(
      'links-broken',
      'high',
      [...a.attemptEvidence, ...pageEvidenceOf(a.missing)],
      { missingCount: a.missing.length, foundVia: null, reachableViaHop: false },
      sortedPageUrls(a.missing),
    );
    return;
  }

  // A blocked target comes before every other conclusion about unchecked links.
  if (a.blocked) {
    verdicts.blockedKinds++;
    limitations.push(`${kind}-target-not-evaluable`);
    return;
  }
  if (a.unconfirmedLink) {
    limitations.push(`${kind}-type-unconfirmed`);
    return;
  }

  // Unverified (offsite, not fetched) or `#`/JS links → unresolved, never "missing".
  const candidates = a.status.filter((x) => x.s.present || x.s.unresolved);
  if (candidates.length > 0 || unresolvedAttempt) {
    emit(
      'unresolved',
      'high',
      [...pageEvidenceOf(candidates), ...a.attemptEvidence],
      { missingCount: candidates.length, foundVia: null, reachableViaHop: false },
      sortedPageUrls(candidates),
    );
    return;
  }
  if (a.missing.length === 0 && a.missingTruncated.length > 0) return;

  // The search must run its steps before `critical`: the intermediate page (if there was a candidate) and the usual
  // paths. A fallback skipped because the time budget ended still counts.
  const searchStopped = env.phaseA?.status === 'partial';
  const fallbackChecked = a.attempts.some((x) => x.via === 'fallback');
  const hopChecked = a.attempts.some((x) => x.via === 'hop') || env.hopVisited;
  if (!fallbackChecked || (searchStopped && env.hopCandidates && !hopChecked)) {
    const why = searchStopped ? (env.phaseA?.reason ?? 'partial') : 'fallback-skipped';
    limitations.push(`${kind}-search-incomplete:${why}`);
    return;
  }

  emit(
    'document-not-found',
    'high',
    [...a.attemptEvidence, ...pageEvidenceOf(a.missing)],
    { missingCount: a.missing.length, foundVia: null, reachableViaHop: false, hopChecked, fallbackChecked },
    sortedPageUrls(a.missing),
  );
}

/** One verdict per document kind: found by a link, found indirectly, or one of the reasons it was not. */
function judgeKind(kind: DocumentKind, env: Env, verdicts: Verdicts): void {
  const a = analyzeKind(kind, env);
  const phases = sortedUniq(env.evaluated.map((p) => p.phase)) as Phase[];
  const emit: Emit = (variant, confidence, evidence, params, pages) => {
    verdicts.observations.push({
      checkId: ID,
      variant,
      confidence,
      subject: subjects.document(kind),
      phases,
      pages,
      evidence,
      params: { documentKind: kind, pageTotal: a.pageTotal, ...params },
    });
  };
  if (a.missingTruncated.length > 0) verdicts.limitations.push(`${kind}-links-truncated`);

  const viaHop = a.good.find((d) => d.foundVia === 'hop');
  const viaFallback = a.good.find((d) => d.foundVia === 'fallback');
  // A document the fallback found at the URL of a working link was found by that link.
  const linked = (d: DocumentRecord) =>
    a.allHrefs.some((h) => pageKey(h) === pageKey(d.url) || pageKey(h) === pageKey(d.finalUrl));
  const viaLink = a.good.find(foundByLink) ?? (viaFallback && linked(viaFallback) ? viaFallback : undefined);

  if (viaLink) {
    judgeFoundByLink(a, viaLink, emit);
  } else if (viaHop || viaFallback) {
    judgeFoundIndirectly(
      kind,
      a,
      (viaHop ?? viaFallback) as DocumentRecord,
      !viaHop,
      emit,
      verdicts.limitations,
    );
  } else {
    judgeNoDocument(kind, a, env, emit, verdicts);
  }
}

/**
 * A banner that covers the footer and offers no legal link itself. The overlap is certain with a `high` own adapter or
 * a measured covered footer link (`coveredFooterLinks`); otherwise it rests on a heuristic candidate's geometry.
 */
function bannerCoverObservations(cmp: CmpSection, lex: LegalLexicon, pageTotal: number): Observation[] {
  const cover = allCmpFacts(cmp).find(
    (f) => f.firstLayer.bannerVisible && f.firstLayer.coversFooter === true,
  );
  if (!cover) return [];

  const inBanner = cover.firstLayer.legalLinks ?? [];
  const certain =
    (cover.detection.method === 'adapter' && cover.detection.recognitionConfidence === 'high') ||
    (cover.firstLayer.coveredFooterLinks?.length ?? 0) > 0;

  const observations: Observation[] = [];
  for (const kind of KINDS) {
    const has = matchLegalLinks(
      lex,
      kind,
      inBanner.map((l) => ({ input: linkInput(l), page: l.href ? pageKey(l.href) : '' })),
    ).some((m) => m !== null);
    if (has) continue;

    observations.push({
      checkId: ID,
      variant: 'footer-covered-by-banner',
      confidence: certain ? 'high' : 'medium',
      subject: subjects.document(kind),
      phases: [cover.phase],
      pages: [cover.pageUrl],
      evidence: [
        {
          type: 'cmp',
          cmpId: cover.detection.cmpId,
          recognitionConfidence: cover.detection.recognitionConfidence,
          phase: cover.phase,
          page: cover.pageUrl,
        },
      ],
      params: { documentKind: kind, pageTotal, missingCount: 0, foundVia: null, reachableViaHop: null },
    });
  }
  return observations;
}

export const legal01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'documents', 'cmp'],
  data: ['legal'],
  variants: [
    { variant: 'document-not-found', variantGroup: 'reachability' },
    { variant: 'links-broken', variantGroup: 'reachability' },
    { variant: 'link-missing-on-some-pages', variantGroup: 'reachability' },
    { variant: 'reachable-via-intermediate', variantGroup: 'reachability', maxConfidence: 'medium' },
    { variant: 'unresolved', variantGroup: 'reachability' },
    { variant: 'footer-covered-by-banner', variantGroup: 'banner-overlap' },
  ],
  run({ browser, documents, cmp }, ctx) {
    const lex = legalLexiconFromData(ctx.data.legal);
    const { env, coverage } = buildEnv(lex, browser, documents);
    if (env.evaluated.length === 0)
      return { status: 'inconclusive', reason: 'no-evaluable-pages', observations: [], coverage };

    const verdicts: Verdicts = { observations: [], limitations: [], blockedKinds: 0 };
    for (const kind of KINDS) judgeKind(kind, env, verdicts);
    verdicts.observations.push(...bannerCoverObservations(cmp, lex, env.evaluated.length));

    const { observations, limitations } = verdicts;
    if (verdicts.blockedKinds === KINDS.length) {
      return {
        status: 'inconclusive',
        reason: 'legal-targets-not-evaluable',
        observations,
        limitations,
        coverage,
      };
    }
    return { status: limitations.length > 0 ? 'partial' : 'completed', observations, limitations, coverage };
  },
});
