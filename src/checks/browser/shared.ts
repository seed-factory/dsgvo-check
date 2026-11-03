/** Pure helpers shared by the browser checks: signals, evidence builders and record/classification lookups. */
import type { BotSignal, CmpFacts, CmpSection, GeoSignal } from '../../cmp/types.ts';
import type { BrowserPhase, CheckOutcome, EvidenceInput, Observation } from '../../core/api.ts';
import type {
  BrowserSection,
  CookieRecord,
  DocumentRecord,
  DocumentsSection,
  PageVisit,
  RequestRecord,
  StorageRecord,
} from '../../core/snapshot/browser.ts';
import type {
  ClassifiedCookie,
  ClassifiedRequest,
  ClassifiedStorage,
  DerivedSection,
  IdentifierKind,
  ServiceCategory,
  ServiceInfo,
} from '../../derive/types.ts';

export const TRACKING_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  'analytics',
  'ads',
  'session-recording',
]);
export const MAX_EVIDENCE = 10;

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function sortedUniq(xs: Iterable<string>): string[] {
  return uniq(xs).sort();
}

/**
 * A hit carries a persistent identifier: stored tracking data or a user/click id holds even under Consent Mode
 * `denied`; a catalog identifier param counts only when the hit is not a denied (cookieless) ping.
 */
export function persistentIdentifier(c: ClassifiedRequest): boolean {
  const kind = c.identifierKind ?? 'none';
  if (kind === 'stored-match' || kind === 'user-supplied') return true;
  return kind === 'persistent-param' && c.cookieless !== true;
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

export function allCmpFacts(cmp: CmpSection): CmpFacts[] {
  return cmp.phases.flatMap((p) => p.facts);
}

export function requestIndex(browser: BrowserSection): Map<string, RequestRecord> {
  const out = new Map<string, RequestRecord>();
  for (const p of browser.phases) for (const r of p.requests) out.set(r.id, r);
  return out;
}

export function phaseRecord(browser: BrowserSection, phase: BrowserPhase) {
  return browser.phases.find((p) => p.phase === phase);
}

/** Phase A has an evaluable page; a lone 429/503 or challenge page is no observation. */
export function hasPhaseA(browser: BrowserSection): boolean {
  const a = phaseRecord(browser, 'A');
  return !!a && a.status !== 'skipped' && a.pages.some((p) => p.evaluable);
}

/** Reason for a missing phase-A basis: `throttled` when the collector stopped on 429/503, else `fallback`. */
export function noPhaseAReason(browser: BrowserSection, fallback: string): string {
  return phaseRecord(browser, 'A')?.reason === 'throttled' ? 'throttled' : fallback;
}

/** Throttling stopped navigations in one of `phases`: `completed` becomes `partial` with limitation `throttled`. */
export function throttleAware(
  browser: BrowserSection,
  outcome: CheckOutcome,
  phases: readonly BrowserPhase[] = ['A', 'B', 'C'],
): CheckOutcome {
  const throttled = browser.phases.some((p) => phases.includes(p.phase) && p.reason === 'throttled');
  if (!throttled || outcome.status !== 'completed') return outcome;
  return {
    ...outcome,
    status: 'partial',
    limitations: sortedUniq([...(outcome.limitations ?? []), 'throttled']),
  };
}

export function startPageUrl(browser: BrowserSection): string | null {
  const a = phaseRecord(browser, 'A');
  const start = a?.pages.find((p) => p.role === 'start') ?? a?.pages[0];
  return start?.finalUrl ?? start?.url ?? null;
}

function normDomain(d: string): string {
  return d.replace(/^\./, '').toLowerCase();
}

function cookieKey(
  phase: string,
  name: string,
  domain: string,
  path: string,
  pk: string | null,
  state: string,
  after: boolean,
) {
  return [phase, name, normDomain(domain), path, pk ?? '', state, after].join('|');
}

/** Pairs cookie records with their classification (one per record). */
export function classifiedCookies(
  browser: BrowserSection,
  derived: DerivedSection,
): Array<{ record: CookieRecord; cls: ClassifiedCookie }> {
  const byKey = new Map<string, ClassifiedCookie>();
  for (const c of derived.cookies) {
    byKey.set(
      cookieKey(c.phase, c.key.name, c.key.domain, c.key.path, c.key.partitionKey, c.state, c.afterClick),
      c,
    );
  }
  const out: Array<{ record: CookieRecord; cls: ClassifiedCookie }> = [];
  for (const p of browser.phases) {
    for (const record of p.cookies) {
      const cls = byKey.get(
        cookieKey(
          record.phase,
          record.name,
          record.domain,
          record.path,
          record.partitionKey,
          record.state,
          record.afterClick,
        ),
      );
      if (cls) out.push({ record, cls });
    }
  }
  return out;
}

export function classifiedStorage(
  browser: BrowserSection,
  derived: DerivedSection,
): Array<{ record: StorageRecord; cls: ClassifiedStorage }> {
  const key = (phase: string, type: string, origin: string, k: string, after: boolean) =>
    [phase, type, origin, k, after].join('|');
  const byKey = new Map<string, ClassifiedStorage>();
  for (const s of derived.storage) byKey.set(key(s.phase, s.storageType, s.origin, s.key, s.afterClick), s);
  const out: Array<{ record: StorageRecord; cls: ClassifiedStorage }> = [];
  for (const p of browser.phases) {
    for (const record of p.storage) {
      const cls = byKey.get(
        key(record.phase, record.storageType, record.origin, record.key, record.afterClick),
      );
      if (cls) out.push({ record, cls });
    }
  }
  return out;
}

/** Pages visited in phases A and B (deduplicated by final URL, phase A first). */
export function visitedPages(
  browser: BrowserSection,
  phases: readonly BrowserPhase[] = ['A', 'B'],
): PageVisit[] {
  const seen = new Set<string>();
  const out: PageVisit[] = [];
  for (const ph of phases) {
    for (const p of phaseRecord(browser, ph)?.pages ?? []) {
      const key = p.finalUrl || p.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** Errors by which the collector marks a fetched page as not being the legal document. */
const NOT_A_DOCUMENT: ReadonlySet<string> = new Set(['soft-404', 'keyword-missing', 'unconfirmed']);

/** The probe's page was judged an error page (`soft-404`) or not confirmed as the document. */
export function judgedNotDocument(a: DocumentsSection['attempts'][number]): boolean {
  return a.outcome === 'soft-404' || a.outcome === 'unconfirmed';
}

/**
 * 2xx and not judged "no document" by the collector, neither on the document nor on the attempt that fetched it.
 * A linked PDF counts even when it was not fetched (status null).
 */
export function usableDocument(d: DocumentRecord, attempts: DocumentsSection['attempts']): boolean {
  if (d.errors.some((e) => NOT_A_DOCUMENT.has(e))) return false;
  const judgedNot = attempts.some(
    (a) => a.kind === d.kind && judgedNotDocument(a) && (a.url === d.url || a.url === d.finalUrl),
  );
  if (judgedNot) return false;
  if (d.status === null) return d.format === 'pdf';
  return d.status >= 200 && d.status < 300;
}

export function serviceInfo(derived: DerivedSection, serviceId: string | null): ServiceInfo | null {
  return serviceId ? (derived.catalog[serviceId] ?? null) : null;
}

/** Display name: catalog name, else the third party's registrable domain. */
export function serviceName(
  derived: DerivedSection,
  serviceId: string | null,
  etld1?: string | null,
): string {
  return serviceInfo(derived, serviceId)?.name ?? etld1 ?? 'unknown';
}

/** Observation fields carrying the catalog attribution (never a finding about a transfer). */
export function serviceFields(
  derived: DerivedSection,
  serviceId: string | null,
): Pick<Observation, 'serviceId' | 'provider' | 'parent' | 'dpfEntity' | 'classification'> {
  const info = serviceInfo(derived, serviceId);
  const out: Pick<Observation, 'serviceId' | 'provider' | 'parent' | 'dpfEntity' | 'classification'> = {
    classification: info
      ? { source: 'catalog', datasetVersion: derived.catalogVersion }
      : { source: 'none', datasetVersion: derived.catalogVersion },
  };
  if (!info) return out;
  out.serviceId = info.serviceId;
  if (info.provider) out.provider = info.provider;
  if (info.parent) out.parent = info.parent;
  if (info.dpfEntity) out.dpfEntity = info.dpfEntity;
  return out;
}

/** Parser version of snapshots written before the collector recorded one. */
const LEGACY_PARSER_VERSION = 'request-features/1';

type RequestDelivery = NonNullable<RequestRecord['delivery']>;
type RequestResult = NonNullable<RequestRecord['result']>;

/** Delivery of a record that has only the legacy `state`; any other state means the request did not get that far. */
const LEGACY_STATE_DELIVERY: ReadonlyMap<RequestRecord['state'], RequestDelivery> = new Map([
  ['blocked-by-browser', 'blocked-by-browser'],
  ['completed', 'sent'],
  ['from-sw', 'sent'],
  ['from-cache', 'sent'],
]);

/** `delivery` / `result` of a record; older snapshots without them are mapped from the legacy `state`. */
function deliveryAndResult(r: RequestRecord): { delivery: RequestDelivery; result: RequestResult } {
  const delivery: RequestDelivery = r.delivery ?? LEGACY_STATE_DELIVERY.get(r.state) ?? 'attempted';
  const result: RequestResult =
    r.result ??
    (r.status !== undefined
      ? { kind: 'response', status: r.status }
      : r.failureText && r.state !== 'blocked-by-browser'
        ? { kind: 'failed', errorText: r.failureText }
        : { kind: 'none' });
  return { delivery, result };
}

/** Identifier kind without a classification: only what the collector recorded. */
function unclassifiedIdentifier(r: RequestRecord): { kind: IdentifierKind; param?: string } {
  const param = r.identifierNames?.[0];
  if (r.matchesStoredIdentifier === true)
    return param ? { kind: 'stored-match', param } : { kind: 'stored-match' };
  if (r.identifierPresent || param) return param ? { kind: 'per-load', param } : { kind: 'per-load' };
  return { kind: 'none' };
}

/**
 * `request` evidence: a pure function of the record and its classification, so a request gives the same evidence (and
 * evidence id) in every check. Times relative to navigation or click follow from `tMs` and the ids, so are not stored.
 */
export function requestEvidence(r: RequestRecord, c: ClassifiedRequest | null | undefined): EvidenceInput {
  const identifier = c?.identifierKind
    ? { kind: c.identifierKind, ...(c.identifierParam ? { param: c.identifierParam } : {}) }
    : unclassifiedIdentifier(r);
  const signals = r.consentSignals ?? {};
  const consentSignal = {
    ...(signals.gcs ? { gcs: signals.gcs } : {}),
    ...(signals.gcd ? { gcd: signals.gcd } : {}),
    ...(signals.npa ? { npa: signals.npa } : {}),
    ...(signals.dma ? { dma: signals.dma } : {}),
    ...(c?.consentMode
      ? { adStorage: c.consentMode.adStorage, analyticsStorage: c.consentMode.analyticsStorage }
      : {}),
  };
  const ev: EvidenceInput = {
    type: 'request',
    url: r.url,
    method: r.method,
    resourceType: r.resourceType,
    phase: r.phase,
    page: r.pageUrl,
    ...(r.atMs !== undefined ? { tMs: r.atMs } : {}),
    ...(r.navigationId ? { navigationId: r.navigationId } : {}),
    ...(r.actionId ? { actionId: r.actionId } : {}),
    ...(r.frameId ? { frameId: r.frameId } : {}),
    ...(r.parentRequestId ? { parentRequestId: r.parentRequestId } : {}),
    ...deliveryAndResult(r),
    ...(r.provenance ? { provenance: r.provenance } : {}),
    features: {
      identifier,
      matchesStoredIdentifier: r.matchesStoredIdentifier === true,
      ...(r.eventType ? { eventType: r.eventType } : {}),
      ...(Object.keys(consentSignal).length > 0 ? { consentSignal } : {}),
      parserVersion: r.parserVersion ?? LEGACY_PARSER_VERSION,
      observationSource: r.observationSource ?? 'playwright',
    },
    thirdPartyETLD1: c?.thirdParty ? c.etld1 : null,
    ...(c?.serviceId ? { serviceId: c.serviceId } : {}),
  };
  if (r.initiator && (r.initiator.type || r.initiator.url)) {
    ev.initiator = {
      ...(r.initiator.type ? { type: r.initiator.type } : {}),
      ...(r.initiator.url ? { url: r.initiator.url } : {}),
    };
  }
  if (r.frameUrl) ev.frameUrl = r.frameUrl;
  if (r.connectedIp) ev.connectedIp = r.connectedIp;
  return ev;
}

/** Time scale and ids of a cookie/storage record (the legacy relative `tMs` is not exported). */
function observationIds(x: Pick<CookieRecord, 'atMs' | 'navigationId' | 'actionId'>) {
  return {
    ...(x.atMs !== undefined ? { tMs: x.atMs } : {}),
    ...(x.navigationId ? { navigationId: x.navigationId } : {}),
    ...(x.actionId ? { actionId: x.actionId } : {}),
  };
}

export function cookieEvidence(c: CookieRecord): EvidenceInput {
  const ev: EvidenceInput = {
    type: 'cookie',
    name: c.name,
    domain: c.firstParty ? 'first-party' : normDomain(c.domain),
    path: c.path,
    partitionKey: c.partitionKey,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    lifetime: c.lifetime,
    length: c.length,
    setter: c.setter,
    state: c.state,
    phase: c.phase,
    page: c.pageUrl,
  };
  if (c.setterHost) ev.setterHost = c.setterHost;
  Object.assign(ev, observationIds(c));
  return ev;
}

export function storageEvidence(s: StorageRecord): EvidenceInput {
  const ev: EvidenceInput = {
    type: 'storage',
    storageType: s.storageType,
    origin: s.origin,
    key: s.key,
    firstParty: s.firstParty,
    phase: s.phase,
    page: s.pageUrl,
  };
  if (s.length !== undefined) ev.length = s.length;
  Object.assign(ev, observationIds(s));
  return ev;
}

export function pageEvidence(p: PageVisit): EvidenceInput {
  const ev: EvidenceInput = {
    type: 'page',
    url: p.finalUrl || p.url,
    status: p.navigation.status,
    role: p.role,
    evaluable: p.evaluable,
    phase: p.phase,
  };
  if (p.notEvaluableReason) ev.reason = p.notEvaluableReason;
  return ev;
}
