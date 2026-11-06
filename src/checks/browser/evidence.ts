/** Evidence builders for request, cookie, storage and page records, identical in every check that cites them. */
import type { EvidenceInput } from '../../core/api.ts';
import type { CookieRecord, PageVisit, RequestRecord, StorageRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest, IdentifierKind, InteractionTiming } from '../../derive/types.ts';
import { normDomain } from './snapshot.ts';

/** Evidence entries per observation are capped so a busy page does not bloat the report. */
export const MAX_EVIDENCE = 10;

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
    ...beforeClick(r),
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

/**
 * Fields in which repeats of one request differ: when and on which page it was made. The frame URL is not among them,
 * so a request repeated inside an embedded frame stays a separate item next to the same request of the page itself.
 */
const OCCURRENCE_FIELDS: ReadonlySet<string> = new Set([
  'page',
  'phase',
  'beforeClick',
  'tMs',
  'navigationId',
  'frameId',
  'actionId',
  'parentRequestId',
]);

function requestIdentity(ev: EvidenceInput): string {
  const fields = Object.entries(ev)
    .filter(([k]) => !OCCURRENCE_FIELDS.has(k))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(fields);
}

/**
 * Request evidence with every distinct request once (its first occurrence in the given order), at most `max` items.
 * The evidence is a capped sample: repeats counted in it would read as the number of requests, which the finding's
 * own params (`requestCount`, `pageCount`) state over all requests.
 */
export function distinctRequestEvidence(
  items: Iterable<{ r: RequestRecord; c: ClassifiedRequest | null | undefined }>,
  max: number = MAX_EVIDENCE,
): EvidenceInput[] {
  const seen = new Set<string>();
  const out: EvidenceInput[] = [];
  for (const { r, c } of items) {
    if (out.length >= max) break;
    const ev = requestEvidence(r, c);
    const id = requestIdentity(ev);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ev);
  }
  return out;
}

/** A request record with its classification, as the evidence builders take them. */
export type RequestItem = { r: RequestRecord; c: ClassifiedRequest | null | undefined };

/**
 * Places kept for requests after the reject: a repeat of a request seen before the interaction is then still shown
 * as made again after the reject, not only by the count in the finding's params.
 */
const AFTER_REJECT_EVIDENCE_PLACES = 3;

/** When the request was made relative to the consent click; the record decides when no classification is given. */
function momentOf({ r, c }: RequestItem): InteractionTiming {
  if (c?.timing) return c.timing;
  if (r.phase === 'A' || !r.afterClick) return 'before-interaction';
  return r.phase === 'C' ? 'after-accept' : 'after-reject';
}

/**
 * Request evidence with every distinct request once per moment (before the interaction, after the reject, after the
 * accept), at most `max` items in the given order. Up to `reserveAfterReject` of them are requests after the reject,
 * so the same URLs before the interaction cannot crowd them out; places one moment leaves free go to the other.
 */
export function requestEvidenceByMoment(
  items: Iterable<RequestItem>,
  opts: { reserveAfterReject?: number; max?: number } = {},
): EvidenceInput[] {
  const max = opts.max ?? MAX_EVIDENCE;
  const reserve = Math.min(opts.reserveAfterReject ?? AFTER_REJECT_EVIDENCE_PLACES, max);

  const seen = new Set<string>();
  const distinct: Array<{ ev: EvidenceInput; afterReject: boolean }> = [];
  for (const item of items) {
    const ev = requestEvidence(item.r, item.c);
    const moment = momentOf(item);
    const id = `${moment}\n${requestIdentity(ev)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    distinct.push({ ev, afterReject: moment === 'after-reject' });
  }

  const after = distinct.filter((d) => d.afterReject);
  const other = distinct.filter((d) => !d.afterReject);
  const afterPlaces = Math.min(after.length, Math.max(reserve, max - other.length));
  const kept = new Set([...after.slice(0, afterPlaces), ...other.slice(0, max - afterPlaces)]);
  return distinct.filter((d) => kept.has(d)).map((d) => d.ev);
}

/**
 * One request evidence item per context, a (phase, page) pair: the first request of each in the given order, at most
 * `max`. It shows where a request repeats, which the distinct requests alone do not.
 */
export function requestEvidencePerContext(
  items: Iterable<RequestItem>,
  max: number = MAX_EVIDENCE,
): EvidenceInput[] {
  const seen = new Set<string>();
  const out: EvidenceInput[] = [];
  for (const { r, c } of items) {
    if (out.length >= max) break;
    const context = `${r.phase}\n${r.pageUrl}`;
    if (seen.has(context)) continue;
    seen.add(context);
    out.push(requestEvidence(r, c));
  }
  return out;
}

/** Phases B and C start with a visit before their click: what they record then is no observation after it. */
function beforeClick(x: Pick<CookieRecord, 'phase' | 'afterClick'>): { beforeClick?: true } {
  return x.phase !== 'A' && !x.afterClick ? { beforeClick: true } : {};
}

/** Time scale and ids of a cookie/storage record (the legacy relative `tMs` is not exported). */
function observationIds(
  x: Pick<CookieRecord, 'phase' | 'afterClick' | 'atMs' | 'navigationId' | 'actionId'>,
) {
  return {
    ...beforeClick(x),
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
