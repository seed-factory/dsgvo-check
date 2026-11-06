/**
 * TLS-01 on the pages of the site: same-site links whose href asks for `http://` (phase A, pages served over https).
 * One observation per linked host, classified by what the scan's plain-http probe of that host observed; the probe
 * reads the host's root, not the linked path.
 */

import {
  type EvidenceInput,
  type Observation,
  parseUrl,
  registrableDomain,
  subjects,
} from '../../core/api.ts';
import type { BrowserSection, DomRegion, LinkFact, PageVisit } from '../../core/snapshot/browser.ts';
import type { HttpHop, HttpSection, RedirectChain } from '../../core/snapshot/http.ts';
import { browserAcceptsTls, hstsOf, isRedirect, isSuccess } from './shared.ts';

const ID = 'TLS-01';

/**
 * What following an http link to the host leads to, by its plain-http probe: `served` = a page over http without a
 * redirect by status code; `upgraded` = a redirect to https without HSTS on the way; `hsts` = with it; `not-serving` =
 * port closed or no DNS; `unknown` = probed without a usable answer; `not-probed` = the scan probed only the target,
 * its www and its registrable domain on the standard port.
 */
type LinkedHostState = 'served' | 'upgraded' | 'hsts' | 'not-serving' | 'unknown' | 'not-probed';

const NOT_SERVING: ReadonlySet<RedirectChain['outcome']> = new Set([
  'connection-refused',
  'dns-error',
  'tls-error',
]);

/** The most prominent link speaks for its host: visible first, then by region, then in page order. */
const REGION_RANK: Readonly<Record<DomRegion, number>> = {
  nav: 0,
  header: 1,
  footer: 2,
  main: 3,
  aside: 4,
  other: 5,
  banner: 6,
};

interface SeenLink {
  link: LinkFact;
  href: string;
  page: string;
  order: number;
}

interface LinkedHost {
  /** Lower-case `host[:port]` as in the URL. */
  key: string;
  hostname: string;
  port: string;
  links: SeenLink[];
}

export interface LinkResult {
  observations: Observation[];
  /** True when phase A has no evaluable page whose links were read. */
  notObserved: boolean;
}

function sameSiteHosts(a: string, b: string): boolean {
  const siteA = registrableDomain(a);
  return siteA === null ? a === b : siteA === registrableDomain(b);
}

/** A link inside a frame of another site belongs to that site's content, not to the site's own navigation. */
function inForeignFrame(link: LinkFact, linkHost: string): boolean {
  if (!link.frameUrl) return false;
  const frameHost = parseUrl(link.frameUrl)?.hostname.toLowerCase();
  return frameHost === undefined || !sameSiteHosts(frameHost, linkHost);
}

/** Phase A pages whose links were read. */
function readPages(browser: BrowserSection): PageVisit[] {
  const a = browser.phases.find((p) => p.phase === 'A');
  return (a?.pages ?? []).filter((p) => p.evaluable && p.dom !== null);
}

/** Same-site http links by host. A page itself served over http is left to the entry variants of its host. */
function linkedHosts(pages: readonly PageVisit[]): LinkedHost[] {
  const hosts = new Map<string, LinkedHost>();
  let order = 0;
  for (const page of pages) {
    if (!page.finalUrl.startsWith('https:')) continue;
    for (const link of page.dom?.links ?? []) {
      order++;
      if (link.hrefKind !== 'http' || link.sameSite !== true || link.href === null) continue;
      const u = parseUrl(link.href);
      if (u?.protocol !== 'http:') continue;
      const hostname = u.hostname.toLowerCase();
      if (inForeignFrame(link, hostname)) continue;

      const key = u.host.toLowerCase();
      const entry = hosts.get(key) ?? { key, hostname, port: u.port, links: [] };
      entry.links.push({ link, href: link.href, page: page.finalUrl, order });
      hosts.set(key, entry);
    }
  }
  return [...hosts.values()];
}

/** Plain-http probe of the host on the standard port; a link that names another port was not probed. */
function probeOf(http: HttpSection, host: LinkedHost): RedirectChain | undefined {
  if (host.port !== '') return undefined;
  return http.chains.find(
    (c) => c.scheme === 'http' && c.port === undefined && c.host.toLowerCase() === host.hostname,
  );
}

/** Browsers ignore HSTS on IP literals (RFC 6797 §8.1); the URL parser writes them as dotted quads or in brackets. */
const isIpLiteral = (hostname: string): boolean =>
  hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * The redirect the link takes reaches an https answer with a header a browser keeps (HSTS), as the upgrade target. A
 * policy sent outside that way, by the host's own https probe, was not seen by a visitor following the link.
 */
function hstsOnTheWay(probe: RedirectChain): boolean {
  return probe.hops.some((h) => {
    const host = h.url.startsWith('https:') ? parseUrl(h.url)?.hostname.toLowerCase() : undefined;
    return (
      host !== undefined &&
      !isIpLiteral(host) &&
      browserAcceptsTls(h.tlsAuthorized, h.tlsAuthorizationError) &&
      hstsOf(h.headers)?.ok === true
    );
  });
}

function linkedHostState(http: HttpSection, host: LinkedHost): LinkedHostState {
  const probe = probeOf(http, host);
  if (!probe) return 'not-probed';
  const hops = probe.hops;
  const last = hops.at(-1);
  if (!last) return NOT_SERVING.has(probe.outcome) ? 'not-serving' : 'unknown';

  if (last.url.startsWith('https:')) {
    // A chain cut on an https redirect may still lead back to http.
    if (probe.outcome !== 'ok' || isRedirect(last.status)) return 'unknown';
    const httpsHops = hops.filter((h) => h.url.startsWith('https:'));
    if (httpsHops.some((h) => !browserAcceptsTls(h.tlsAuthorized, h.tlsAuthorizationError))) return 'unknown';
    return hstsOnTheWay(probe) ? 'hsts' : 'upgraded';
  }
  if (probe.outcome !== 'ok' || isRedirect(last.status)) return 'unknown';
  return isSuccess(last.status) ? 'served' : 'unknown';
}

/** The labels of the host below its registrable domain; `@` for the registrable domain itself. */
function hostLabel(host: LinkedHost): string {
  const site = registrableDomain(host.hostname);
  const label = site === null || site === host.hostname ? '@' : host.hostname.slice(0, -(site.length + 1));
  return host.port ? `${label}:${host.port}` : label;
}

function compareLinks(a: SeenLink, b: SeenLink): number {
  if (a.link.visible !== b.link.visible) return a.link.visible ? -1 : 1;
  const r = REGION_RANK[a.link.region] - REGION_RANK[b.link.region];
  return r !== 0 ? r : a.order - b.order;
}

const linkText = (l: LinkFact): string => l.text || l.accessibleName || '';

/** One evidence item per distinct link (href, text, region, visibility), on the first page it was seen. */
function linkEvidence(links: readonly SeenLink[]): EvidenceInput[] {
  const seen = new Set<string>();
  const out: EvidenceInput[] = [];
  for (const s of links) {
    const text = linkText(s.link);
    const key = JSON.stringify([s.href, text, s.link.region, s.link.visible]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: 'link',
      phase: 'A',
      page: s.page,
      href: s.href,
      text,
      region: s.link.region,
      visible: s.link.visible,
    });
  }
  return out;
}

function chainEvidence(c: RedirectChain): EvidenceInput {
  return {
    type: 'redirect-chain',
    phase: 'http',
    startUrl: c.startUrl,
    hops: c.hops.map((h: HttpHop) => ({
      url: h.url,
      status: h.status,
      ...(h.location ? { location: h.location } : {}),
    })),
    outcome: c.outcome,
  };
}

function hostObservation(http: HttpSection, host: LinkedHost): Observation | null {
  const state = linkedHostState(http, host);
  if (state === 'hsts' || state === 'not-serving') return null;

  const links = [...host.links].sort(compareLinks);
  const first = links[0] as SeenLink;
  const pages = [...new Set(host.links.map((l) => l.page))];
  const probe = probeOf(http, host);
  const text = linkText(first.link);
  const params: Observation['params'] = {
    host: host.key,
    href: first.href,
    text,
    hasText: text ? 'yes' : 'no',
    page: pages[0] as string,
    count: pages.length,
    links: new Set(host.links.map((l) => l.href)).size,
    visible: first.link.visible ? 'yes' : 'no',
    region: first.link.region,
  };
  const upgraded = state === 'upgraded';
  return {
    checkId: ID,
    variant: upgraded ? 'internal-http-link-upgraded' : 'internal-http-link',
    // Without a usable probe it is not known whether the http address serves the page or redirects.
    confidence: state === 'served' || upgraded ? 'high' : 'medium',
    subject: subjects.httpLink(hostLabel(host)),
    phases: ['A'],
    pages,
    evidence: [...(probe ? [chainEvidence(probe)] : []), ...linkEvidence(links)],
    params: upgraded
      ? { ...params, location: probe?.hops[0]?.location ?? '' }
      : { ...params, httpState: state },
  };
}

/** Links of phase A to http addresses of the site. */
export function evaluateHttpLinks(http: HttpSection, browser: BrowserSection): LinkResult {
  const pages = readPages(browser);
  if (pages.length === 0) return { observations: [], notObserved: true };
  const observations = linkedHosts(pages)
    .map((h) => hostObservation(http, h))
    .filter((o): o is Observation => o !== null);
  return { observations, notObserved: false };
}
