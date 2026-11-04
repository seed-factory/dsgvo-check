/** TRACK-01 (P0): inventory of tracking services by stage and timing; `info` only, gating belongs to the related CONSENT finding. */

import {
  defineCheck,
  type EvidenceInput,
  isCookieHeld,
  type Observation,
  type Phase,
  subjects,
} from '../../core/api.ts';
import type { BrowserSection, RequestRecord } from '../../core/snapshot/browser.ts';
import type {
  ClassifiedRequest,
  DerivedSection,
  InteractionTiming,
  ServiceCategory,
  TrackingStage,
} from '../../derive/types.ts';
import { MAX_EVIDENCE, requestEvidence } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { serviceFields, serviceName } from './services.ts';
import { requestIndex, throttleAware } from './snapshot.ts';

const ID = 'TRACK-01';
const INVENTORY: ReadonlySet<ServiceCategory> = new Set([
  'analytics',
  'ads',
  'session-recording',
  'tag-manager',
]);
const STAGES: readonly TrackingStage[] = ['loaded', 'initialised', 'event-sent'];
/** `none`: the timing took place and no request followed; `not-checked`: it never took place, so absence proves nothing. */
type TimingStage = TrackingStage | 'none' | 'not-checked';

/** Timings in the order of the text, each with the param that carries its own stage. */
const TIMINGS = [
  ['before-interaction', 'stageBeforeInteraction'],
  ['after-reject', 'stageAfterReject'],
  ['after-accept', 'stageAfterAccept'],
] as const satisfies ReadonlyArray<readonly [InteractionTiming, string]>;

const higher = (a: TrackingStage, b: TrackingStage): TrackingStage =>
  STAGES.indexOf(b) > STAGES.indexOf(a) ? b : a;

/**
 * "Before interaction" is always observed; "after reject/accept" needs a successful click of that action in a phase
 * that was not skipped.
 */
function timingObserved(browser: BrowserSection, timing: InteractionTiming): boolean {
  if (timing === 'before-interaction') return true;
  const action = timing === 'after-reject' ? 'reject' : 'accept';
  return browser.phases.some(
    (p) => p.status !== 'skipped' && p.click?.success === true && p.click.action === action,
  );
}

/**
 * The highest stage a service reached at one timing; a tracking cookie or storage key seen then proves at least
 * `initialised`. A stage of another timing never raises it.
 */
function stageAt(
  browser: BrowserSection,
  derived: DerivedSection,
  serviceId: string,
  reqs: readonly ClassifiedRequest[],
  timing: InteractionTiming,
): TimingStage {
  const at = reqs.filter((c) => c.timing === timing);
  if (at.length === 0) return timingObserved(browser, timing) ? 'none' : 'not-checked';
  let stage = at.reduce<TrackingStage>((best, c) => higher(best, c.stage ?? 'loaded'), 'loaded');
  const initialisedProof =
    derived.cookies.some(
      (c) => c.serviceId === serviceId && c.tracking && isCookieHeld(c.state) && c.timing === timing,
    ) || derived.storage.some((c) => c.serviceId === serviceId && c.tracking && c.timing === timing);
  if (initialisedProof) stage = higher(stage, 'initialised');
  return stage;
}

/** Tracking services with the requests that reached the page. */
function requestsByService(
  derived: DerivedSection,
  records: Map<string, RequestRecord>,
): Map<string, ClassifiedRequest[]> {
  const byService = new Map<string, ClassifiedRequest[]>();
  for (const c of derived.requests) {
    if (!c.serviceId || !INVENTORY.has(c.category)) continue;
    // Reached the page (network response, SW or cache); a blocked or unanswered request is no inventory.
    if (!records.has(c.requestId) || !c.loaded) continue;
    byService.set(c.serviceId, [...(byService.get(c.serviceId) ?? []), c]);
  }
  return byService;
}

function inventoryObservation(
  serviceId: string,
  reqs: readonly ClassifiedRequest[],
  browser: BrowserSection,
  derived: DerivedSection,
  records: Map<string, RequestRecord>,
): Observation {
  const byTiming = TIMINGS.map(
    ([timing, param]) => [param, stageAt(browser, derived, serviceId, reqs, timing)] as const,
  );
  // `stage` is the highest stage over all timings; the text pairs every timing with its own stage.
  const stage = byTiming.reduce<TrackingStage>(
    (best, [, st]) => (st === 'none' || st === 'not-checked' ? best : higher(best, st)),
    'loaded',
  );
  const timings = new Set(reqs.map((c) => c.timing));

  const sorted = [...reqs].sort(
    (a, b) => STAGES.indexOf(b.stage ?? 'loaded') - STAGES.indexOf(a.stage ?? 'loaded'),
  );
  const evidence: EvidenceInput[] = sorted.slice(0, MAX_EVIDENCE).flatMap((c) => {
    const r = records.get(c.requestId);
    return r ? [requestEvidence(r, c)] : [];
  });

  return {
    checkId: ID,
    variant: 'service-inventory',
    confidence: reqs.every((c) => c.firstPartyProxy) ? 'medium' : 'high',
    subject: subjects.service(serviceId),
    category: reqs[0]?.category ?? 'unknown',
    phases: sortedUniq(reqs.map((c) => c.phase)) as Phase[],
    pages: sortedUniq(reqs.flatMap((c) => records.get(c.requestId)?.pageUrl ?? [])),
    evidence,
    params: {
      service: serviceName(derived, serviceId),
      stage,
      ...Object.fromEntries(byTiming),
      beforeInteraction: timings.has('before-interaction'),
      afterReject: timings.has('after-reject'),
      afterAccept: timings.has('after-accept'),
      firstPartyProxy: reqs.some((c) => c.firstPartyProxy),
    },
    ...serviceFields(derived, serviceId),
  };
}

export const track01 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['browser', 'derived'],
  variants: [{ variant: 'service-inventory' }],
  run({ browser, derived }) {
    if (!browser.phases.some((p) => p.status !== 'skipped' && p.pages.some((v) => v.evaluable))) {
      const throttled = browser.phases.some((p) => p.reason === 'throttled');
      const reason = throttled ? 'throttled' : 'no-network-observation';
      return { status: 'inconclusive', reason, observations: [] };
    }

    const records = requestIndex(browser);
    const observations = [...requestsByService(derived, records).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([serviceId, reqs]) => inventoryObservation(serviceId, reqs, browser, derived, records));

    return throttleAware(browser, {
      status: 'completed',
      observations,
      limitations: browser.requestCap.truncated ? ['request-cap-truncated'] : [],
    });
  },
});
