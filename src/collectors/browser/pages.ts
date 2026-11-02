/**
 * Deterministic page selection and B/C control pages. Pure: input is the link list of the start page
 * (raw hrefs stay in memory for navigation; plans store sanitized URLs), robots.txt and sitemap entries.
 */
import type { SanitizedUrl } from '../../core/snapshot-common.ts';
import { parseUrl as parse, registrableDomain } from '../../core/url.ts';
import { sanitizeRequestUrl } from './features.ts';
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
} from './legal-lexicon.ts';
import { loadLegalLexicon } from './legal-lexicon-file.ts';
import { type Robots, robotsAllows } from './robots.ts';
import type { DomRegion, LinkFact, PageRole, PlannedPage } from './types.ts';

export type { LegalKind } from './legal-lexicon.ts';
/** Identity of a page for dedup (origin + path without trailing slash + query); shared with LEGAL-01. */
export { pageKey };

export interface CandidateLink {
  /** Absolute href as found (in memory only; may contain query values). */
  raw: string;
  hrefKind: LinkFact['hrefKind'];
  text: string;
  accessibleName?: string;
  region: DomRegion;
  visible: boolean;
  /** Document order. */
  order: number;
}

export interface PageChoice {
  /** URL to navigate to (in memory only). */
  raw: string;
  url: SanitizedUrl;
  role: PageRole;
  reasons: string[];
  source: PlannedPage['source'];
  robotsAllowed?: boolean;
}

export interface LegalLinkResult {
  kind: LegalKind;
  /** page: navigable HTML page; pdf: document link to a PDF; unresolved: `#`/`javascript:`; offsite: other site. */
  status: 'page' | 'pdf' | 'unresolved' | 'offsite' | 'none';
  choice?: PageChoice;
  link?: CandidateLink;
  /**
   * Navigable same-site candidates in rank order, the chosen one first (page and pdf only). When the chosen page
   * is not confirmed as the document, the collector tries the next one within its budget.
   */
  candidates?: PageChoice[];
}

export interface Scope {
  startRaw: string;
  finalHost: string;
  etld1: string | null;
}

export interface SelectInput extends Scope {
  links: readonly CandidateLink[];
  maxPages: number;
  robots: Robots | null;
  token: string;
  sitemapLocs: readonly string[];
}

export interface PageSelection {
  impressum: LegalLinkResult;
  privacy: LegalLinkResult;
  contact: PageChoice | null;
  /** Intermediate pages to look for missing legal links (LEGAL-01 hop, ≤ 3 GETs incl. contact). */
  hops: PageChoice[];
  extras: PageChoice[];
  /** How many extras the budget allowed (fewer chosen → caller may add sitemap entries). */
  extrasWanted: number;
}

const EXTRA_KEYWORDS = [
  'video',
  'über uns',
  'ueber-uns',
  'about',
  'team',
  'karriere',
  'jobs',
  'referenzen',
  'bewertungen',
  'termin',
  'blog',
  'news',
  'aktuelles',
  'newsletter',
  'shop',
  'galerie',
  'leistungen',
  'produkte',
  'angebot',
  'service',
];
const MAX_EXTRAS = 2;
const MAX_HOP_GETS = 3;
/** Same-site alternatives to the chosen legal link that the plan records as reasons. */
const MAX_ALTERNATIVES = 2;

const FILE_RE =
  /\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|odt|jpe?g|png|gif|svg|webp|mp[34]|mov|avi|ics|vcf|exe|dmg)$/i;
const EXCLUDED_PATH_RE =
  /(wp-admin|wp-login|\/login|\/logout|abmelden|warenkorb|\/cart|checkout|\/kasse|\/account|mein-konto|\/feed\/?$)/i;
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

function template(raw: string): string {
  const u = parse(raw);
  return u ? (u.pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase() : '';
}

function stripWww(h: string): string {
  return h.toLowerCase().replace(/^www\./, '');
}

/** Final host plus its www/apex pair. */
export function inScope(raw: string, scope: Scope): boolean {
  const u = parse(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  return stripWww(u.hostname) === stripWww(scope.finalHost);
}

function sameSite(raw: string, scope: Scope): boolean {
  const u = parse(raw);
  if (!u) return false;
  if (inScope(raw, scope)) return true;
  return scope.etld1 !== null && registrableDomain(u.hostname) === scope.etld1;
}

function navigable(l: CandidateLink): boolean {
  return l.hrefKind === 'http' || l.hrefKind === 'https';
}

function excluded(raw: string): boolean {
  const u = parse(raw);
  if (!u) return true;
  return EXCLUDED_PATH_RE.test(u.pathname) || (u.pathname.includes('search') && u.search !== '');
}

function isStart(raw: string, scope: Scope): boolean {
  return pageKey(raw) === pageKey(scope.startRaw);
}

/** Substring match for the extra pages (nav keywords such as "blog" or "team"): low stakes, loose matching. */
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

/** Region, visibility, DOM order, then the URL: the order of links that are equally precise. */
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
): PageChoice {
  return {
    raw,
    url: sanitizeRequestUrl(raw),
    role,
    reasons,
    source,
    ...(robotsAllowed !== undefined ? { robotsAllowed } : {}),
  };
}

interface LegalMatch {
  link: CandidateLink;
  m: LinkMatch;
}

/** Precision of the label first (exact > starts with the key > key inside > href slug > generic), then the rest. */
function rankLegal(a: LegalMatch, b: LegalMatch): number {
  if (a.m.tier !== b.m.tier) return a.m.tier - b.m.tier;
  if (a.m.slug !== b.m.slug) return a.m.slug ? -1 : 1;
  return compareLinks(a.link, b.link);
}

function reasonOfLegal(x: LegalMatch): string {
  return x.m.byText ? `${x.link.region}-link:${x.m.keyword}` : `href:${x.m.keyword}`;
}

/**
 * Best link for a legal document kind among `links` (used on the start page and on hop pages). The result lists the
 * navigable same-site candidates in rank order. A hidden link of the consent banner to another registrable domain is
 * the policy link of a CMP vendor, not of the site.
 */
export function findLegalLink(
  links: readonly CandidateLink[],
  kind: LegalKind,
  scope: Scope,
  lexicon: LegalLexicon = loadLegalLexicon(),
): LegalLinkResult {
  const considered = links.filter((l) => !(l.region === 'banner' && !l.visible && !sameSite(l.raw, scope)));
  // The page identity lets a weak key lose against an exact label of the other kind on another link to the same URL (L3).
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
  // Prefer navigable same-site links; fall back to the best non-navigable one for the record.
  const usable: LegalMatch[] = [];
  const seen = new Set<string>();
  for (const x of matches) {
    if (!navigable(x.link) || !sameSite(x.link.raw, scope)) continue;
    const key = pageKey(x.link.raw);
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(x);
  }
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
  const best = matches[0] as LegalMatch;
  if (navigable(best.link)) return { kind, status: 'offsite', link: best.link };
  return { kind, status: 'unresolved', link: best.link };
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

export function selectPages(i: SelectInput, lexicon: LegalLexicon = loadLegalLexicon()): PageSelection {
  const used = new Set<string>([pageKey(i.startRaw)]);
  const usedTemplates = new Set<string>([template(i.startRaw)]);
  const take = (raw: string) => {
    used.add(pageKey(raw));
    usedTemplates.add(template(raw));
  };
  const candidate = (l: CandidateLink) =>
    navigable(l) &&
    inScope(l.raw, i) &&
    !isStart(l.raw, i) &&
    !used.has(pageKey(l.raw)) &&
    !FILE_RE.test(parse(l.raw)?.pathname ?? '') &&
    !excluded(l.raw);

  const impressum = findLegalLink(i.links, 'impressum', i, lexicon);
  const privacy = findLegalLink(i.links, 'privacy', i, lexicon);
  for (const r of [impressum, privacy]) if (r.status === 'page' && r.choice) take(r.choice.raw);

  const c = bestNav(i.links, lexicon.contact, candidate);
  const contact = c ? choice(c.link.raw, 'contact', [reasonOfNav(c)], 'link') : null;
  if (contact) take(contact.raw);

  const hops: PageChoice[] = [];
  const legalMissing = [impressum, privacy].some((r) => r.status === 'none' || r.status === 'unresolved');
  if (legalMissing) {
    const budget = MAX_HOP_GETS - (contact ? 1 : 0);
    for (const k of lexicon.hop) {
      if (hops.length >= budget) break;
      const m = bestNav(i.links, [k], candidate);
      if (!m) continue;
      hops.push(choice(m.link.raw, 'legal-hop', [`hop:${m.m.keyword}`], 'hop'));
      take(m.link.raw);
    }
  }

  const fixed =
    1 + [impressum, privacy].filter((r) => r.status === 'page').length + (contact ? 1 : 0) + hops.length;
  const need = Math.max(0, Math.min(MAX_EXTRAS, i.maxPages - fixed));
  const extras: PageChoice[] = [];
  const allowed = (raw: string): boolean | undefined => {
    if (!i.robots) return undefined;
    const u = parse(raw);
    return u ? robotsAllows(i.robots, `${u.pathname}${u.search}`, i.token) : false;
  };
  const tryExtra = (raw: string, reasons: string[], source: PlannedPage['source']) => {
    if (extras.length >= need) return;
    if (usedTemplates.has(template(raw)) || used.has(pageKey(raw))) return;
    const robotsAllowed = allowed(raw);
    if (robotsAllowed === false) return;
    extras.push(choice(raw, source === 'sitemap' ? 'other' : 'nav', reasons, source, robotsAllowed));
    take(raw);
  };

  for (const k of EXTRA_KEYWORDS) {
    if (extras.length >= need) break;
    const ms: Match[] = [];
    for (const l of i.links) {
      if (!candidate(l)) continue;
      const m = matchKeyword(l, [k]);
      if (m) ms.push({ link: l, ...m });
    }
    for (const m of ms.sort(rank)) tryExtra(m.link.raw, [`keyword:${k}`], 'link');
  }
  const navLinks = i.links
    .filter((l) => (l.region === 'nav' || l.region === 'header') && candidate(l))
    .sort((a, b) => a.order - b.order);
  for (const l of navLinks) tryExtra(l.raw, ['nav-link'], 'link');
  for (const loc of i.sitemapLocs) {
    if (inScope(loc, i) && !isStart(loc, i) && !FILE_RE.test(parse(loc)?.pathname ?? '') && !excluded(loc)) {
      tryExtra(loc, ['sitemap'], 'sitemap');
    }
  }

  return { impressum, privacy, contact, hops, extras, extrasWanted: need };
}

export interface ControlCandidate {
  raw: string;
  url: SanitizedUrl;
  role: PageRole;
  order: number;
  signals: { thirdPartyIframes: number; placeholders: number; newThirdPartyHosts: number };
}

export interface ControlChoice extends ControlCandidate {
  reasons: string[];
}

/** Up to `max` pages of phase A (not the start page) chosen by network and DOM signals; ties by A order. */
export function chooseControlPages(candidates: readonly ControlCandidate[], max = 2): ControlChoice[] {
  const scored = candidates.map((c) => {
    const reasons: string[] = [];
    let score = 0;
    if (c.signals.thirdPartyIframes > 0) {
      score += 3;
      reasons.push('iframe-signal');
    }
    if (c.signals.placeholders > 0) {
      score += 3;
      reasons.push('placeholder-signal');
    }
    if (c.signals.newThirdPartyHosts > 0) {
      score += Math.min(3, c.signals.newThirdPartyHosts);
      reasons.push('network-signal');
    }
    if (c.role === 'contact') {
      score += 2;
      reasons.push('role:contact');
    }
    return { ...c, score, reasons };
  });
  const legal = (r: PageRole) => r === 'impressum' || r === 'privacy';
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (legal(a.role) !== legal(b.role)) return legal(a.role) ? 1 : -1;
    return a.order - b.order;
  });
  return scored.slice(0, max).map(({ score: _score, ...rest }) => ({
    ...rest,
    reasons: rest.reasons.length > 0 ? rest.reasons : ['replication'],
  }));
}
