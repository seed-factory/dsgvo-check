/**
 * LEGAL-01 (P0): Impressum and Datenschutzerklärung reachable from the evaluated pages.
 * Per document kind one reachability verdict: not found by link, intermediate hop or fallback (critical); all
 * links lead to 4xx/soft-404 (critical); missing link on some pages (warning); found only via hop/fallback
 * (warning, medium – BGH I ZR 228/03 two clicks); `#`/`javascript:` link without resolved content (info).
 * Separately: footer covered by the banner without legal links in it (warning). Pages behind a challenge stay
 * in the denominator; blocked legal targets make the verdict for that kind inconclusive.
 *
 * Labels come from the shared lexicon test/data/legal; `links-broken` needs every link of the kind
 * to be confirmed broken, a link counts as working when its URL is a successful document; an interrupted
 * search is a limitation, not `document-not-found`; a page whose type is not confirmed is a limitation;
 * soft-404 probes are no checked pages; a blocked target comes before `unresolved`; a truncated link
 * list proves no missing link; hidden CMP vendor links are no links of the site.
 */
import {
  isUnconfirmedDocument,
  type LegalLexicon,
  legalLexiconFromData,
  matchLegalLinks,
  matchNav,
  pageKey,
  pathOfUrl,
} from '../../collectors/browser/legal-lexicon.ts';
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type {
  DocumentKind,
  DocumentRecord,
  DocumentsSection,
  LinkFact,
  PageVisit,
} from '../../core/snapshot-browser.ts';
import {
  allCmpFacts,
  pageEvidence,
  phaseRecord,
  sortedUniq,
  usableDocument,
  visitedPages,
} from './shared.ts';

const ID = 'LEGAL-01';
const KINDS: readonly DocumentKind[] = ['impressum', 'privacy'];

function linkInput(l: { text: string; accessibleName?: string; href: string | null }) {
  return {
    text: l.text,
    ...(l.accessibleName ? { accessibleName: l.accessibleName } : {}),
    path: l.href ? pathOfUrl(l.href) : '',
  };
}

/**
 * The links of a page that point to the document `kind` of the site. A hidden link of the consent banner to another
 * registrable domain is the policy link of a CMP vendor. The target of each link identifies the page, so a weak
 * key loses against an exact label of the other kind on any link to the same page, as it does where the collector
 * chooses the document.
 */
function linksOfKind(lex: LegalLexicon, links: readonly LinkFact[], kind: DocumentKind): LinkFact[] {
  const own = links.filter((l) => !(l.region === 'banner' && !l.visible && l.sameSite === false));
  const found = matchLegalLinks(
    lex,
    kind,
    own.map((l) => ({
      input: linkInput(l),
      page: l.href !== null && (l.hrefKind === 'http' || l.hrefKind === 'https') ? pageKey(l.href) : '',
    })),
  );
  return own.filter((_, i) => found[i] !== null);
}

const UNRESOLVED_HREFS = new Set(['fragment', 'javascript', 'empty']);

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

/** The link list of this page was cut at the collector's limit: no link on it proves nothing. */
function linksTruncated(p: PageVisit): boolean {
  return p.dom?.linksTruncated === true;
}

type Attempt = DocumentsSection['attempts'][number];

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
    const pages = visitedPages(browser, ['A', 'B']).filter((p) => !p.reload);
    // A probe of the fallback or hop step that the collector judged an error page or not the document is not a
    // checked page of the site; it stays in the observed coverage.
    const unjudged = new Set(
      documents.attempts
        .filter((a) => a.outcome === 'soft-404' || a.outcome === 'unconfirmed')
        .map((a) => pageKey(a.url)),
    );
    // The same holds for the page behind a legal link that the collector judged an error page: its visit carries the
    // role of the document kind, but it is no page of the site for the other kind. A page that is merely
    // unconfirmed is substantive and stays.
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
    if (evaluated.length === 0)
      return { status: 'inconclusive', reason: 'no-evaluable-pages', observations: [], coverage };

    const phaseA = phaseRecord(browser, 'A');
    const searchStopped = phaseA?.status === 'partial';
    const startLinks = evaluated.filter((p) => p.role === 'start').flatMap((p) => p.dom?.links ?? []);
    // An intermediate page that the collector could have visited: a same-site contact/rechtliches/über-uns link.
    const hopCandidates = startLinks.some(
      (l) =>
        (l.hrefKind === 'http' || l.hrefKind === 'https') &&
        l.sameSite !== false &&
        (matchNav(lex.contact, linkInput(l)) !== null || matchNav(lex.hop, linkInput(l)) !== null),
    );
    const hopVisited = pages.some((p) => p.role === 'contact' || p.role === 'legal-hop');

    const observations: Observation[] = [];
    const limitations: string[] = [];
    let blockedKinds = 0;
    // A target behind a challenge or a failed navigation proves nothing about the document.
    const blockedKeys = new Set(
      pages.filter(isBlockedPage).flatMap((p) => [pageKey(p.url), pageKey(p.finalUrl || p.url)]),
    );

    for (const kind of KINDS) {
      const docs = documents.documents.filter((d) => d.kind === kind);
      // A page the collector judged "not the document" (soft-404) or could not confirm as such (unconfirmed) is no
      // reachable document.
      const good = docs.filter((d) => usableDocument(d, documents.attempts));
      const attempts = documents.attempts.filter((a) => a.kind === kind);
      const keysOf = (xs: Iterable<string>) => new Set([...xs].map(pageKey));
      const goodKeys = keysOf(good.flatMap((d) => [d.url, d.finalUrl]));
      const foundKeys = keysOf(attempts.filter((a) => a.outcome === 'found').map((a) => a.url));
      const brokenKeys = keysOf(attempts.filter(provesBroken).map((a) => a.url));
      const unconfirmedAttempts = attempts.filter((a) => a.outcome === 'unconfirmed');
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

      const linkStatus = (p: PageVisit) => {
        const links = linksOfKind(lex, p.dom?.links ?? [], kind);
        const http = links.filter((l) => l.href !== null && !UNRESOLVED_HREFS.has(l.hrefKind));
        const classes = http.map((l) => classify(l.href as string));
        return {
          // A link that is neither known broken nor blocked: the page does have a link to the document.
          present: classes.some((c) => c === 'working' || c === 'unverified' || c === 'unconfirmed'),
          toBlocked: classes.includes('blocked'),
          unresolved: links.some((l) => UNRESOLVED_HREFS.has(l.hrefKind)),
          hrefs: http.map((l) => l.href as string),
        };
      };
      // The document page itself needs no link to itself.
      const status = evaluated.filter((p) => !sameDoc(p, kind, docs)).map((p) => ({ p, s: linkStatus(p) }));
      const missingAll = status.filter((x) => !x.s.present && !x.s.unresolved && !x.s.toBlocked);
      // No link on a page whose link list was cut proves nothing.
      const missingTruncated = missingAll.filter((x) => linksTruncated(x.p));
      const missing = missingAll.filter((x) => !linksTruncated(x.p));
      if (missingTruncated.length > 0) limitations.push(`${kind}-links-truncated`);
      const pageTotal = status.length - missingTruncated.length;
      const unresolvedOnly = status.filter((x) => !x.s.present && x.s.unresolved);

      const allHrefs = status.flatMap((x) => x.s.hrefs);
      // Every link of the kind is confirmed broken: one working or unchecked link is enough to say otherwise.
      const allBroken =
        allHrefs.length > 0 &&
        allHrefs.every((h) => classify(h) === 'broken') &&
        !status.some((x) => x.s.unresolved);

      const obs = (
        variant: Variant,
        confidence: Observation['confidence'],
        evidence: EvidenceInput[],
        params: Record<string, string | number | boolean | null>,
        obsPages: string[],
      ) => {
        observations.push({
          checkId: ID,
          variant,
          confidence,
          subject: subjects.document(kind),
          phases: sortedUniq(evaluated.map((p) => p.phase)) as Phase[],
          pages: obsPages,
          evidence,
          params: { documentKind: kind, pageTotal, ...params },
        });
      };
      const viaLinkRecorded = good.find((d) => d.foundVia === 'link' || d.foundVia === 'config');
      const viaHop = good.find((d) => d.foundVia === 'hop');
      const viaFallback = good.find((d) => d.foundVia === 'fallback');
      // A document the fallback found at the URL of a working link was found by that link.
      const linked = (d: DocumentRecord) =>
        allHrefs.some((h) => pageKey(h) === pageKey(d.url) || pageKey(h) === pageKey(d.finalUrl));
      const viaLink = viaLinkRecorded ?? (viaFallback && linked(viaFallback) ? viaFallback : undefined);
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
      const attemptEvidence: EvidenceInput[] = attempts
        .filter((a) => a.outcome !== 'found')
        .slice(0, 6)
        .map((a) => ({ type: 'link', href: a.url, text: `${a.via}:${a.outcome}`, status: a.status }));
      const missingPages = missing.map((x) => x.p.finalUrl || x.p.url).sort();
      // The site's own link (or hop) leads to a page that is not confirmed as the document. A fallback path
      // that serves another page is negative evidence for that path only.
      const unconfirmedLink =
        unconfirmedAttempts.some((a) => a.via !== 'fallback') ||
        docs.some((d) => d.foundVia !== 'fallback' && isUnconfirmedDocument(d, documents.attempts));
      // The target of the direct link is open: "not reachable by a direct link" cannot be said.
      const unconfirmedDirect =
        unconfirmedAttempts.some((a) => a.via === 'link') ||
        docs.some(
          (d) =>
            (d.foundVia === 'link' || d.foundVia === 'config') &&
            isUnconfirmedDocument(d, documents.attempts),
        );

      if (viaLink) {
        if (missing.length > 0) {
          obs(
            'link-missing-on-some-pages',
            'high',
            [...missing.slice(0, 6).map((x) => pageEvidence(x.p)), docEvidence(viaLink)],
            { missingCount: missing.length, foundVia: 'link', reachableViaHop: null },
            missingPages,
          );
        } else if (unresolvedOnly.length > 0) {
          obs(
            'unresolved',
            'high',
            unresolvedOnly.slice(0, 6).map((x) => pageEvidence(x.p)),
            { missingCount: unresolvedOnly.length, foundVia: 'link', reachableViaHop: null },
            unresolvedOnly.map((x) => x.p.finalUrl || x.p.url).sort(),
          );
        }
        continue;
      }
      if (viaHop || viaFallback) {
        const d = (viaHop ?? viaFallback) as DocumentRecord;
        if (!viaHop && allBroken) {
          obs(
            'links-broken',
            'high',
            [...attemptEvidence, docEvidence(d)],
            { missingCount: missing.length, foundVia: d.foundVia, reachableViaHop: false },
            missingPages,
          );
        } else if (unconfirmedDirect) {
          // A document found by the fallback or the hop does not settle a direct link that was fetched and could not
          // be confirmed: a limitation, not a warning with the statement "no direct link".
          limitations.push(`${kind}-type-unconfirmed`);
        } else if (missing.length > 0 || missingTruncated.length === 0) {
          // (Not when the only pages without a link are pages whose link list was cut: "no direct link" is open.)
          obs(
            'reachable-via-intermediate',
            'medium',
            [docEvidence(d), ...attemptEvidence],
            { missingCount: missing.length, foundVia: d.foundVia, reachableViaHop: d.foundVia === 'hop' },
            missingPages,
          );
        }
        continue;
      }
      // No reachable document.
      const unresolvedAttempt = attempts.some((a) => a.outcome === 'unresolved');
      if (allBroken && !unresolvedAttempt) {
        obs(
          'links-broken',
          'high',
          [...attemptEvidence, ...missing.slice(0, 6).map((x) => pageEvidence(x.p))],
          { missingCount: missing.length, foundVia: null, reachableViaHop: false },
          missingPages,
        );
        continue;
      }
      // A blocked target comes before every other conclusion about unchecked links.
      if (blocked) {
        blockedKinds++;
        limitations.push(`${kind}-target-not-evaluable`);
        continue;
      }
      if (unconfirmedLink) {
        limitations.push(`${kind}-type-unconfirmed`);
        continue;
      }
      // Unverified (offsite, not fetched) or `#`/JS links → unresolved, never "missing".
      const candidates = status.filter((x) => x.s.present || x.s.unresolved);
      if (candidates.length > 0 || unresolvedAttempt) {
        obs(
          'unresolved',
          'high',
          [...candidates.slice(0, 6).map((x) => pageEvidence(x.p)), ...attemptEvidence],
          { missingCount: candidates.length, foundVia: null, reachableViaHop: false },
          candidates.map((x) => x.p.finalUrl || x.p.url).sort(),
        );
        continue;
      }
      if (missing.length === 0 && missingTruncated.length > 0) continue;
      // The search must have run its steps before `critical` (03-checks §3.15 steps 5–7): the intermediate page,
      // if there was a candidate, and the usual paths. A fallback that was skipped (the time budget ended
      // between the last queued page and the fallback step, so the phase still says `completed`) counts as well.
      const fallbackChecked = attempts.some((a) => a.via === 'fallback');
      const hopChecked = attempts.some((a) => a.via === 'hop') || hopVisited;
      if (!fallbackChecked || (searchStopped && hopCandidates && !hopChecked)) {
        limitations.push(
          `${kind}-search-incomplete:${searchStopped ? (phaseA?.reason ?? 'partial') : 'fallback-skipped'}`,
        );
        continue;
      }
      obs(
        'document-not-found',
        'high',
        [...attemptEvidence, ...missing.slice(0, 6).map((x) => pageEvidence(x.p))],
        { missingCount: missing.length, foundVia: null, reachableViaHop: false, hopChecked, fallbackChecked },
        missingPages,
      );
    }

    // Banner covers the footer and offers no legal link itself (research §7.4). The overlap is certain
    // when an own adapter recognised the banner with high confidence or when the hit test measured that a concrete
    // footer link is covered (`coveredFooterLinks`); otherwise it rests on the geometry of a heuristic candidate.
    const cover = allCmpFacts(cmp).find(
      (f) => f.firstLayer.bannerVisible && f.firstLayer.coversFooter === true,
    );
    if (cover) {
      const inBanner = cover.firstLayer.legalLinks ?? [];
      const certain =
        (cover.detection.method === 'adapter' && cover.detection.recognitionConfidence === 'high') ||
        (cover.firstLayer.coveredFooterLinks?.length ?? 0) > 0;
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
          params: {
            documentKind: kind,
            pageTotal: evaluated.length,
            missingCount: 0,
            foundVia: null,
            reachableViaHop: null,
          },
        });
      }
    }

    if (blockedKinds === KINDS.length)
      return {
        status: 'inconclusive',
        reason: 'legal-targets-not-evaluable',
        observations,
        limitations,
        coverage,
      };
    return { status: limitations.length > 0 ? 'partial' : 'completed', observations, limitations, coverage };
  },
});
