// Deterministic page selection and B/C control pages. Pure: input is the start page's link list (raw hrefs stay in
// memory for navigation, plans store sanitized URLs), robots.txt and sitemap entries.

import {
  type DomRegion,
  type IframeFact,
  isHttpHref,
  type LinkFact,
  type PageRole,
  type PlannedPage,
} from '../../../core/snapshot/browser.ts';
import type { SanitizedUrl } from '../../../core/snapshot/common.ts';
import { isHttpUrl, parseUrl as parse, registrableDomain } from '../../../core/url/url.ts';
import type { ServiceCatalog } from '../../../derive/catalog.ts';
import {
  type LegalKind,
  type LegalLexicon,
  type LinkInput,
  type LinkMatch,
  matchLegalLinks,
  matchNav,
  type NavMatch,
  type NavPhrase,
  pageKey,
  pathOfUrl,
} from '../legal/lexicon.ts';
import { loadLegalLexicon } from '../legal/lexicon-file.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { type LanguageRules, loadPageRules, type PageRules } from '../rules.ts';
import { type Robots, robotsAllows } from './robots.ts';

export type { LegalKind } from '../legal/lexicon.ts';
export { pageKey };

export const LEGAL_KINDS: readonly LegalKind[] = ['impressum', 'privacy'];

export interface CandidateLink {
  /** In memory only; may contain query values. */
  raw: string;
  hrefKind: LinkFact['hrefKind'];
  text: string;
  accessibleName?: string;
  region: DomRegion;
  visible: boolean;
  order: number;
  /** `hreflang` of the link, lower case; in memory only. */
  hreflang?: string;
}

export interface PageChoice {
  /** In memory only. */
  raw: string;
  url: SanitizedUrl;
  role: PageRole;
  reasons: string[];
  source: PlannedPage['source'];
  /** The keyword group that chose an extra page (`PlannedPage.keywordGroup`). */
  keywordGroup?: string;
  robotsAllowed?: boolean;
}

export interface LegalLinkResult {
  kind: LegalKind;
  /** page: navigable HTML page; pdf: document link to a PDF; unresolved: `#`/`javascript:`; offsite: other site. */
  status: 'page' | 'pdf' | 'unresolved' | 'offsite' | 'none';
  choice?: PageChoice;
  link?: CandidateLink;
  // Navigable same-site candidates in rank order, the chosen one first (page and pdf only); the collector tries the
  // next one when the chosen page is not confirmed as the document.
  candidates?: PageChoice[];
}

export interface Scope {
  startRaw: string;
  finalHost: string;
  etld1: string | null;
}

export interface SelectInput extends Scope {
  links: readonly CandidateLink[];
  /** `lang` of the start page's document, which tells the language of a link's `hreflang` apart. */
  startLang?: string;
  maxPages: number;
  robots: Robots | null;
  token: string;
  sitemapLocs: readonly string[];
}

export interface PageSelection {
  impressum: LegalLinkResult;
  privacy: LegalLinkResult;
  contact: PageChoice | null;
  /** Intermediate pages for missing legal links (≤ 3 GETs incl. contact). */
  hops: PageChoice[];
  extras: PageChoice[];
  /** Extras the budget allowed; fewer chosen → the caller may add sitemap entries. */
  extrasWanted: number;
  /** The language versions of the site as the start page shows them, for the legal links of later pages too. */
  language: LanguageContext;
}

const MAX_HOP_GETS = 3;
const MAX_ALTERNATIVES = 2;

/** Control page scoring: a replicated embed is the strongest reason, a contact page a weak one. */
const SIGNAL_SCORE = 3;
const MAX_NETWORK_SCORE = 3;
const CONTACT_ROLE_SCORE = 2;
/** Content of a catalog embed service ranks above an unknown host: it is what a site may keep loading after a reject. */
const EMBED_SCORE = 3;

const REGION_RANK: Record<DomRegion, number> = {
  footer: 0,
  nav: 1,
  header: 2,
  main: 3,
  aside: 4,
  other: 5,
  banner: 6,
};

function lower(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function pathSegments(raw: string): string[] {
  const u = parse(raw);
  if (!u) return [];
  return u.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}

/** A listed language code with an optional region in BCP 47 form (`de`, `de-at`, `en_GB`), normalized; else null. */
function localeOf(segment: string | undefined, rules: LanguageRules): string | null {
  if (segment === undefined) return null;
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}))?$/.exec(segment.toLowerCase());
  if (!m || !rules.localePrefixes.has(m[1] as string)) return null;
  return m[2] ? `${m[1]}-${m[2]}` : (m[1] as string);
}

const languageOf = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? '';

/** The start page of a scan, for telling the language versions of the site apart from its sections. */
export interface LanguageStart {
  raw: string;
  /** `lang` of the start page's document. */
  lang?: string;
}

export interface LanguageContext {
  rules: LanguageRules;
  /** Locale of the start page's first path segment (`de`, `de-at`), or null when its path has none. */
  startLocale: string | null;
  /** Language of the start page: its `lang`, else that of its locale prefix. */
  startLanguage: string | null;
  /** Locale prefixes the start page's own language switch leads to. */
  alternatePrefixes: ReadonlySet<string>;
}

export type AlternateCandidate = Pick<CandidateLink, 'raw' | 'text'> &
  Partial<Pick<CandidateLink, 'accessibleName' | 'hreflang'>>;

const labelsOf = (l: AlternateCandidate): string[] =>
  [l.text, l.accessibleName ?? ''].map(lower).filter((x) => x !== '');

export function languageContext(
  start: LanguageStart,
  links: readonly AlternateCandidate[],
  rules: LanguageRules = loadPageRules().languages,
): LanguageContext {
  const startLocale = localeOf(pathSegments(start.raw)[0], rules);
  const startLanguage = start.lang
    ? languageOf(start.lang) || null
    : startLocale
      ? languageOf(startLocale)
      : null;
  const base: LanguageContext = { rules, startLocale, startLanguage, alternatePrefixes: new Set() };

  // A start page without a locale prefix may still switch to `/en/…`: the sections behind that switch are the other
  // language as well, even where their own label does not say so.
  const prefixes = new Set<string>();
  for (const l of links) {
    const locale = localeOf(pathSegments(l.raw)[0], rules);
    if (locale !== null && locale !== startLocale && isLanguageAlternate(l, base)) prefixes.add(locale);
  }
  return { ...base, alternatePrefixes: prefixes };
}

/**
 * Another language version of the site: a link whose `hreflang` names another language than the start page (the same
 * language still leaves the prefix to decide: `/de-at/` beside `/de/`); a locale prefix other than the start page's or
 * one its language switch leads to; a bare locale root (`/en/`) without visible
 * text, such as a flag whose name is a sentence ("Switch to English"); a link labelled with a language code ("EN");
 * or one labelled with a language name ("English") that leads into a locale prefix or to the root. "IT-Service" on
 * `/it/` of a site without locale prefixes stays a section, and so does a course page "Englisch" of a language school.
 */
export function isLanguageAlternate(l: AlternateCandidate, ctx: LanguageContext): boolean {
  const hreflang = l.hreflang && l.hreflang !== 'x-default' ? languageOf(l.hreflang) : null;
  if (hreflang && ctx.startLanguage !== null && hreflang !== ctx.startLanguage) return true;

  const segments = pathSegments(l.raw);
  const locale = localeOf(segments[0], ctx.rules);
  if (locale !== null) {
    if (ctx.startLocale !== null && locale !== ctx.startLocale) return true;
    if (ctx.alternatePrefixes.has(locale)) return true;
    if (segments.length === 1 && lower(l.text) === '') return true;
  }

  const labels = labelsOf(l);
  if (labels.some((label) => localeOf(label, ctx.rules) !== null)) return true;
  const named = labels.some((label) => ctx.rules.switchLabels.has(label));
  return named && (locale !== null || segments.length === 0);
}

/** URL template of a page: its first path segment, after the locale prefix on a site whose start page has one. */
function templateOf(raw: string, lang: LanguageContext): string {
  const segments = pathSegments(raw);
  const skip = lang.startLocale !== null && localeOf(segments[0], lang.rules) !== null ? 1 : 0;
  return segments[skip] ?? '';
}

function stripWww(h: string): string {
  return h.toLowerCase().replace(/^www\./, '');
}

/** Final host plus its www/apex pair. */
export function inScope(raw: string, scope: Scope): boolean {
  const u = parse(raw);
  if (!u || !isHttpUrl(u)) return false;
  return stripWww(u.hostname) === stripWww(scope.finalHost);
}

function sameSite(raw: string, scope: Scope): boolean {
  const u = parse(raw);
  if (!u) return false;
  if (inScope(raw, scope)) return true;
  return scope.etld1 !== null && registrableDomain(u.hostname) === scope.etld1;
}

function navigable(l: CandidateLink): boolean {
  return isHttpHref(l.hrefKind);
}

function excluded(raw: string, rules: PageRules): boolean {
  const u = parse(raw);
  if (!u) return true;
  return rules.excludedPath.test(u.pathname) || (u.pathname.includes('search') && u.search !== '');
}

function isStart(raw: string, scope: Scope): boolean {
  return pageKey(raw) === pageKey(scope.startRaw);
}

/** Substring match for the extra pages (nav keywords such as "blog"): low stakes, loose matching. */
type Match = { link: CandidateLink; keyword: string; byText: boolean };

function matchKeyword(
  l: CandidateLink,
  keywords: readonly string[],
): { keyword: string; byText: boolean } | null {
  const text = lower(`${l.text} ${l.accessibleName ?? ''}`);
  const u = parse(l.raw);
  let path = '';
  if (u) {
    try {
      path = lower(decodeURIComponent(u.pathname));
    } catch {
      path = lower(u.pathname);
    }
  }

  for (const k of keywords) {
    if (text.includes(k)) return { keyword: k, byText: true };
  }
  for (const k of keywords) {
    const slug = k.replace(/ /g, '-');
    if (path.includes(slug) || path.includes(slug.replace(/ü/g, 'ue'))) return { keyword: k, byText: false };
  }
  return null;
}

function rank(a: Match, b: Match): number {
  if (a.byText !== b.byText) return a.byText ? -1 : 1;
  return compareLinks(a.link, b.link);
}

function compareLinks(a: CandidateLink, b: CandidateLink): number {
  const r = REGION_RANK[a.region] - REGION_RANK[b.region];
  if (r !== 0) return r;
  if (a.visible !== b.visible) return a.visible ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
}

function inputOf(l: CandidateLink): LinkInput {
  return {
    text: l.text,
    ...(l.accessibleName ? { accessibleName: l.accessibleName } : {}),
    path: pathOfUrl(l.raw),
  };
}

function choice(
  raw: string,
  role: PageRole,
  reasons: string[],
  source: PlannedPage['source'],
  robotsAllowed?: boolean,
  keywordGroup?: string,
): PageChoice {
  return {
    raw,
    url: sanitizeRequestUrl(raw),
    role,
    reasons,
    source,
    ...(keywordGroup !== undefined ? { keywordGroup } : {}),
    ...(robotsAllowed !== undefined ? { robotsAllowed } : {}),
  };
}

/** The plan entry of a chosen page that phase A visited as the `order`-th page. */
export function plannedPage(c: PageChoice, order: number): PlannedPage {
  return {
    url: c.url,
    role: c.role,
    order,
    reasons: c.reasons,
    source: c.source,
    ...(c.keywordGroup !== undefined ? { keywordGroup: c.keywordGroup } : {}),
    ...(c.robotsAllowed !== undefined ? { robotsAllowed: c.robotsAllowed } : {}),
  };
}

interface LegalMatch {
  link: CandidateLink;
  m: LinkMatch;
}

/** Label precision first (exact > starts with the key > key inside > href slug > generic), then the rest. */
function rankLegal(a: LegalMatch, b: LegalMatch): number {
  if (a.m.tier !== b.m.tier) return a.m.tier - b.m.tier;
  if (a.m.slug !== b.m.slug) return a.m.slug ? -1 : 1;
  return compareLinks(a.link, b.link);
}

function reasonOfLegal(x: LegalMatch): string {
  return x.m.byText ? `${x.link.region}-link:${x.m.keyword}` : `href:${x.m.keyword}`;
}

// Best link per legal kind (start page and hop pages), with the navigable same-site candidates in rank order. A hidden
// banner link to another registrable domain is the CMP vendor's policy, not the site's.
export function findLegalLink(
  links: readonly CandidateLink[],
  kind: LegalKind,
  scope: Scope,
  lexicon: LegalLexicon = loadLegalLexicon(),
): LegalLinkResult {
  const considered = links.filter((l) => !(l.region === 'banner' && !l.visible && !sameSite(l.raw, scope)));
  // The page identity lets a weak key lose against an exact label of the other kind on another link to the same URL.
  const found = matchLegalLinks(
    lexicon,
    kind,
    considered.map((l) => ({ input: inputOf(l), page: navigable(l) ? pageKey(l.raw) : '' })),
  );
  const matches: LegalMatch[] = [];
  considered.forEach((l, i) => {
    const m = found[i];
    if (m) matches.push({ link: l, m });
  });
  if (matches.length === 0) return { kind, status: 'none' };
  matches.sort(rankLegal);

  const usable = usableLegalMatches(matches, scope);
  const first = usable[0];
  if (first) {
    const alternatives = usable.slice(1, 1 + MAX_ALTERNATIVES).map((x) => `alt:${reasonOfLegal(x)}`);
    const pdf = /\.pdf$/i.test(parse(first.link.raw)?.pathname ?? '');
    const candidates = usable.map((x, i) =>
      choice(x.link.raw, kind, i === 0 ? [reasonOfLegal(x), ...alternatives] : [reasonOfLegal(x)], 'link'),
    );
    return {
      kind,
      status: pdf ? 'pdf' : 'page',
      choice: candidates[0] as PageChoice,
      link: first.link,
      candidates,
    };
  }

  // Fall back to the best non-navigable or off-site link for the record.
  const best = matches[0] as LegalMatch;
  if (navigable(best.link)) return { kind, status: 'offsite', link: best.link };
  return { kind, status: 'unresolved', link: best.link };
}

/** Navigable same-site matches in rank order, one per page. */
function usableLegalMatches(matches: readonly LegalMatch[], scope: Scope): LegalMatch[] {
  const usable: LegalMatch[] = [];
  const seen = new Set<string>();
  for (const x of matches) {
    if (!navigable(x.link) || !sameSite(x.link.raw, scope)) continue;
    const key = pageKey(x.link.raw);
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(x);
  }
  return usable;
}

interface NavPick {
  link: CandidateLink;
  m: NavMatch;
}

function bestNav(
  links: readonly CandidateLink[],
  phrases: readonly NavPhrase[],
  accept: (l: CandidateLink) => boolean,
): NavPick | null {
  const picks: NavPick[] = [];
  for (const l of links) {
    if (!accept(l)) continue;
    const m = matchNav(phrases, inputOf(l));
    if (m) picks.push({ link: l, m });
  }
  picks.sort((a, b) => (a.m.tier !== b.m.tier ? a.m.tier - b.m.tier : compareLinks(a.link, b.link)));
  return picks[0] ?? null;
}

function reasonOfNav(x: NavPick): string {
  return x.m.byText ? `${x.link.region}-link:${x.m.keyword}` : `href:${x.m.keyword}`;
}

/** Pages and URL templates already chosen: no page twice; the fallbacks without a keyword take one page per template. */
interface Chosen {
  used: Set<string>;
  templates: Set<string>;
  template: (raw: string) => string;
}

function take(chosen: Chosen, raw: string): void {
  chosen.used.add(pageKey(raw));
  chosen.templates.add(chosen.template(raw));
}

export function selectPages(
  i: SelectInput,
  lexicon: LegalLexicon = loadLegalLexicon(),
  rules: PageRules = loadPageRules(),
): PageSelection {
  const lang = languageContext(
    { raw: i.startRaw, ...(i.startLang ? { lang: i.startLang } : {}) },
    i.links.filter((l) => navigable(l) && inScope(l.raw, i)),
    rules.languages,
  );
  const template = (raw: string) => templateOf(raw, lang);
  const chosen: Chosen = {
    used: new Set([pageKey(i.startRaw)]),
    templates: new Set([template(i.startRaw)]),
    template,
  };
  const candidate = (l: CandidateLink) =>
    navigable(l) &&
    inScope(l.raw, i) &&
    !isStart(l.raw, i) &&
    !chosen.used.has(pageKey(l.raw)) &&
    !rules.file.test(parse(l.raw)?.pathname ?? '') &&
    !excluded(l.raw, rules);

  const impressum = findLegalLink(i.links, 'impressum', i, lexicon);
  const privacy = findLegalLink(i.links, 'privacy', i, lexicon);
  for (const r of [impressum, privacy]) if (r.status === 'page' && r.choice) take(chosen, r.choice.raw);

  const c = bestNav(i.links, lexicon.contact, candidate);
  const contact = c ? choice(c.link.raw, 'contact', [reasonOfNav(c)], 'link') : null;
  if (contact) take(chosen, contact.raw);

  const legalMissing = [impressum, privacy].some((r) => r.status === 'none' || r.status === 'unresolved');
  const hops = legalMissing ? pickHops(i, lexicon, MAX_HOP_GETS - (contact ? 1 : 0), chosen, candidate) : [];

  // The extras get what --max-pages leaves after the pages every scan visits: the start, contact and hop pages, and per
  // legal kind its linked page or, without one, the probe of its conventional path. A PDF link is read without a visit.
  const legalVisits = [impressum, privacy].filter((r) => r.status !== 'pdf').length;
  const fixed = 1 + legalVisits + (contact ? 1 : 0) + hops.length;
  const need = Math.max(0, i.maxPages - fixed);
  const extras = pickExtras(i, rules, need, chosen, candidate, (l) => isLanguageAlternate(l, lang));

  return { impressum, privacy, contact, hops, extras, extrasWanted: need, language: lang };
}

/** Where a site links its legal notices: the page chrome, or a page without landmarks. Not an article or a box. */
const NOTICE_REGIONS: ReadonlySet<DomRegion> = new Set(['footer', 'nav', 'header', 'other']);
/** Labels that are a privacy label or start with a privacy key ("Datenschutz Kurse", "Datenschutzhinweise für …"). */
const NOTICE_MAX_TIER = 1;

export interface SupplementOptions {
  /** Language versions of the site, as the start page shows them. */
  language: LanguageContext;
  /** Further notices to choose at most; 0 chooses none and notes no language version. */
  max: number;
  /** Pages the caller has read or tried already: the policy, its final URL, candidates that were not the policy. */
  skip: (key: string) => boolean;
}

export interface SupplementSelection {
  /** Further privacy notices of the site to read, best-ranked first. */
  notices: PageChoice[];
  /** Language versions of the policy among the privacy links: noted, never visited. */
  languages: PageChoice[];
}

/**
 * Further privacy notices among the privacy links of the page the policy was found from, in the rank of
 * `findLegalLink`: same site, navigable, past the settings words, labelled as a notice and linked from the page chrome,
 * so an article about data protection is no notice of the site. A page that one of its links marks as another language
 * version is noted instead, whatever its rank.
 */
export function privacySupplements(
  links: readonly CandidateLink[],
  scope: Scope,
  o: SupplementOptions,
  lexicon: LegalLexicon = loadLegalLexicon(),
): SupplementSelection {
  const out: SupplementSelection = { notices: [], languages: [] };
  if (o.max <= 0) return out;

  const considered = links.filter((l) => !(l.region === 'banner' && !l.visible && !sameSite(l.raw, scope)));
  const found = matchLegalLinks(
    lexicon,
    'privacy',
    considered.map((l) => ({ input: inputOf(l), page: navigable(l) ? pageKey(l.raw) : '' })),
  );
  const matches: LegalMatch[] = [];
  considered.forEach((l, i) => {
    const m = found[i];
    if (m) matches.push({ link: l, m });
  });
  matches.sort(rankLegal);

  const alternateKeys = new Set(
    links.filter((l) => navigable(l) && isLanguageAlternate(l, o.language)).map((l) => pageKey(l.raw)),
  );
  for (const x of usableLegalMatches(matches, scope)) {
    const key = pageKey(x.link.raw);
    if (o.skip(key)) continue;
    if (alternateKeys.has(key)) {
      out.languages.push(choice(x.link.raw, 'privacy', [reasonOfLegal(x), 'language-version'], 'link'));
    } else if (
      out.notices.length < o.max &&
      x.m.byText &&
      x.m.tier <= NOTICE_MAX_TIER &&
      NOTICE_REGIONS.has(x.link.region)
    ) {
      out.notices.push(choice(x.link.raw, 'privacy', [reasonOfLegal(x), 'supplement'], 'link'));
    }
  }
  return out;
}

/** Intermediate pages that may lead to the missing legal links, one per hop keyword up to `budget`. */
function pickHops(
  i: SelectInput,
  lexicon: LegalLexicon,
  budget: number,
  chosen: Chosen,
  candidate: (l: CandidateLink) => boolean,
): PageChoice[] {
  const hops: PageChoice[] = [];
  for (const k of lexicon.hop) {
    if (hops.length >= budget) break;
    const m = bestNav(i.links, [k], candidate);
    if (!m) continue;
    hops.push(choice(m.link.raw, 'legal-hop', [`hop:${m.m.keyword}`], 'hop'));
    take(chosen, m.link.raw);
  }
  return hops;
}

/**
 * Up to `need` extra pages: one page per keyword group first, then navigation links, then sitemap entries. Language
 * versions of the site are never extras.
 */
function pickExtras(
  i: SelectInput,
  rules: PageRules,
  need: number,
  chosen: Chosen,
  candidate: (l: CandidateLink) => boolean,
  alternate: (l: AlternateCandidate) => boolean,
): PageChoice[] {
  // A page is a language version wherever one of its links says so: its sitemap entry and its other links may carry
  // no `hreflang` or label of their own.
  const alternateKeys = new Set(
    i.links.filter((l) => navigable(l) && alternate(l)).map((l) => pageKey(l.raw)),
  );
  const isAlternate = (l: AlternateCandidate) => alternateKeys.has(pageKey(l.raw)) || alternate(l);

  const extras: PageChoice[] = [];
  const allowed = (raw: string): boolean | undefined => {
    if (!i.robots) return undefined;
    const u = parse(raw);
    return u ? robotsAllows(i.robots, `${u.pathname}${u.search}`, i.token) : false;
  };
  const tryExtra = (
    raw: string,
    reasons: string[],
    source: PlannedPage['source'],
    perTemplate: boolean,
    keywordGroup?: string,
  ): boolean => {
    if (extras.length >= need || chosen.used.has(pageKey(raw))) return false;
    if (perTemplate && chosen.templates.has(chosen.template(raw))) return false;
    const robotsAllowed = allowed(raw);
    if (robotsAllowed === false) return false;
    const role = source === 'sitemap' ? 'other' : 'nav';
    extras.push(choice(raw, role, reasons, source, robotsAllowed, keywordGroup));
    take(chosen, raw);
    return true;
  };

  // A group names a kind of page, not a section: `/unternehmen/geschichte` and `/unternehmen/team` are both worth a
  // visit, `/blog/a` and `/news/b` are one kind. The plan keeps the group's id beside the word that matched, so a
  // check can tell a kind of page by the id whatever the words of the group are.
  for (const group of rules.extraGroups) {
    if (extras.length >= need) break;
    const ms: Match[] = [];
    for (const l of i.links) {
      if (!candidate(l) || isAlternate(l)) continue;
      const m = matchKeyword(l, group.words);
      if (m) ms.push({ link: l, ...m });
    }
    for (const m of ms.sort(rank)) {
      if (tryExtra(m.link.raw, [`keyword:${m.keyword}`], 'link', false, group.id)) break;
    }
  }

  const navLinks = i.links
    .filter((l) => (l.region === 'nav' || l.region === 'header') && candidate(l) && !isAlternate(l))
    .sort((a, b) => a.order - b.order);
  for (const l of navLinks) tryExtra(l.raw, ['nav-link'], 'link', true);

  for (const loc of i.sitemapLocs) {
    if (
      inScope(loc, i) &&
      !isStart(loc, i) &&
      !rules.file.test(parse(loc)?.pathname ?? '') &&
      !excluded(loc, rules) &&
      !isAlternate({ raw: loc, text: '' })
    ) {
      tryExtra(loc, ['sitemap'], 'sitemap', true);
    }
  }
  return extras;
}

export interface ControlSignals {
  thirdPartyIframes: number;
  placeholders: number;
  newThirdPartyHosts: number;
  /** Catalog embed categories (maps, video, fonts, widget) among the counted frames and new hosts. */
  embeds: number;
}

export interface ControlCandidate {
  raw: string;
  url: SanitizedUrl;
  /** The page as phase A showed it, after redirects: its origin is compared with that of the click page. */
  finalUrl?: SanitizedUrl;
  role: PageRole;
  order: number;
  signals: ControlSignals;
}

export interface ControlChoice extends ControlCandidate {
  reasons: string[];
}

/** What phase A saw on a page and on the start page, for the control-page signals. */
export interface ControlFacts {
  iframes: ReadonlyArray<Pick<IframeFact, 'src' | 'box' | 'depth'>>;
  placeholders: number;
  requests: ReadonlyArray<{ url: string; host: string }>;
  startRequests: ReadonlyArray<{ url: string; host: string }>;
}

/** Catalog category of a request URL, or null for an unknown host. */
export type CategoryOf = (url: string) => string | null;

export function catalogCategoryOf(catalog: Pick<ServiceCatalog, 'matchUrl'>): CategoryOf {
  return (url) => {
    const u = parse(url);
    return u ? (catalog.matchUrl(u)?.service.category ?? null) : null;
  };
}

/** Embedded content a site may keep loading after a reject: a page with it is worth a revisit. */
const EMBED_CATEGORIES: ReadonlySet<string> = new Set(['maps', 'video', 'fonts', 'widget']);
/** A CMP's frames and hosts are on every page of the site and say nothing about one of them. */
const CONSENT_PROVIDER = 'consent-provider';

/** A box entirely above or left of the document is a hidden helper frame (a CMP's 4x4 frame at -9999 px). */
function offPage(box: IframeFact['box']): boolean {
  return box != null && (box.y + box.height <= 0 || box.x + box.width <= 0);
}

/** Control-page signals of one phase-A page: third-party frames, placeholders, hosts new against the start page. */
export function controlSignals(
  f: ControlFacts,
  etld1: string | null,
  categoryOf: CategoryOf,
): ControlSignals {
  const thirdParty = (host: string) => registrableDomain(host) !== etld1;
  const frames = f.iframes.filter((frame) => {
    if (frame.depth !== 1 || !frame.src || offPage(frame.box)) return false;
    const host = parse(frame.src)?.hostname;
    return host !== undefined && thirdParty(host) && categoryOf(frame.src) !== CONSENT_PROVIDER;
  });
  const startHosts = new Set(f.startRequests.map((r) => r.host));
  const fresh = f.requests.filter(
    (r) => thirdParty(r.host) && !startHosts.has(r.host) && categoryOf(r.url) !== CONSENT_PROVIDER,
  );

  const embeds = new Set<string>();
  for (const url of [...frames.map((frame) => frame.src as string), ...fresh.map((r) => r.url)]) {
    const category = categoryOf(url);
    if (category !== null && EMBED_CATEGORIES.has(category)) embeds.add(category);
  }
  return {
    thirdPartyIframes: frames.length,
    placeholders: f.placeholders,
    newThirdPartyHosts: new Set(fresh.map((r) => r.host)).size,
    embeds: embeds.size,
  };
}

/** Score and reasons of a phase-A page as a control page for the B/C replication. */
function scoreControlCandidate(c: ControlCandidate): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (c.signals.thirdPartyIframes > 0) {
    score += SIGNAL_SCORE;
    reasons.push('iframe-signal');
  }
  if (c.signals.placeholders > 0) {
    score += SIGNAL_SCORE;
    reasons.push('placeholder-signal');
  }
  if (c.signals.newThirdPartyHosts > 0) {
    score += Math.min(MAX_NETWORK_SCORE, c.signals.newThirdPartyHosts);
    reasons.push('network-signal');
  }
  if (c.signals.embeds > 0) {
    score += EMBED_SCORE;
    reasons.push('embed-signal');
  }
  if (c.role === 'contact') {
    score += CONTACT_ROLE_SCORE;
    reasons.push('role:contact');
  }
  return { score, reasons };
}

export interface ControlOptions {
  max?: number;
  /** Origin of the page B and C click on (the start page): a consent cookie of that host reaches only its pages. */
  clickOrigin?: string | null;
}

/**
 * Up to `max` pages of phase A (not the start page) chosen by network and DOM signals; ties by A order. Pages on the
 * click origin come first; a page of another origin is taken only when none of the click origin is left, and is
 * marked `other-origin`.
 */
export function chooseControlPages(
  candidates: readonly ControlCandidate[],
  { max = 2, clickOrigin = null }: ControlOptions = {},
): ControlChoice[] {
  const onClickOrigin = (c: ControlCandidate) =>
    clickOrigin === null || parse(c.finalUrl ?? c.raw)?.origin === clickOrigin;
  const scored = candidates.map((c) => ({ ...c, ...scoreControlCandidate(c), sameOrigin: onClickOrigin(c) }));
  const legal = (r: PageRole) => r === 'impressum' || r === 'privacy';
  scored.sort((a, b) => {
    if (a.sameOrigin !== b.sameOrigin) return a.sameOrigin ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (legal(a.role) !== legal(b.role)) return legal(a.role) ? 1 : -1;
    return a.order - b.order;
  });

  return scored.slice(0, Math.max(0, max)).map(({ score: _score, sameOrigin, ...rest }) => ({
    ...rest,
    reasons: [
      ...(rest.reasons.length > 0 ? rest.reasons : ['replication']),
      ...(sameOrigin ? [] : ['other-origin']),
    ],
  }));
}
