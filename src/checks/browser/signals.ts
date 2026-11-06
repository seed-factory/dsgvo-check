/** What a check reads as a consent-relevant signal: persistent identifiers, CMP facts, bot and geo signals. */
import type {
  BannerCandidateFact,
  BotSignal,
  CmpFacts,
  CmpPhaseFacts,
  CmpSection,
  ConsentStateFact,
  GeoSignal,
} from '../../cmp/types.ts';
import type { BrowserPhase, CheckOutcome, EvidenceInput, Phase } from '../../core/api.ts';
import type { BrowserSection, PageVisit } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest } from '../../derive/types.ts';
import { sortedUniq } from './lists.ts';
import { phaseRecord, startPageUrl } from './snapshot.ts';

/**
 * A hit carries a persistent identifier: stored tracking data or a user/click id holds even under Consent Mode
 * `denied`; a catalog identifier param counts only when the hit is not a denied (cookieless) ping.
 */
export function persistentIdentifier(c: ClassifiedRequest): boolean {
  const kind = c.identifierKind ?? 'none';
  if (kind === 'stored-match' || kind === 'sent-cookie' || kind === 'user-supplied') return true;
  return kind === 'persistent-param' && c.cookieless !== true;
}

export function allCmpFacts(cmp: CmpSection): CmpFacts[] {
  return cmp.phases.flatMap((p) => p.facts);
}

/**
 * The facts when they lie on the start page or on at least `minPages` pages (`cmp.minCandidatePages` of the settings),
 * else none: a banner shows on every page of phase A until it is answered, on one subpage only it is part of that page.
 */
function onBannerPages(facts: CmpFacts[], start: string | null, minPages: number): CmpFacts[] {
  const pages = new Set(facts.map((f) => f.pageUrl));
  return (start !== null && pages.has(start)) || pages.size >= minPages ? facts : [];
}

/**
 * Facts that found a consent banner, visible or not: a CMP an adapter recognised on any page, a banner the heuristic
 * took (or a consent iframe it could not read) by the page rule of `onBannerPages`.
 */
export function bannerFacts(cmp: CmpSection, browser: BrowserSection, minPages: number): CmpFacts[] {
  const found = allCmpFacts(cmp).filter((f) => f.detection.method !== 'none' || f.firstLayer.bannerPresent);
  if (found.some((f) => f.detection.method !== 'heuristic')) return found;
  return onBannerPages(found, startPageUrl(browser), minPages);
}

/** A consent banner was found (`bannerFacts`). */
export function bannerFound(cmp: CmpSection, browser: BrowserSection, minPages: number): boolean {
  return bannerFacts(cmp, browser, minPages).length > 0;
}

/**
 * A dismissed candidate that looks like a banner: not header or footer chrome, and a banner name, an accept or reject,
 * cookie wording with a settings or save control, or cookie wording and two keywords in a fixed box or a dialog whose
 * controls the lexicon cannot read (buttons without a role, names that are text blobs). A settings phrase such as
 * "Details" or "Mehr Informationen" next to privacy wording alone is a chat widget or a newsletter box; with only other
 * controls a sticky menu.
 */
const bannerLike = (c: BannerCandidateFact): boolean =>
  c.reason !== 'page-section' &&
  (c.named ||
    c.controls.includes('accept') ||
    c.controls.includes('reject') ||
    (c.cookieWording && c.controls.some((k) => k !== 'other')) ||
    (c.cookieWording && c.keywordHits >= 2 && (c.fixed || c.dialog)));

/** Facts with a banner-like candidate of the heuristic, by the page rule of `onBannerPages`. */
function candidateFacts(cmp: CmpSection, start: string | null, minPages: number): CmpFacts[] {
  const facts = allCmpFacts(cmp).filter(
    (f) => f.firstLayer.bannerCandidate && bannerLike(f.firstLayer.bannerCandidate),
  );
  return onBannerPages(facts, start, minPages);
}

/**
 * Snapshots written before the candidate fact: the same visible link inside a banner-named container (as the DOM
 * collector names it) on two pages of phase A. A table of contents or a menu with such a name sits on one page, but the
 * collector also names component wrappers (`cmp-navigation`) like banners, so these pages leave the banner undetermined.
 */
function bannerLinkPages(browser: BrowserSection, minPages: number): string[] {
  const pagesByLink = new Map<string, Set<string>>();
  for (const page of phaseRecord(browser, 'A')?.pages ?? []) {
    for (const link of page.dom?.links ?? []) {
      if (link.region !== 'banner' || !link.visible) continue;
      const key = `${link.href ?? ''}\n${link.text}`;
      const pages = pagesByLink.get(key) ?? new Set<string>();
      pages.add(page.finalUrl || page.url);
      pagesByLink.set(key, pages);
    }
  }
  const shared = [...pagesByLink.values()].filter((pages) => pages.size >= minPages);
  return [...new Set(shared.flatMap((pages) => [...pages]))].sort();
}

/** Where a banner was observed but not recognised; null when it was found or not observed at all. */
export interface UnrecognizedBanner {
  /** Facts of the pages with the banner-like candidate of the heuristic. */
  facts: CmpFacts[];
  pages: string[];
}

/** No fact found a banner, yet one was observed: a banner-like candidate the heuristic dismissed. */
export function unrecognizedBanner(
  cmp: CmpSection,
  browser: BrowserSection,
  minPages: number,
): UnrecognizedBanner | null {
  const all = allCmpFacts(cmp);
  if (all.length === 0 || bannerFound(cmp, browser, minPages)) return null;

  const facts = candidateFacts(cmp, startPageUrl(browser), minPages);
  return facts.length > 0 ? { facts, pages: sortedUniq(facts.map((f) => f.pageUrl)) } : null;
}

/**
 * Whether a snapshot without the candidate fact on any page can neither confirm nor rule out a banner: no fact found
 * one, and the same visible banner link shows on two pages of phase A. Such a link may be a banner's or a menu's, so
 * "no banner" is no fact, and neither is "banner observed".
 */
export function bannerUndetermined(cmp: CmpSection, browser: BrowserSection, minPages: number): boolean {
  const all = allCmpFacts(cmp);
  if (all.length === 0 || bannerFound(cmp, browser, minPages)) return false;
  if (all.some((f) => f.firstLayer.bannerCandidate !== undefined)) return false;
  return bannerLinkPages(browser, minPages).length > 0;
}

/**
 * The `bannerFound` param of texts before an interaction. Found or not stay booleans, so a stored report renders as
 * before; `unrecognized` is a banner observed but not recognised; `other` in their selects is the mixed case and the
 * banner that was not evaluated (`not-observed`) or could not be determined (`undetermined`).
 */
export type BannerState = boolean | 'not-observed' | 'unrecognized' | 'undetermined';

/**
 * Texts that speak of "the interaction with the banner" need a banner, and say that none was found only when CMP
 * facts were recorded and nothing looked like one. Without any facts (extraction failed or timed out on every page)
 * the banner was not evaluated, as CONSENT-03 and CONSENT-04 report it inconclusive then.
 */
export function bannerState(cmp: CmpSection, browser: BrowserSection, minPages: number): BannerState {
  if (allCmpFacts(cmp).length === 0) return 'not-observed';
  if (bannerFound(cmp, browser, minPages)) return true;
  if (unrecognizedBanner(cmp, browser, minPages)) return 'unrecognized';
  return bannerUndetermined(cmp, browser, minPages) ? 'undetermined' : false;
}

export interface ConsentSignals {
  bot: BotSignal[];
  geo: GeoSignal[];
}

/** Direct bot and geo signals reported by CMP adapters in the given phases. */
export function consentSignals(cmp: CmpSection, phases: readonly BrowserPhase[]): ConsentSignals {
  const bot: BotSignal[] = [];
  const geo: GeoSignal[] = [];
  for (const p of cmp.phases) {
    if (!phases.includes(p.phase)) continue;
    for (const f of p.facts) {
      bot.push(...f.botSignals);
      geo.push(...f.geoSignals);
    }
  }
  return { bot, geo };
}

/** A direct bot or geo signal makes the consent evaluation inconclusive; null when there is none. */
export function signalOutcome(checkId: string, s: ConsentSignals): CheckOutcome | null {
  if (s.bot.length > 0) {
    return {
      status: 'inconclusive',
      reason: 'bot-mode',
      observations: [],
      diagnostics: [
        { code: 'SCAN-BOTMODE', affects: [checkId], params: { signal: s.bot[0]?.signal ?? null } },
      ],
    };
  }
  if (s.geo.length > 0) {
    return {
      status: 'inconclusive',
      reason: 'geo',
      observations: [],
      diagnostics: [{ code: 'SCAN-GEO', affects: [checkId], params: { signal: s.geo[0]?.signal ?? null } }],
    };
  }
  return null;
}

/**
 * The CMP's dialog was in the page but not opened for the scanner: the first screen of phase B, measured after the
 * wait for the banner, says so (`dialogNotOpened`) and nothing was clicked. Facts of phase A are taken without that
 * wait and do not count. Neither the reject nor what a visitor sees is known then.
 */
function dialogNotOpened(cmp: CmpSection): boolean {
  const b = cmp.phases.find((p) => p.phase === 'B');
  if (!b || b.click?.clicked) return false;
  return b.facts.some((f) => f.moment === 'first-screen' && f.firstLayer.dialogNotOpened === true);
}

/** `dialogNotOpened` as the outcome of a consent check: inconclusive, with no observation. */
export function dialogNotOpenedOutcome(cmp: CmpSection): CheckOutcome | null {
  return dialogNotOpened(cmp)
    ? { status: 'inconclusive', reason: 'cmp-dialog-not-opened', observations: [] }
    : null;
}

const decisionRecorded = (s: ConsentStateFact) => s.decision?.responded !== false;

/**
 * The ready states proving a reject: produced by our click and read back after the reload. A reject is confirmed by
 * CMP state only, never by network silence; null when phase B holds no such pair.
 */
export function confirmedReject(
  b: CmpPhaseFacts | undefined,
): { action: ConsentStateFact; stored: ConsentStateFact } | null {
  const v = b?.verify;
  if (v?.action !== 'reject' || !v.verified || v.persistedAfterReload !== true) return null;
  const ready = (s: ConsentStateFact) => s.ready === 'ready' && decisionRecorded(s);
  const action = v.stateAfter.find((s) => ready(s) && s.origin === 'action');
  const afterReload = (b?.facts ?? []).filter((f) => f.moment === 'after-reload').flatMap((f) => f.state);
  const stored = [...v.stateAfter, ...afterReload].find((s) => ready(s) && s.origin === 'stored');
  return action && stored ? { action, stored } : null;
}

/** `consent-state` evidence of a state of phase B, the proof of a confirmed reject. */
export function stateEvidence(s: ConsentStateFact, page: string | null): EvidenceInput {
  return {
    type: 'consent-state',
    source: s.source,
    ready: s.ready,
    categories: s.categories,
    origin: s.origin,
    phase: 'B',
    ...(page ? { page } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
  };
}

/** Moments a consent phase records after its click; its first screen shows the banner before the click by design. */
const AFTER_CLICK_MOMENTS: ReadonlySet<CmpFacts['moment']> = new Set([
  'after-click',
  'after-reload',
  'control-page',
  'phase-end',
]);

/**
 * Whether the decision of the phase's click is in effect on a page, by the CMP facts recorded there after the click:
 * not when the latest of them shows the banner again or a CMP state without an answer, as happens when the consent
 * cookie is bound to the host of the click page and the page lies on another host. The latest fact decides because a
 * banner may still be closing right after the click. A page without such facts is not contradicted. The adapters say
 * "no answer" from the missing consent cookie even while the CMP is still loading, and `unknown` when they cannot
 * tell, so only an explicit `false` counts.
 *
 * `pageFacts`: the facts recorded on one page, in the order of the snapshot.
 */
export function decisionInEffect(pageFacts: readonly CmpFacts[], phase: BrowserPhase): boolean {
  const latest = pageFacts.filter((f) => f.phase === phase && AFTER_CLICK_MOMENTS.has(f.moment)).at(-1);
  if (!latest) return true;
  if (latest.firstLayer.bannerVisible) return false;
  return !latest.state.some((s) => s.decision?.responded === false);
}

/** A control page of a consent phase: neither its start page nor the reload of it. */
const controlVisit = (p: PageVisit) => !p.reload && (p.role !== 'start' || p.order > 0);

/**
 * The control pages of a consent phase where the decision of its click is not in effect (`decisionInEffect`), by final
 * URL, sorted. The start page is never among them: in phase B its reload proves the reject itself (`confirmedReject`),
 * and in phase C its banner may still be closing when the facts after the click are read.
 */
export function pagesWithoutDecision(browser: BrowserSection, cmp: CmpSection, phase: 'B' | 'C'): string[] {
  const pages = phaseRecord(browser, phase)?.pages ?? [];
  const url = (p: PageVisit) => p.finalUrl || p.url;
  const start = new Set(pages.filter((p) => !controlVisit(p)).map(url));
  const facts = cmp.phases.find((p) => p.phase === phase)?.facts ?? [];
  return sortedUniq(pages.filter(controlVisit).map(url)).filter(
    (u) =>
      !start.has(u) &&
      !decisionInEffect(
        facts.filter((f) => f.pageUrl === u),
        phase,
      ),
  );
}

/** Limitation of a check that leaves out the pages of `pagesWithoutDecision`, by the phase whose click they lack. */
export const DECISION_NOT_IN_EFFECT = { B: 'reject-not-in-effect', C: 'accept-not-in-effect' } as const;

/**
 * The pages of phases B and C without the decision of their click: `excludes` tells whether a request, cookie or
 * storage entry of a phase was recorded on one of them, `limitations` names the phases with such pages.
 */
export function withoutDecision(browser: BrowserSection, cmp: CmpSection) {
  const pages = {
    B: new Set(pagesWithoutDecision(browser, cmp, 'B')),
    C: new Set(pagesWithoutDecision(browser, cmp, 'C')),
  };
  return {
    excludes: (phase: Phase, pageUrl: string): boolean =>
      (phase === 'B' || phase === 'C') && pages[phase].has(pageUrl),
    limitations: (phases: readonly ('B' | 'C')[]): string[] =>
      sortedUniq(phases.filter((p) => pages[p].size > 0).map((p) => DECISION_NOT_IN_EFFECT[p])),
  };
}
