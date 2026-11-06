/** What a check reads as a consent-relevant signal: persistent identifiers, CMP facts, bot and geo signals. */
import type { BannerCandidateFact, BotSignal, CmpFacts, CmpSection, GeoSignal } from '../../cmp/types.ts';
import type { BrowserPhase, CheckOutcome } from '../../core/api.ts';
import type { BrowserSection } from '../../core/snapshot/browser.ts';
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
