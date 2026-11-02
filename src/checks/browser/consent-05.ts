/**
 * CONSENT-05 (P1 → release): tracking after a technically confirmed reject (phase B, requests started after the
 * click on the reload and control pages). The reject is confirmed by CMP state only, never by network silence
 * (03-checks §4 steps 3–4): `verify` confirms the reject, a ready state produced by our click
 * (`origin: action`, decision not refused), the reload ran and the reject persisted (`persistedAfterReload: true`)
 * and a ready `stored` state was read after it. Anything less → inconclusive `reject-not-confirmed`.
 * Analytics/ads hits with a persistent identifier (as in CONSENT-01) and tracking cookies/storage accepted after the
 * click → `tracking-after-reject`; Consent Mode denied pings and hits without an evidenced persistent identifier →
 * `cookieless-ping-after-reject`. No pagehide/keepalive capture → inconclusive `pagehide-capture-unavailable`
 * (03-checks §4 step 10); established findings are kept and still gate.
 */
import type { CmpPhaseFacts, ConsentStateFact } from '../../cmp/types.ts';
import type { RequestRecord } from '../../collectors/browser/types.ts';
import { defineCheck, type EvidenceInput, type Observation, subjects } from '../../core/api.ts';
import type { ClassifiedCookie, ClassifiedRequest, ClassifiedStorage } from '../../derive/types.ts';
import {
  classifiedCookies,
  classifiedStorage,
  consentSignals,
  cookieEvidence,
  MAX_EVIDENCE,
  persistentIdentifier,
  phaseRecord,
  requestEvidence,
  requestIndex,
  serviceFields,
  serviceName,
  signalOutcome,
  sortedUniq,
  storageEvidence,
  TRACKING_CATEGORIES,
} from './shared.ts';

const ID = 'CONSENT-05';

/** Strongest first; one finding per service (03-checks §4: `tracking-after-reject` selects request/storage). */
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
  evidence: EvidenceInput[];
  names: Set<string>;
  host: string | null;
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

export const consent05 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'cmp', 'derived'],
  // `connect-only-after-reject` needs the proxy CONNECT log (in-process egress proxy, not in the prototype).
  variants: RANK.map((variant) => ({ variant, variantGroup: 'after-reject' })),
  run({ browser, cmp, derived }) {
    const signal = signalOutcome(ID, consentSignals(cmp, ['A', 'B']));
    if (signal) return signal;
    const phaseB = phaseRecord(browser, 'B');
    if (!phaseB || phaseB.status === 'skipped') {
      return { status: 'inconclusive', reason: phaseB?.reason ?? 'phase-b-missing', observations: [] };
    }
    const cmpB = cmp.phases.find((p) => p.phase === 'B');
    const click = cmpB?.click;
    if (click?.action !== 'reject' || !click.clicked) {
      return { status: 'inconclusive', reason: 'no-reject-click', observations: [] };
    }
    const confirmed = confirmedReject(cmpB);
    if (!confirmed) return { status: 'inconclusive', reason: 'reject-not-confirmed', observations: [] };
    const rejectEvidence = [
      stateEvidence(confirmed.action, phaseB.click?.pageUrl ?? null),
      stateEvidence(confirmed.stored, phaseB.pages.find((p) => p.reload)?.finalUrl ?? null),
    ];

    const records = requestIndex(browser);
    const groups = new Map<string, Group>();
    const group = (
      variant: Variant,
      kind: Group['kind'],
      cls: ClassifiedRequest | ClassifiedCookie | ClassifiedStorage,
      etld1: string | null,
    ) => {
      const subject = subjects.service(cls.serviceId, etld1);
      let g = groups.get(subject);
      if (!g) {
        g = {
          subject,
          variant,
          kind,
          serviceId: cls.serviceId,
          etld1,
          category: cls.category,
          pages: new Set(),
          evidence: [],
          names: new Set(),
          host: null,
          consentModeDenied: false,
        };
        groups.set(subject, g);
      } else if (RANK.indexOf(variant) < RANK.indexOf(g.variant)) {
        g.variant = variant;
        g.kind = kind;
      } else if (variant === g.variant && kind === 'request') g.kind = kind;
      return g;
    };

    for (const c of derived.requests) {
      if (c.phase !== 'B' || c.timing !== 'after-reject') continue;
      if (!TRACKING_CATEGORIES.has(c.category) || !c.delivered || c.kind !== 'hit') continue;
      const r: RequestRecord | undefined = records.get(c.requestId);
      if (!r) continue;
      const g = group(requestVariant(c), 'request', c, c.etld1);
      g.pages.add(r.pageUrl);
      g.host ??= c.host;
      if (c.cookieless) g.consentModeDenied = true;
      if (g.evidence.length < MAX_EVIDENCE) g.evidence.push(requestEvidence(r, c));
    }
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
      if ('state' in s.record && s.record.state !== 'accepted' && s.record.state !== 'sent') continue;
      const g = group('tracking-after-reject', 'storage', s.cls, s.cls.etld1 ?? null);
      g.pages.add(s.record.pageUrl);
      g.names.add(s.name);
      if (g.evidence.length < MAX_EVIDENCE) g.evidence.push(s.ev);
    }

    const observations: Observation[] = [...groups.values()]
      .sort((a, b) => a.subject.localeCompare(b.subject))
      .map((g) => ({
        checkId: ID,
        variant: g.variant,
        confidence: 'high',
        subject: g.subject,
        category: g.category,
        phases: ['B'],
        pages: [...g.pages].sort(),
        evidence: [...g.evidence, ...rejectEvidence],
        params: {
          kind: g.kind,
          service: serviceName(derived, g.serviceId, g.etld1),
          name: sortedUniq(g.names).join(', ') || null,
          host: g.host,
          pageCount: g.pages.size,
          consentModeDenied: g.consentModeDenied,
        },
        ...serviceFields(derived, g.serviceId),
      }));

    const afterPages = phaseB.pages.filter((p) => p.reload || p.role !== 'start' || p.order > 0);
    const coverage = {
      observed: phaseB.pages.length,
      evaluated: afterPages.filter((p) => p.evaluable).length,
    };
    // 03-checks §4 step 10: without the page-exit capture the evaluation after the reject is not conclusive, also
    // when findings exist (a beacon could carry a stronger observation); the established findings still gate.
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
