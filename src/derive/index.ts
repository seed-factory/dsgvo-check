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
import { registrableDomain } from '../core/url/url.ts';
import { loadServiceCatalog, type ServiceCatalog, type ServiceEntry } from './catalog.ts';
import { FirstPartyScope, parseHttpUrl, timingOf } from './context.ts';
import { classifyRequests, requestLoaded } from './requests.ts';
import type {
  ClassificationSource,
  ClassifiedCookie,
  ClassifiedFrame,
  ClassifiedHint,
  ClassifiedRequest,
  ClassifiedStorage,
  DerivedSection,
  InteractionTiming,
  ServiceCategory,
  ServiceInfo,
  ServiceName,
  ServiceObservation,
  TrackingStage,
} from './types.ts';

export { loadServiceCatalog, ServiceCatalog } from './catalog.ts';
export { timingOf } from './context.ts';
export {
  decodeConsentMode,
  identifierOf,
  integrationFromKind,
  kindFromResourceType,
  responseReceived,
  stageFromKind,
} from './requests.ts';
export type * from './types.ts';

export interface DeriveOptions {
  /** Pre-loaded catalog (tests); default: test/data/services from `dataDir` or the package data. */
  catalog?: ServiceCatalog;
  dataDir?: string;
  /** Days a cookie must live to count as persistent; a shorter one is like a session cookie (`browser.persistentCookieMinDays`). */
  persistentCookieMinDays?: number;
}

const STAGE_ORDER: readonly TrackingStage[] = ['loaded', 'initialised', 'event-sent'];

export function derive(snapshot: Snapshot, opts: DeriveOptions = {}): DerivedSection {
  const catalog = opts.catalog ?? loadServiceCatalog(opts.dataDir);
  const minDays = opts.persistentCookieMinDays ?? DEFAULT_CONFIG.browser.persistentCookieMinDays;
  const host = snapshot.target.finalHost ?? snapshot.target.host;
  const scope = new FirstPartyScope([host, snapshot.target.host]);

  const requests: ClassifiedRequest[] = [];
  const cookies: ClassifiedCookie[] = [];
  const storage: ClassifiedStorage[] = [];
  const hints: ClassifiedHint[] = [];
  const frames: ClassifiedFrame[] = [];
  const stored: StoredEntry[] = [];
  for (const phase of snapshot.browser?.phases ?? []) {
    for (const page of phase.pages) {
      hints.push(...classifyHints(catalog, scope, phase, page));
      frames.push(...classifyFrames(catalog, scope, phase, page));
    }
    for (const request of classifyRequests(catalog, scope, phase)) requests.push(request);
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
    serviceNames: serviceNames(catalog),
    hints,
    frames,
    firstPartyEtld1s: [...scope.etld1s].sort(),
    allowlistVersion: catalog.allowlistVersion,
  };
}

/**
 * Catalog entries of every service that appears in the classified facts, ordered by id. The service of an embed's
 * frame resource counts too: a finding about the fonts of a map frame names Google Fonts with its provider.
 */
function serviceInfoFor(
  catalog: ServiceCatalog,
  facts: readonly { serviceId: string | null; resourceServiceId?: string }[],
): Record<string, ServiceInfo> {
  const ids = new Set<string>();
  for (const x of facts) {
    if (x.serviceId) ids.add(x.serviceId);
    if (x.resourceServiceId) ids.add(x.resourceServiceId);
  }

  const info: Record<string, ServiceInfo> = {};
  for (const id of [...ids].sort()) {
    const entry = catalog.info(id);
    if (entry) info[id] = entry;
  }
  return info;
}

/** The names of every catalog service a policy is expected to mention (policy relevance other than `none`). */
function serviceNames(catalog: ServiceCatalog): ServiceName[] {
  const out: ServiceName[] = [];
  for (const id of [...catalog.byId.keys()].sort()) {
    const info = catalog.info(id);
    if (!info || info.policyRelevance === 'none') continue;
    const name: ServiceName = {
      serviceId: info.serviceId,
      name: info.name,
      category: info.category,
      aliases: [...new Set([...(info.aliasesDe ?? []), ...(info.aliasesEn ?? [])])],
      companyAliases: info.companyAliases ?? [],
    };
    if (info.provider) name.provider = info.provider;
    if (info.parent) name.parent = info.parent;
    out.push(name);
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

function classifyFrames(
  catalog: ServiceCatalog,
  scope: FirstPartyScope,
  phase: PhaseRecord,
  page: PageVisit,
): ClassifiedFrame[] {
  const out: ClassifiedFrame[] = [];
  for (const f of page.dom?.iframes ?? []) {
    const url = f.src ? parseHttpUrl(f.src) : null;
    if (!url || !f.src) continue;
    const m = catalog.matchUrl(url);
    out.push({
      phase: phase.phase,
      pageUrl: page.finalUrl || page.url,
      src: f.src,
      thirdParty: !scope.has(url.hostname),
      serviceId: m?.service.id ?? null,
      category: m?.service.category ?? 'unknown',
    });
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
  const name = (a.parent ?? a.provider)?.name;
  return name != null && name === (b.parent ?? b.provider)?.name;
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
    if (r.stage && rec && requestLoaded(rec)) addUnique(s.stages, r.stage);
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
