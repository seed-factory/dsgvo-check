import type { IframeFact, PageRole } from '../../../core/snapshot/browser.ts';
import type { SanitizedUrl } from '../../../core/snapshot/common.ts';
import { parseUrl as parse, registrableDomain } from '../../../core/url/url.ts';
import type { ServiceCatalog } from '../../../derive/catalog.ts';

/** Control page scoring: a replicated embed is the strongest reason, a contact page a weak one. */
const SIGNAL_SCORE = 3;
const MAX_NETWORK_SCORE = 3;
const CONTACT_ROLE_SCORE = 2;
/** Content of a catalog embed service ranks above an unknown host: it is what a site may keep loading after a reject. */
const EMBED_SCORE = 3;

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

export interface ControlFacts {
  iframes: ReadonlyArray<Pick<IframeFact, 'src' | 'box' | 'depth'>>;
  placeholders: number;
  requests: ReadonlyArray<{ url: string; host: string }>;
  startRequests: ReadonlyArray<{ url: string; host: string }>;
}

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
