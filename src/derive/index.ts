/**
 * Derive: pure classification of snapshot facts by the own service catalog; recomputed on `--from-snapshot`, never
 * persisted. Third party = registrable domain differs from the target's (www/apex are one party).
 */

import { DEFAULT_CONFIG } from '../core/config/schema.ts';
import {
  type CookieRecord,
  isCookieHeld,
  type PageVisit,
  type PhaseRecord,
  type RequestRecord,
  type StorageRecord,
} from '../core/snapshot/browser.ts';
import type { Snapshot } from '../core/snapshot/index.ts';
import { parseUrl, registrableDomain } from '../core/url/url.ts';
import { loadServiceCatalog, type RequestMatch, type ServiceCatalog, type ServiceEntry } from './catalog.ts';
import type {
  ClassificationSource,
  ClassifiedCookie,
  ClassifiedHint,
  ClassifiedRequest,
  ClassifiedStorage,
  ConsentModeSignal,
  DerivedSection,
  IdentifierKind,
  InteractionTiming,
  RequestKind,
  ServiceCategory,
  ServiceInfo,
  ServiceObservation,
  TrackingStage,
} from './types.ts';

export { loadServiceCatalog, ServiceCatalog } from './catalog.ts';
export type * from './types.ts';

export interface DeriveOptions {
  /** Pre-loaded catalog (tests); default: test/data/services from `dataDir` or the package data. */
  catalog?: ServiceCatalog;
  dataDir?: string;
  /** Days a cookie must live to count as persistent; a shorter one is like a session cookie (`browser.persistentCookieMinDays`). */
  persistentCookieMinDays?: number;
}

const TRACKING_CATEGORIES: ReadonlySet<ServiceCategory> = new Set(['analytics', 'ads', 'session-recording']);
const STAGE_ORDER: readonly TrackingStage[] = ['loaded', 'initialised', 'event-sent'];
/** Request states that prove the resource reached the page (network, SW or cache). */
const LOADED_STATES: ReadonlySet<string> = new Set(['completed', 'from-sw', 'from-cache']);

/** Provenance values of an answer that is no new network exchange. */
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

function loaded(r: RequestRecord): boolean {
  return LOADED_STATES.has(r.state) || responseReceived(r);
}

/** Registrable domains (and bare hosts for IP targets) of the site itself. */
class FirstPartyScope {
  readonly etld1s: Set<string>;
  readonly hosts: Set<string>;
  constructor(hosts: readonly string[]) {
    this.hosts = new Set(hosts.map((h) => h.toLowerCase()));
    this.etld1s = new Set();
    for (const h of this.hosts) {
      const d = registrableDomain(h);
      if (d) this.etld1s.add(d);
    }
  }
  has(host: string): boolean {
    const h = host.toLowerCase().replace(/^\./, '');
    if (this.hosts.has(h)) return true;
    const d = registrableDomain(h);
    return d !== null && this.etld1s.has(d);
  }
}

export function derive(snapshot: Snapshot, opts: DeriveOptions = {}): DerivedSection {
  const catalog = opts.catalog ?? loadServiceCatalog(opts.dataDir);
  const minDays = opts.persistentCookieMinDays ?? DEFAULT_CONFIG.browser.persistentCookieMinDays;
  const host = snapshot.target.finalHost ?? snapshot.target.host;
  const scope = new FirstPartyScope([host, snapshot.target.host]);

  const requests: ClassifiedRequest[] = [];
  const cookies: ClassifiedCookie[] = [];
  const storage: ClassifiedStorage[] = [];
  const hints: ClassifiedHint[] = [];
  const stored: StoredEntry[] = [];
  for (const phase of snapshot.browser?.phases ?? []) {
    for (const page of phase.pages) hints.push(...classifyHints(catalog, scope, phase, page));
    const embeds = embedFrames(catalog, scope, phase.requests);
    for (const r of phase.requests) {
      const c = classifyRequest(catalog, scope, phase, r, embeds);
      if (c) requests.push(c);
    }
    for (const ck of phase.cookies) {
      const c = classifyCookie(catalog, phase, ck, minDays);
      cookies.push(c);
      stored.push({ c, pageUrl: ck.pageUrl });
    }
    for (const st of phase.storage) {
      const c = classifyStorage(catalog, phase, st);
      storage.push(c);
      stored.push({ c, pageUrl: st.pageUrl });
    }
  }

  const services = aggregateServices(snapshot, requests, stored);
  const info = serviceInfoFor(catalog, [...requests, ...cookies, ...storage, ...hints]);
  const meta = catalog.data.catalog;

  return {
    catalogVersion: meta.version,
    datasets: [
      {
        name: meta.name,
        version: meta.version,
        date: meta.date,
        license: meta.license,
        attribution: meta.attribution ?? null,
      },
    ],
    target: { host, etld1: registrableDomain(host) },
    requests,
    cookies,
    storage,
    services,
    catalog: info,
    hints,
    firstPartyEtld1s: [...scope.etld1s].sort(),
    allowlistVersion: catalog.allowlistVersion,
  };
}

/** Catalog entries of every service that appears in the classified facts, ordered by id. */
function serviceInfoFor(
  catalog: ServiceCatalog,
  facts: readonly { serviceId: string | null }[],
): Record<string, ServiceInfo> {
  const ids = new Set<string>();
  for (const x of facts) if (x.serviceId) ids.add(x.serviceId);

  const info: Record<string, ServiceInfo> = {};
  for (const id of [...ids].sort()) {
    const entry = catalog.info(id);
    if (entry) info[id] = entry;
  }
  return info;
}

export function timingOf(
  phase: Pick<PhaseRecord, 'phase' | 'click'>,
  afterClick: boolean,
): InteractionTiming {
  if (phase.phase === 'A' || !afterClick) return 'before-interaction';
  const action = phase.click?.action ?? (phase.phase === 'C' ? 'accept' : 'reject');
  return action === 'accept' ? 'after-accept' : 'after-reject';
}

function parseHttpUrl(raw: string): URL | null {
  return parseUrl(raw, undefined, true);
}

/** Playwright resource types whose kind does not depend on the service. */
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
  if (kind === 'image') return category === 'video' ? 'thumbnail' : 'static';
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
  /** Registrable domain of the frame's document. */
  etld1: string | null;
}

/**
 * Embedded service per third-party frame of a phase (by `frameId`): the service of the frame's document, or, for the
 * frame of a site builder or of an unknown host, the first embedded service loaded in it (a builder's map frame that
 * loads Google Maps). Frames of the site itself and frames without a document URL get none.
 */
function embedFrames(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  requests: readonly RequestRecord[],
): Map<string, EmbedFrame> {
  const embedded = (url: URL | null): ServiceEntry | null => {
    const service = url ? catalog.matchUrl(url)?.service : undefined;
    return service && EMBED_CATEGORIES.has(service.category) ? service : null;
  };

  const frames = new Map<string, { thirdParty: boolean; etld1: string | null; own: ServiceEntry | null }>();
  const loadedIn = new Map<string, ServiceEntry>();
  for (const r of requests) {
    if (r.isMainFrame || !r.frameId) continue;
    let frame = frames.get(r.frameId);
    if (!frame) {
      const url = r.frameUrl ? parseHttpUrl(r.frameUrl) : null;
      frame = {
        thirdParty: url !== null && !scope.has(url.hostname),
        etld1: url ? registrableDomain(url.hostname) : null,
        own: embedded(url),
      };
      frames.set(r.frameId, frame);
    }
    if (frame.thirdParty && !frame.own && !loadedIn.has(r.frameId)) {
      const service = embedded(parseHttpUrl(r.url));
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

function withEmbed(base: ClassifiedRequest, embed: ServiceEntry, r: RequestRecord): ClassifiedRequest {
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
  return out;
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
    loaded: loaded(r),
    timing: timingOf(phase, r.afterClick),
  };
  withIdentifier(base, identifierOf(catalog, r, undefined));

  const frame = !r.isMainFrame && r.frameId ? embeds.get(r.frameId) : undefined;
  if (frame && belongsToEmbed(match, frame, thirdParty, etld1)) return withEmbed(base, frame.service, r);

  const out = match ? withCatalogMatch(base, match, r, catalog, thirdParty, consentMode) : base;
  if (frame) out.frameServiceId = frame.service.id;
  return out;
}

/** The request as a service of the catalog: its kind, stage, identifier, integration and consent-mode behaviour. */
function withCatalogMatch(
  base: ClassifiedRequest,
  match: RequestMatch,
  r: RequestRecord,
  catalog: ServiceCatalog,
  thirdParty: boolean,
  consentMode: ConsentModeSignal | null,
): ClassifiedRequest {
  const service = match.service;
  const kind = match.signature?.kind ?? kindFromResourceType(r.resourceType, service.category);
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

const HINT_RELS = new Set(['preconnect', 'dns-prefetch', 'preload', 'prefetch', 'modulepreload']);

function classifyHints(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  phase: PhaseRecord,
  page: PageVisit,
): ClassifiedHint[] {
  const out: ClassifiedHint[] = [];
  for (const h of page.dom?.linkRels ?? []) {
    const rels = h.rel
      .toLowerCase()
      .split(/\s+/)
      .filter((r) => HINT_RELS.has(r));
    const url = rels.length > 0 ? parseHttpUrl(h.href) : null;
    if (!url) continue;
    const m = catalog.matchUrl(url);
    for (const rel of rels) {
      out.push({
        phase: phase.phase,
        pageUrl: page.finalUrl || page.url,
        rel,
        href: h.href,
        host: url.hostname.toLowerCase(),
        thirdParty: !scope.has(url.hostname),
        serviceId: m?.service.id ?? null,
        category: m?.service.category ?? 'unknown',
      });
    }
  }
  return out;
}

function serviceByHost(catalog: ServiceCatalog, host: string | undefined | null): ServiceEntry | null {
  if (!host) return null;
  const url = parseHttpUrl(`https://${host.replace(/^\./, '')}/`);
  if (!url) return null;
  const m = catalog.matchUrl(url);
  return m && m.via !== 'any-host' ? m.service : null;
}

function sameCompany(a: ServiceEntry, b: ServiceEntry): boolean {
  const company = (s: ServiceEntry) => (s.parent ?? s.provider)?.name ?? null;
  return company(a) !== null && company(a) === company(b);
}

/** Persistent with a lifetime of at least `minDays`; a missing lifetime of a persistent cookie counts as long. */
function persistentLifetime(lifetime: CookieRecord['lifetime'], minDays: number): boolean {
  return lifetime.kind === 'persistent' && (lifetime.days ?? Number.POSITIVE_INFINITY) >= minDays;
}

function classifyCookie(
  catalog: ServiceCatalog,
  phase: PhaseRecord,
  c: CookieRecord,
  minDays: number,
): ClassifiedCookie {
  const domain = c.domain.replace(/^\./, '').toLowerCase();
  const named = catalog.matchCookie(c.name, domain);
  const allowCls = catalog.allowlistedCookie(c.name);
  const tracking = named?.tracking === true;

  let service: ServiceEntry | null = named?.service ?? null;
  let source: ClassificationSource = named ? 'catalog' : 'none';
  if (!service) {
    service = (!c.firstParty ? serviceByHost(catalog, domain) : null) ?? serviceByHost(catalog, c.setterHost);
    if (service) source = 'heuristic';
  } else if (c.setter === 'http-response') {
    // A cookie name the services of one company share (IDE on doubleclick.net) belongs to the one whose host answered
    // with it. A script-set cookie names the host of the script, which may be the loader of another service.
    const setter = serviceByHost(catalog, c.setterHost);
    if (setter && sameCompany(setter, service)) service = setter;
  }

  const out: ClassifiedCookie = {
    key: { name: c.name, domain, firstParty: c.firstParty, path: c.path, partitionKey: c.partitionKey },
    phase: c.phase,
    state: c.state,
    afterClick: c.afterClick,
    serviceId: service?.id ?? null,
    category: service?.category ?? 'unknown',
    tracking,
    allowlisted: !tracking && allowCls !== null,
    persistent: persistentLifetime(c.lifetime, minDays),
    thirdParty: !c.firstParty,
    source,
    etld1: registrableDomain(domain),
    timing: timingOf(phase, c.afterClick),
  };
  if (out.allowlisted && allowCls) out.allowlistClass = allowCls;
  return out;
}

function originHost(origin: string): string | null {
  return parseHttpUrl(origin)?.hostname.toLowerCase() ?? null;
}

function classifyStorage(catalog: ServiceCatalog, phase: PhaseRecord, s: StorageRecord): ClassifiedStorage {
  const host = originHost(s.origin);
  const named = catalog.matchStorage(s.key, host);
  const allowCls = catalog.allowlistedStorage(s.key);
  const tracking = named?.tracking === true;

  let service: ServiceEntry | null = named?.service ?? null;
  let source: ClassificationSource = named ? 'catalog' : 'none';
  if (!service && !s.firstParty) {
    service = serviceByHost(catalog, host);
    if (service) source = 'heuristic';
  }

  const out: ClassifiedStorage = {
    storageType: s.storageType,
    origin: s.origin,
    key: s.key,
    phase: s.phase,
    afterClick: s.afterClick,
    serviceId: service?.id ?? null,
    category: service?.category ?? 'unknown',
    tracking,
    thirdParty: !s.firstParty,
    source,
    allowlisted: !tracking && allowCls !== null,
    persistent: s.storageType !== 'sessionStorage',
    etld1: host ? registrableDomain(host) : null,
    timing: timingOf(phase, s.afterClick),
  };
  if (out.allowlisted && allowCls) out.allowlistClass = allowCls;
  return out;
}

function addUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/** A classified cookie or storage entry with the page it was written on. */
interface StoredEntry {
  c: ClassifiedCookie | ClassifiedStorage;
  pageUrl: string;
}

function aggregateServices(
  snapshot: Snapshot,
  requests: readonly ClassifiedRequest[],
  stored: readonly StoredEntry[],
): ServiceObservation[] {
  const records = new Map<string, RequestRecord>();
  for (const p of snapshot.browser?.phases ?? []) for (const r of p.requests) records.set(r.id, r);

  const byId = new Map<string, ServiceObservation>();
  const get = (serviceId: string, category: ServiceCategory): ServiceObservation => {
    let s = byId.get(serviceId);
    if (!s) {
      s = emptyObservation(serviceId, category);
      byId.set(serviceId, s);
    }
    return s;
  };

  for (const r of requests) {
    if (!r.serviceId) continue;
    const rec = records.get(r.requestId);
    const s = get(r.serviceId, r.category);

    addUnique(s.phases, r.phase);
    if (rec) addUnique(s.pages, rec.pageUrl);
    s.requestIds.push(r.requestId);
    if (r.timing) addUnique(s.timings as InteractionTiming[], r.timing);
    if (r.identifier) s.identifierSeen = true;
    if (r.delivered) s.delivered = true;
    if (r.firstPartyProxy) s.firstPartyProxy = true;
    if (r.stage && rec && loaded(rec)) addUnique(s.stages, r.stage);
  }

  // A service known only by its cookie or storage entry was still observed on the page that wrote it.
  for (const { c, pageUrl } of stored) {
    if (!c.serviceId) continue;
    const s = get(c.serviceId, c.category);

    addUnique(s.phases, c.phase);
    addUnique(s.pages, pageUrl);
    if ('key' in c && typeof c.key === 'object') addUnique(s.cookieNames, c.key.name);
    if (c.timing) addUnique(s.timings as InteractionTiming[], c.timing);
    const accepted = 'state' in c ? isCookieHeld(c.state) : true;
    if (c.tracking && accepted) addUnique(s.stages, 'initialised');
  }

  for (const s of byId.values()) {
    s.stages.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
    s.phases.sort();
    s.pages.sort();
  }
  return [...byId.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}

function emptyObservation(serviceId: string, category: ServiceCategory): ServiceObservation {
  return {
    serviceId,
    category,
    phases: [],
    pages: [],
    requestIds: [],
    cookieNames: [],
    stages: [],
    identifierSeen: false,
    timings: [],
    delivered: false,
    firstPartyProxy: false,
  };
}
