import type { PhaseRecord, RequestRecord } from '../core/snapshot/browser.ts';
import { registrableDomain } from '../core/url/url.ts';
import { loadServiceCatalog, type RequestMatch, type ServiceCatalog, type ServiceEntry } from './catalog.ts';
import { type FirstPartyScope, parseHttpUrl, timingOf } from './context.ts';
import type {
  ClassifiedRequest,
  ConsentModeSignal,
  IdentifierKind,
  RequestKind,
  ServiceCategory,
  TrackingStage,
} from './types.ts';

const TRACKING_CATEGORIES: ReadonlySet<ServiceCategory> = new Set(['analytics', 'ads', 'session-recording']);
/** Request states that prove the resource reached the page (network, SW or cache). */
const LOADED_STATES: ReadonlySet<string> = new Set(['completed', 'from-sw', 'from-cache']);

const NON_NETWORK_PROVENANCE: ReadonlySet<string> = new Set(['service-worker', 'http-cache', 'memory-cache']);

/**
 * The request left the browser and a network response arrived, even if a later body error ended the record. Answers
 * from a service worker or cache are no network exchange (`provenance`); `fromServiceWorker` marks only the initiator.
 */
export function responseReceived(r: RequestRecord): boolean {
  if (r.provenance !== undefined && NON_NETWORK_PROVENANCE.has(r.provenance)) return false;
  if (r.state === 'from-sw' || r.state === 'from-cache' || r.state === 'blocked-by-browser') return false;
  if (r.state === 'completed') return true;
  return r.delivery === 'sent' && (r.result?.kind === 'response' || typeof r.status === 'number');
}

export function requestLoaded(r: RequestRecord): boolean {
  return LOADED_STATES.has(r.state) || responseReceived(r);
}

const KIND_BY_RESOURCE_TYPE: ReadonlyMap<string, RequestKind> = new Map([
  ['script', 'library'],
  ['stylesheet', 'stylesheet'],
  ['font', 'font'],
  ['document', 'embed'],
]);

/** Resource types that can carry an event: a hit of a tracking service, a plain resource of any other. */
const EVENT_TRANSPORT_TYPES: ReadonlySet<string> = new Set([
  'xhr',
  'fetch',
  'ping',
  'beacon',
  'websocket',
  'eventsource',
]);

export function kindFromResourceType(resourceType: string, category: ServiceCategory): RequestKind {
  const fixed = KIND_BY_RESOURCE_TYPE.get(resourceType);
  if (fixed) return fixed;
  const tracking = TRACKING_CATEGORIES.has(category);
  if (resourceType === 'image') {
    if (tracking) return 'hit';
    return category === 'maps' ? 'tile' : 'image';
  }
  if (EVENT_TRANSPORT_TYPES.has(resourceType)) return tracking ? 'hit' : 'resource';
  // Chromium's catch-all `other` (e.g. Compression Dictionary Transport) is no event transport: without a catalog
  // signature it proves a loaded resource only, like any type not listed here.
  return 'resource';
}

const STAGE_BY_KIND: ReadonlyMap<RequestKind, TrackingStage> = new Map([
  ['hit', 'event-sent'],
  ['config', 'initialised'],
]);

export function stageFromKind(kind: RequestKind): TrackingStage {
  return STAGE_BY_KIND.get(kind) ?? 'loaded';
}

const INTEGRATION_BY_KIND: ReadonlyMap<RequestKind, string> = new Map([
  ['embed', 'iframe'],
  ['library', 'js-api'],
  ['tile', 'tiles'],
]);

export function integrationFromKind(category: ServiceCategory, kind: RequestKind): string | undefined {
  if (category !== 'maps' && category !== 'video') return undefined;
  // A video image is a thumbnail only by its catalog signature: a player's beacon image (`generate_204`) is none.
  if (kind === 'image') return category === 'maps' ? 'static' : 'other';
  return INTEGRATION_BY_KIND.get(kind) ?? 'other';
}

function gcdLetter(ch: string | undefined, catalog: ServiceCatalog): 'granted' | 'denied' | null {
  if (!ch) return null;
  if (catalog.data.consentMode.gcdDenied.includes(ch)) return 'denied';
  if (catalog.data.consentMode.gcdGranted.includes(ch)) return 'granted';
  return null;
}

/** Consent Mode state in `gcs=G1<ad><analytics>` (1 granted, 0 denied) or the community-documented `gcd`. */
export function decodeConsentMode(
  gcs: string | undefined,
  gcd: string | undefined,
  catalog: ServiceCatalog = loadServiceCatalog(),
): ConsentModeSignal | null {
  const m = /^G1([01-])([01-])/.exec(gcs ?? '');
  if (m) {
    const val = (c: string | undefined) => (c === '1' ? 'granted' : c === '0' ? 'denied' : null);
    return { adStorage: val(m[1]), analyticsStorage: val(m[2]), source: 'gcs' };
  }
  if (gcd && /^1[0-9a-zA-Z_-]{4,}/.test(gcd)) {
    const signal: ConsentModeSignal = {
      adStorage: gcdLetter(gcd[2], catalog),
      analyticsStorage: gcdLetter(gcd[4], catalog),
      source: 'gcd',
    };
    return signal.adStorage || signal.analyticsStorage ? signal : null;
  }
  return null;
}

const PERSISTENT_KINDS: ReadonlySet<IdentifierKind> = new Set([
  'stored-match',
  'sent-cookie',
  'persistent-param',
  'user-supplied',
]);

/**
 * `identifier.kind` from collector facts only: a key of the sanitized URL is no evidence, since it survives redaction
 * even when its value was empty. A tracking cookie in the request's Cookie header is `sent-cookie`, not
 * `stored-match`: no value of the request was compared with it.
 */
export function identifierOf(
  catalog: ServiceCatalog,
  r: RequestRecord,
  identifierParams: readonly string[] | undefined,
): { kind: IdentifierKind; param?: string } {
  const names = r.identifierNames ?? [];
  const sentCookieNames = r.sentCookieNames ?? [];
  const sentCookie = sentCookieNames.find((n) => catalog.matchCookie(n, r.host)?.tracking === true);

  if (r.matchesStoredIdentifier === true) {
    const param = names.find((n) => !sentCookieNames.includes(n)) ?? names[0];
    return param ? { kind: 'stored-match', param } : { kind: 'stored-match' };
  }
  if (sentCookie) return { kind: 'sent-cookie', param: sentCookie };

  const catalogParams = new Set((identifierParams ?? []).map((n) => n.toLowerCase()));
  const persistent = names.find((n) => catalogParams.has(n.toLowerCase()));
  if (persistent) return { kind: 'persistent-param', param: persistent };

  const supplied = names.find((n) => catalog.userSuppliedParams.has(n.toLowerCase()));
  if (supplied) return { kind: 'user-supplied', param: supplied };

  if (names.length > 0 || r.identifierPresent) {
    const param = names[0];
    return param ? { kind: 'per-load', param } : { kind: 'per-load' };
  }
  return { kind: 'none' };
}

function withIdentifier(out: ClassifiedRequest, id: { kind: IdentifierKind; param?: string }): void {
  out.identifierKind = id.kind;
  out.identifier = PERSISTENT_KINDS.has(id.kind);
  if (id.param) out.identifierParam = id.param;
  else delete out.identifierParam;
}

function relevantStorage(service: ServiceEntry): 'ad' | 'analytics' | null {
  if (service.consentStorage) return service.consentStorage;
  if (service.category === 'analytics') return 'analytics';
  if (service.category === 'ads') return 'ad';
  return null;
}

/** Services embedded as a frame: what their frame loads is part of the embed, not of the site. */
const EMBED_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  'maps',
  'video',
  'captcha',
  'widget',
  'social',
  'reviews',
  'chat',
]);

/** The embedded service of a third-party frame; `loaded`: taken from what the frame loads, not from its document. */
interface EmbedFrame {
  service: ServiceEntry;
  loaded: boolean;
  etld1: string | null;
}

/** A response that only points elsewhere: the frame's document is where the redirect leads. */
function redirectHop(r: RequestRecord): boolean {
  const status = r.status ?? (r.result?.kind === 'response' ? r.result.status : undefined);
  return status !== undefined && status >= 300 && status < 400;
}

/**
 * Address of each subframe's document: its first document request that is no redirect hop, else the first address
 * any of its requests carried. A frame of the site that redirects to a player, or a request made before the frame
 * had an address, would otherwise decide the frame by an address that is not its document.
 */
function frameDocuments(requests: readonly RequestRecord[]): Map<string, string> {
  const doc = new Map<string, string>();
  const first = new Map<string, string>();
  for (const r of requests) {
    if (r.isMainFrame || !r.frameId || !r.frameUrl) continue;
    if (!first.has(r.frameId)) first.set(r.frameId, r.frameUrl);
    if (!doc.has(r.frameId) && r.resourceType === 'document' && !redirectHop(r))
      doc.set(r.frameId, r.frameUrl);
  }
  for (const [id, url] of first) if (!doc.has(id)) doc.set(id, url);
  return doc;
}

/**
 * Embedded service per third-party frame of a phase (by `frameId`): the service of the frame's document, or, for the
 * frame of a site builder or of an unknown host, the first embedded service loaded in it (a builder's map frame that
 * loads Google Maps). A site builder is a host of no catalog service or a CDN of the catalog (Wix serves its pages
 * from one). The frame of any other known service (payment, ads, consent) takes no embed from what it loads, so its
 * own helper hosts and fonts are not attributed to that embed. Frames of the site itself and frames without any
 * address get none.
 */
function embedFrames(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  requests: readonly RequestRecord[],
): Map<string, EmbedFrame> {
  const embedded = (service: ServiceEntry | undefined): ServiceEntry | null =>
    service && EMBED_CATEGORIES.has(service.category) ? service : null;

  const documents = frameDocuments(requests);
  const frames = new Map<
    string,
    { thirdParty: boolean; etld1: string | null; own: ServiceEntry | null; builder: boolean }
  >();
  const loadedIn = new Map<string, ServiceEntry>();
  for (const r of requests) {
    if (r.isMainFrame || !r.frameId) continue;
    let frame = frames.get(r.frameId);
    if (!frame) {
      const address = documents.get(r.frameId);
      const url = address ? parseHttpUrl(address) : null;
      const service = url ? catalog.matchUrl(url)?.service : undefined;
      frame = {
        thirdParty: url !== null && !scope.has(url.hostname),
        etld1: url ? registrableDomain(url.hostname) : null,
        own: embedded(service),
        builder: !service || service.category === 'cdn',
      };
      frames.set(r.frameId, frame);
    }
    if (frame.thirdParty && frame.builder && !loadedIn.has(r.frameId)) {
      const url = parseHttpUrl(r.url);
      const service = embedded(url ? catalog.matchUrl(url)?.service : undefined);
      if (service) loadedIn.set(r.frameId, service);
    }
  }

  const out = new Map<string, EmbedFrame>();
  for (const [id, f] of frames) {
    if (!f.thirdParty) continue;
    const loaded = loadedIn.get(id);
    if (f.own) out.set(id, { service: f.own, loaded: false, etld1: f.etld1 });
    else if (loaded) out.set(id, { service: loaded, loaded: true, etld1: f.etld1 });
  }
  return out;
}

/**
 * A request of an embed's frame to a host of no catalog service, or a font: a resource of the embed (a player's
 * fonts and helper scripts), not a service of the site. In a builder's frame the builder's own hosts stay its own.
 */
function belongsToEmbed(
  match: RequestMatch | null,
  frame: EmbedFrame,
  thirdParty: boolean,
  etld1: string | null,
): boolean {
  if (!thirdParty || match?.service.id === frame.service.id) return false;
  if (frame.loaded && etld1 !== null && etld1 === frame.etld1) return false;
  return !match || match.service.category === 'fonts';
}

/**
 * The request as a resource of the embed. The catalog service of the resource itself (the fonts of a map frame) stays
 * known as `resourceServiceId`, so a check can name it while the embed keeps the request, and so does its kind for that
 * service: a font service's usage hit in the frame fetches no font, as on the site.
 */
function withEmbed(
  base: ClassifiedRequest,
  embed: ServiceEntry,
  r: RequestRecord,
  match: RequestMatch | null,
): ClassifiedRequest {
  const kind = kindFromResourceType(r.resourceType, embed.category);
  const out: ClassifiedRequest = {
    ...base,
    serviceId: embed.id,
    category: embed.category,
    source: 'embed-frame',
    kind,
    stage: stageFromKind(kind),
    frameServiceId: embed.id,
  };
  const integration = integrationFromKind(embed.category, kind);
  if (integration) out.integration = integration;
  if (match) {
    out.resourceServiceId = match.service.id;
    out.resourceCategory = match.service.category;
    out.resourceKind = matchKind(match, r);
  }
  return out;
}

function matchKind(match: RequestMatch, r: RequestRecord): RequestKind {
  return match.signature?.kind ?? kindFromResourceType(r.resourceType, match.service.category);
}

function classifyRequest(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  phase: PhaseRecord,
  r: RequestRecord,
  embeds: ReadonlyMap<string, EmbedFrame>,
): ClassifiedRequest | null {
  const url = parseHttpUrl(r.url);
  if (!url) return null;

  const host = (r.host || url.hostname).toLowerCase();
  const etld1 = registrableDomain(host);
  const thirdParty = !scope.has(host);
  const match: RequestMatch | null = catalog.matchUrl(url);
  const consentSignals = r.consentSignals ?? {};
  const consentMode = decodeConsentMode(
    consentSignals.gcs ?? url.searchParams.get('gcs') ?? undefined,
    consentSignals.gcd ?? url.searchParams.get('gcd') ?? undefined,
    catalog,
  );

  const base: ClassifiedRequest = {
    requestId: r.id,
    phase: r.phase,
    host,
    etld1,
    thirdParty,
    firstPartyProxy: false,
    serviceId: null,
    category: 'unknown',
    source: 'none',
    consentMode,
    delivered: responseReceived(r),
    loaded: requestLoaded(r),
    timing: timingOf(phase, r.afterClick),
  };
  withIdentifier(base, identifierOf(catalog, r, undefined));

  const frame = !r.isMainFrame && r.frameId ? embeds.get(r.frameId) : undefined;
  if (frame && belongsToEmbed(match, frame, thirdParty, etld1))
    return withEmbed(base, frame.service, r, match);

  const out = match ? withCatalogMatch(base, match, r, catalog, thirdParty, consentMode) : base;
  if (frame) out.frameServiceId = frame.service.id;
  return out;
}

function withCatalogMatch(
  base: ClassifiedRequest,
  match: RequestMatch,
  r: RequestRecord,
  catalog: ServiceCatalog,
  thirdParty: boolean,
  consentMode: ConsentModeSignal | null,
): ClassifiedRequest {
  const service = match.service;
  const kind = matchKind(match, r);
  const out: ClassifiedRequest = {
    ...base,
    serviceId: service.id,
    category: service.category,
    source: 'catalog',
    kind,
    stage: match.signature?.stage ?? stageFromKind(kind),
  };
  withIdentifier(out, identifierOf(catalog, r, match.signature?.identifierParams));
  if (match.signature) out.signatureId = `${service.id}:${match.signature.id}`;
  const integration = match.signature?.integration ?? integrationFromKind(service.category, kind);
  if (integration) out.integration = integration;

  // A catalog service answering on the site's own domain is either self-hosted or a first-party proxy.
  if (!thirdParty && match.via === 'any-host') {
    if (service.selfHostable) out.selfHosted = true;
    else out.firstPartyProxy = true;
  }

  const storageType = relevantStorage(service);
  if (storageType && consentMode) {
    const state = storageType === 'ad' ? consentMode.adStorage : consentMode.analyticsStorage;
    out.cookieless = state === 'denied';
  }
  return out;
}

export function* classifyRequests(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  phase: PhaseRecord,
): Iterable<ClassifiedRequest> {
  const embeds = embedFrames(catalog, scope, phase.requests);
  for (const record of phase.requests) {
    const request = classifyRequest(catalog, scope, phase, record, embeds);
    if (request) yield request;
  }
}
