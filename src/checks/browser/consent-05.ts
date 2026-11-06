/**
 * CONSENT-05: tracking after a technically confirmed reject. The reject is confirmed by CMP state only, never by
 * network silence (`verify`, our click's state, a persisted reject after reload); else `reject-not-confirmed`.
 */
import type { CmpPhaseFacts, CmpSection, ConsentStateFact } from '../../cmp/types.ts';
import {
  type CheckOutcome,
  defineCheck,
  type EvidenceInput,
  isCookieHeld,
  type Observation,
  subjects,
} from '../../core/api.ts';
import type { BrowserSection, RequestRecord } from '../../core/snapshot/browser.ts';
import type {
  ClassifiedCookie,
  ClassifiedRequest,
  ClassifiedStorage,
  DerivedSection,
} from '../../derive/types.ts';
import { cookieEvidence, distinctRequestEvidence, MAX_EVIDENCE, storageEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields, serviceName, TRACKING_CATEGORIES } from './services.ts';
import {
  allCmpFacts,
  bannerFound,
  bannerUndetermined,
  consentSignals,
  persistentIdentifier,
  signalOutcome,
  unrecognizedBanner,
} from './signals.ts';
import { classifiedCookies, classifiedStorage, phaseRecord, requestIndex } from './snapshot.ts';

const ID = 'CONSENT-05';

/** Strongest first; one finding per service. */
const RANK = ['tracking-after-reject', 'cookieless-ping-after-reject', 'connect-only-after-reject'] as const;
type Variant = (typeof RANK)[number];

interface Group {
  subject: string;
  variant: Variant;
  /** `tracking-after-reject` branch: a request with a persistent identifier or an accepted storage write. */
  kind: 'request' | 'storage';
  serviceId: string | null;
  etld1: string | null;
  category: string;
  pages: Set<string>;
  /** Tracking hits; their evidence is the distinct requests among them. */
  requests: Array<{ r: RequestRecord; c: ClassifiedRequest }>;
  /** Storage writes, at most `MAX_EVIDENCE`. */
  evidence: EvidenceInput[];
  names: Set<string>;
  consentModeDenied: boolean;
}

/** A persistent identifier as in CONSENT-01; a cookieless, per-load or anonymous hit → warning. */
const requestVariant = (c: ClassifiedRequest): Variant =>
  persistentIdentifier(c) ? 'tracking-after-reject' : 'cookieless-ping-after-reject';

const decisionRecorded = (s: ConsentStateFact) => s.decision?.responded !== false;

/** The ready states proving the reject: produced by our click and read back after the reload. */
function confirmedReject(
  b: CmpPhaseFacts | undefined,
): { action: ConsentStateFact; stored: ConsentStateFact } | null {
  const v = b?.verify;
  if (v?.action !== 'reject' || !v.verified || v.persistedAfterReload !== true) return null;
  const ready = (s: ConsentStateFact) => s.ready === 'ready' && decisionRecorded(s);
  const action = v.stateAfter.find((s) => ready(s) && s.origin === 'action');
  const afterReload = (b?.facts ?? []).filter((f) => f.moment === 'after-reload').flatMap((f) => f.state);
  const stored = [...v.stateAfter, ...afterReload].find((s) => ready(s) && s.origin === 'stored');
  return action && stored ? { action, stored } : null;
}

function stateEvidence(s: ConsentStateFact, page: string | null): EvidenceInput {
  return {
    type: 'consent-state',
    source: s.source,
    ready: s.ready,
    categories: s.categories,
    origin: s.origin,
    phase: 'B',
    ...(page ? { page } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
  };
}

type Groups = Map<string, Group>;

/**
 * The group of a service or third party. A stronger variant replaces a weaker one; at the same strength a request
 * replaces a storage write as the kind.
 */
function groupFor(
  groups: Groups,
  variant: Variant,
  kind: Group['kind'],
  cls: ClassifiedRequest | ClassifiedCookie | ClassifiedStorage,
  etld1: string | null,
): Group {
  const subject = subjects.service(cls.serviceId, etld1);
  const g = groups.get(subject);
  if (!g) {
    const created: Group = {
      subject,
      variant,
      kind,
      serviceId: cls.serviceId,
      etld1,
      category: cls.category,
      pages: new Set(),
      requests: [],
      evidence: [],
      names: new Set(),
      consentModeDenied: false,
    };
    groups.set(subject, created);
    return created;
  }

  if (RANK.indexOf(variant) < RANK.indexOf(g.variant)) {
    g.variant = variant;
    g.kind = kind;
  } else if (variant === g.variant && kind === 'request') {
    g.kind = kind;
  }
  return g;
}

/** Tracking hits delivered after the reject. */
function addRequestHits(groups: Groups, derived: DerivedSection, records: Map<string, RequestRecord>): void {
  for (const c of derived.requests) {
    if (c.phase !== 'B' || c.timing !== 'after-reject') continue;
    if (!TRACKING_CATEGORIES.has(c.category) || !c.delivered || c.kind !== 'hit') continue;
    const r = records.get(c.requestId);
    if (!r) continue;

    const g = groupFor(groups, requestVariant(c), 'request', c, c.etld1);
    g.pages.add(r.pageUrl);
    if (c.cookieless) g.consentModeDenied = true;
    g.requests.push({ r, c });
  }
}

/** Tracking cookies and storage entries written after the reject. */
function addStorageWrites(groups: Groups, browser: BrowserSection, derived: DerivedSection): void {
  const stored = [
    ...classifiedCookies(browser, derived).map((x) => ({
      ...x,
      name: x.record.name,
      ev: cookieEvidence(x.record),
    })),
    ...classifiedStorage(browser, derived).map((x) => ({
      ...x,
      name: x.record.key,
      ev: storageEvidence(x.record),
    })),
  ];

  for (const s of stored) {
    if (s.record.phase !== 'B' || s.cls.timing !== 'after-reject' || !s.cls.tracking) continue;
    // Only a write the browser accepted is a storage event; attempts and rejected Set-Cookies are not.
    if ('state' in s.record && !isCookieHeld(s.record.state)) continue;

    const g = groupFor(groups, 'tracking-after-reject', 'storage', s.cls, s.cls.etld1 ?? null);
    g.pages.add(s.record.pageUrl);
    g.names.add(s.name);
    if (g.evidence.length < MAX_EVIDENCE) g.evidence.push(s.ev);
  }
}

/** Storage writes keep this many evidence places next to many requests, so the excerpt still shows them. */
const STORAGE_EVIDENCE_PLACES = 3;

/** The distinct requests first, then the storage writes, at most `MAX_EVIDENCE` of both; the reject proof always. */
function groupEvidence(g: Group, rejectEvidence: EvidenceInput[]): EvidenceInput[] {
  const writes = g.evidence.slice(0, STORAGE_EVIDENCE_PLACES);
  const requests = distinctRequestEvidence(g.requests, MAX_EVIDENCE - writes.length);
  return [...requests, ...g.evidence.slice(0, MAX_EVIDENCE - requests.length), ...rejectEvidence];
}

/** A group with requests and storage writes of a persistent identifier names both in its text. */
const groupKind = (g: Group): 'request' | 'storage' | 'both' =>
  g.variant === 'tracking-after-reject' && g.kind === 'request' && g.names.size > 0 ? 'both' : g.kind;

/**
 * Requests with a persistent identifier first, otherwise in their order. They make the group `tracking-after-reject`,
 * so the host the text names and the capped evidence come from them, not from a cookieless hit of the same service.
 */
const persistentFirst = (requests: Group['requests']): Group['requests'] =>
  [...requests].sort((a, b) => Number(persistentIdentifier(b.c)) - Number(persistentIdentifier(a.c)));

function groupObservations(
  groups: Groups,
  derived: DerivedSection,
  rejectEvidence: EvidenceInput[],
): Observation[] {
  return [...groups.values()]
    .sort((a, b) => a.subject.localeCompare(b.subject))
    .map((g) => ({ ...g, requests: persistentFirst(g.requests) }))
    .map((g) => ({
      checkId: ID,
      variant: g.variant,
      confidence: 'high',
      subject: g.subject,
      category: g.category,
      phases: ['B'],
      pages: [...g.pages].sort(),
      evidence: groupEvidence(g, rejectEvidence),
      params: {
        kind: groupKind(g),
        service: serviceName(derived, g.serviceId, g.etld1),
        name: sortedUniq(g.names).join(', ') || null,
        host: g.requests[0]?.c.host ?? null,
        pageCount: g.pages.size,
        consentModeDenied: g.consentModeDenied,
        requestCount: g.requests.length,
      },
      ...serviceFields(derived, g.serviceId),
    }));
}

/**
 * The reject is a basis for the evaluation only when phase B ran, our click rejected and the CMP state confirms it;
 * otherwise the outcome says why not.
 */
function rejectBasis(
  browser: BrowserSection,
  cmp: CmpSection,
  minCandidatePages: number,
):
  | { outcome: CheckOutcome }
  | { phaseB: NonNullable<ReturnType<typeof phaseRecord>>; rejectEvidence: EvidenceInput[] } {
  const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
  if (signal) return { outcome: signal };
  // No banner on any page: there is no reject to evaluate, as CONSENT-04 reports for the dialog. A banner observed but
  // not recognised was not clicked, so the reject is open, not absent; so is it where the banner stays undetermined.
  if (allCmpFacts(cmp).length > 0 && !bannerFound(cmp)) {
    const outcome: CheckOutcome = unrecognizedBanner(cmp, browser, minCandidatePages)
      ? { status: 'inconclusive', reason: 'banner-not-recognized', observations: [] }
      : bannerUndetermined(cmp, browser, minCandidatePages)
        ? { status: 'inconclusive', reason: 'banner-undetermined', observations: [] }
        : { status: 'not_applicable', reason: 'no-banner', observations: [] };
    return { outcome };
  }

  const phaseB = phaseRecord(browser, 'B');
  if (!phaseB || phaseB.status === 'skipped') {
    return {
      outcome: { status: 'inconclusive', reason: phaseB?.reason ?? 'phase-b-missing', observations: [] },
    };
  }

  const cmpB = cmp.phases.find((p) => p.phase === 'B');
  const click = cmpB?.click;
  if (click?.action !== 'reject' || !click.clicked) {
    return { outcome: { status: 'inconclusive', reason: 'no-reject-click', observations: [] } };
  }

  const confirmed = confirmedReject(cmpB);
  if (!confirmed)
    return { outcome: { status: 'inconclusive', reason: 'reject-not-confirmed', observations: [] } };

  const rejectEvidence = [
    stateEvidence(confirmed.action, phaseB.click?.pageUrl ?? null),
    stateEvidence(confirmed.stored, phaseB.pages.find((p) => p.reload)?.finalUrl ?? null),
  ];
  return { phaseB, rejectEvidence };
}

export const consent05 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  // `connect-only-after-reject` needs the proxy CONNECT log (in-process egress proxy, not in the prototype).
  variants: RANK.map((variant) => ({ variant, variantGroup: 'after-reject' })),
  run({ browser, cmp, derived }, ctx) {
    const basis = rejectBasis(browser, cmp, ctx.thresholds.cmp.minCandidatePages);
    if ('outcome' in basis) return basis.outcome;
    const { phaseB, rejectEvidence } = basis;

    const groups: Groups = new Map();
    addRequestHits(groups, derived, requestIndex(browser));
    addStorageWrites(groups, browser, derived);
    const observations = groupObservations(groups, derived, rejectEvidence);

    const afterPages = phaseB.pages.filter((p) => p.reload || p.role !== 'start' || p.order > 0);
    const coverage = {
      observed: phaseB.pages.length,
      evaluated: afterPages.filter((p) => p.evaluable).length,
    };

    // Without the page-exit capture the evaluation after the reject is not conclusive, even with findings; they still gate.
    if (browser.knownGaps.includes('pagehide-beacons')) {
      return {
        status: 'inconclusive',
        reason: 'pagehide-capture-unavailable',
        observations,
        limitations: ['pagehide-capture-unavailable'],
        coverage,
      };
    }
    return { status: 'completed', observations, limitations: [], coverage };
  },
});
