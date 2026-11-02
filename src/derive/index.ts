/**
 * Derive: pure classification of snapshot facts by the own service catalog.
 * Third party = registrable domain (eTLD+1) differs from the target's (www/apex are one party). First-party
 * tracker proxies (sGTM, tag gateway) are recognised by catalog path signatures on the site's own host.
 * Recomputed on `--from-snapshot`; never persisted.
 */

import type {
  CookieRecord,
  PageVisit,
  PhaseRecord,
  RequestRecord,
  StorageRecord,
} from '../collectors/browser/types.ts';
import type { Snapshot } from '../core/snapshot.ts';
import { parseUrl, registrableDomain } from '../core/url.ts';
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
  /** Pre-loaded catalog (tests); default: data/services from `dataDir` or the package data. */
  catalog?: ServiceCatalog;
  dataDir?: string;
}

const TRACKING_CATEGORIES: ReadonlySet<ServiceCategory> = new Set(['analytics', 'ads', 'session-recording']);
const STAGE_ORDER: readonly TrackingStage[] = ['loaded', 'initialised', 'event-sent'];
/** Request states that prove the resource reached the page (network, SW or cache). */
const LOADED_STATES: ReadonlySet<string> = new Set(['completed', 'from-sw', 'from-cache']);

/** Provenance values of an answer that is no new network exchange (5.3 `provenance`). */
const NON_NETWORK_PROVENANCE: ReadonlySet<string> = new Set(['service-worker', 'http-cache', 'memory-cache']);

/**
 * 5.3: the request left the browser (`delivery: sent`) and a network response arrived (`result: response`, or the
 * response status the recorder kept when a later body error overwrote `result`). Delivery and response are
 * independent of the final `state`: an error while reading the body does not undo a received response.
 * Service-worker or cache answers are no new network exchange; that is a fact about the ANSWER (`provenance`,
 * `state`). `fromServiceWorker` marks the INITIATOR of the request and says nothing about who answered it.
 */
export function responseReceived(r: RequestRecord): boolean {
  if (r.provenance !== undefined && NON_NETWORK_PROVENANCE.has(r.provenance)) return false;
  if (r.state === 'from-sw' || r.state === 'from-cache' || r.state === 'blocked-by-browser') return false;
  if (r.state === 'completed') return true;
  return r.delivery === 'sent' && (r.result?.kind === 'response' || typeof r.status === 'number');
}

/** The resource reached the page: a network response or an answer from the service worker or cache. */
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
  const host = snapshot.target.finalHost ?? snapshot.target.host;
  const scope = new FirstPartyScope([host, snapshot.target.host]);
  const requests: ClassifiedRequest[] = [];
  const cookies: ClassifiedCookie[] = [];
  const storage: ClassifiedStorage[] = [];
  const hints: ClassifiedHint[] = [];

  for (const phase of snapshot.browser?.phases ?? []) {
    for (const page of phase.pages) hints.push(...classifyHints(catalog, scope, phase, page));
    for (const r of phase.requests) {
      const c = classifyRequest(catalog, scope, phase, r);
      if (c) requests.push(c);
    }
    for (const ck of phase.cookies) cookies.push(classifyCookie(catalog, phase, ck));
    for (const st of phase.storage) storage.push(classifyStorage(catalog, phase, st));
  }

  const services = aggregateServices(snapshot, requests, cookies, storage);
  const ids = new Set<string>();
  for (const x of [...requests, ...cookies, ...storage, ...hints]) if (x.serviceId) ids.add(x.serviceId);
  const info: Record<string, ServiceInfo> = {};
  for (const id of [...ids].sort()) {
    const i = catalog.info(id);
    if (i) info[id] = i;
  }

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

function kindFromResourceType(resourceType: string, category: ServiceCategory): RequestKind {
  switch (resourceType) {
    case 'script':
      return 'library';
    case 'stylesheet':
      return 'stylesheet';
    case 'font':
      return 'font';
    case 'document':
      return 'embed';
    case 'image':
      if (TRACKING_CATEGORIES.has(category)) return 'hit';
      return category === 'maps' ? 'tile' : 'image';
    case 'xhr':
    case 'fetch':
    case 'ping':
    case 'beacon':
    case 'websocket':
    case 'eventsource':
      return TRACKING_CATEGORIES.has(category) ? 'hit' : 'resource';
    case 'other':
      // Chromium's catch-all (e.g. Compression Dictionary Transport) is no event transport: without a catalog
      // signature it proves a loaded resource only (03-checks §3.7 step 4).
      return 'resource';
    default:
      return 'resource';
  }
}

function stageFromKind(kind: RequestKind): TrackingStage {
  if (kind === 'hit') return 'event-sent';
  if (kind === 'config') return 'initialised';
  return 'loaded';
}

function integrationFromKind(category: ServiceCategory, kind: RequestKind): string | undefined {
  if (category !== 'maps' && category !== 'video') return undefined;
  switch (kind) {
    case 'embed':
      return 'iframe';
    case 'library':
      return 'js-api';
    case 'tile':
      return 'tiles';
    case 'image':
      return category === 'video' ? 'thumbnail' : 'static';
    default:
      return 'other';
  }
}

const GCD_DENIED = new Set(['p', 'q', 'm', 'u']);
const GCD_GRANTED = new Set(['t', 'r', 'n', 'v']);

function gcdLetter(ch: string | undefined): 'granted' | 'denied' | null {
  if (!ch) return null;
  if (GCD_DENIED.has(ch)) return 'denied';
  if (GCD_GRANTED.has(ch)) return 'granted';
  return null;
}

/**
 * Google Consent Mode state that the request transmitted (browser research §6.2):
 * `gcs=G1<ad><analytics>` (1 granted, 0 denied); `gcd=1<x><ad><x><analytics>…` with community-documented letters.
 */
export function decodeConsentMode(
  gcs: string | undefined,
  gcd: string | undefined,
): ConsentModeSignal | null {
  const m = /^G1([01-])([01-])/.exec(gcs ?? '');
  if (m) {
    const val = (c: string | undefined) => (c === '1' ? 'granted' : c === '0' ? 'denied' : null);
    return { adStorage: val(m[1]), analyticsStorage: val(m[2]), source: 'gcs' };
  }
  if (gcd && /^1[0-9a-zA-Z_-]{4,}/.test(gcd)) {
    const signal: ConsentModeSignal = {
      adStorage: gcdLetter(gcd[2]),
      analyticsStorage: gcdLetter(gcd[4]),
      source: 'gcd',
    };
    return signal.adStorage || signal.analyticsStorage ? signal : null;
  }
  return null;
}

/**
 * User or ad-click identifiers supplied with the visit or by the site (`user-supplied`): not generated per page
 * load. Names are compared lower-case with the collector's `identifierNames` (extracted before redaction).
 */
const USER_SUPPLIED_PARAMS: ReadonlySet<string> = new Set([
  'user_id',
  'userid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'fbclid',
  'ttclid',
  'li_fat_id',
]);

const PERSISTENT_KINDS: ReadonlySet<IdentifierKind> = new Set([
  'stored-match',
  'persistent-param',
  'user-supplied',
]);

/**
 * 5.3 `identifier.kind` from collector facts only. The query keys of the sanitized URL are not evidence:
 * a key survives redaction even when its value was empty, and its presence says nothing about persistence.
 */
export function identifierOf(
  catalog: ServiceCatalog,
  r: RequestRecord,
  identifierParams: readonly string[] | undefined,
): { kind: IdentifierKind; param?: string } {
  const names = r.identifierNames ?? [];
  const sentCookie = (r.sentCookieNames ?? []).find((n) => catalog.matchCookie(n, r.host)?.tracking === true);
  if (r.matchesStoredIdentifier === true) {
    const param = names.find((n) => !(r.sentCookieNames ?? []).includes(n)) ?? names[0];
    return param ? { kind: 'stored-match', param } : { kind: 'stored-match' };
  }
  if (sentCookie) return { kind: 'stored-match', param: sentCookie };
  const catalogParams = new Set((identifierParams ?? []).map((n) => n.toLowerCase()));
  const persistent = names.find((n) => catalogParams.has(n.toLowerCase()));
  if (persistent) return { kind: 'persistent-param', param: persistent };
  const supplied = names.find((n) => USER_SUPPLIED_PARAMS.has(n.toLowerCase()));
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

function classifyRequest(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  phase: PhaseRecord,
  r: RequestRecord,
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
  if (!match) return base;

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

function classifyCookie(catalog: ServiceCatalog, phase: PhaseRecord, c: CookieRecord): ClassifiedCookie {
  const domain = c.domain.replace(/^\./, '').toLowerCase();
  const named = catalog.matchCookie(c.name, domain);
  const allowCls = catalog.allowlistedCookie(c.name);
  const tracking = named?.tracking === true;
  let service: ServiceEntry | null = named?.service ?? null;
  let source: ClassificationSource = named ? 'catalog' : 'none';
  if (!service) {
    service = (!c.firstParty ? serviceByHost(catalog, domain) : null) ?? serviceByHost(catalog, c.setterHost);
    if (service) source = 'heuristic';
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
    persistent: c.lifetime.kind === 'persistent',
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

function aggregateServices(
  snapshot: Snapshot,
  requests: readonly ClassifiedRequest[],
  cookies: readonly ClassifiedCookie[],
  storage: readonly ClassifiedStorage[],
): ServiceObservation[] {
  const records = new Map<string, RequestRecord>();
  for (const p of snapshot.browser?.phases ?? []) for (const r of p.requests) records.set(r.id, r);
  const byId = new Map<string, ServiceObservation>();
  const get = (serviceId: string, category: ServiceCategory): ServiceObservation => {
    let s = byId.get(serviceId);
    if (!s) {
      s = {
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
      byId.set(serviceId, s);
    }
    return s;
  };
  const add = <T>(list: T[], v: T) => {
    if (!list.includes(v)) list.push(v);
  };

  for (const r of requests) {
    if (!r.serviceId) continue;
    const rec = records.get(r.requestId);
    const s = get(r.serviceId, r.category);
    add(s.phases, r.phase);
    if (rec) add(s.pages, rec.pageUrl);
    s.requestIds.push(r.requestId);
    if (r.timing) add(s.timings as InteractionTiming[], r.timing);
    if (r.identifier) s.identifierSeen = true;
    if (r.delivered) s.delivered = true;
    if (r.firstPartyProxy) s.firstPartyProxy = true;
    if (r.stage && rec && loaded(rec)) add(s.stages, r.stage);
  }
  for (const c of [...cookies, ...storage]) {
    if (!c.serviceId) continue;
    const s = get(c.serviceId, c.category);
    add(s.phases, c.phase);
    if ('key' in c && typeof c.key === 'object') add(s.cookieNames, c.key.name);
    if (c.timing) add(s.timings as InteractionTiming[], c.timing);
    const accepted = 'state' in c ? c.state === 'accepted' || c.state === 'sent' : true;
    if (c.tracking && accepted) add(s.stages, 'initialised');
  }
  for (const s of byId.values()) {
    s.stages.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
    s.phases.sort();
    s.pages.sort();
  }
  return [...byId.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}
