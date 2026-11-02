/**
 * TRACK-01 (P0): inventory of analytics, ads, session-recording and tag managers by catalog signatures, with
 * the proven stage (loaded → initialised → event-sent) and timing (before interaction / after reject /
 * after accept). `info` only: the gating level belongs to the related CONSENT finding (same serviceId).
 * A reference in source code without an executed request is no finding.
 */
import type { BrowserSection } from '../../collectors/browser/types.ts';
import { defineCheck, type EvidenceInput, type Observation, type Phase, subjects } from '../../core/api.ts';
import type {
  ClassifiedRequest,
  DerivedSection,
  InteractionTiming,
  ServiceCategory,
  TrackingStage,
} from '../../derive/types.ts';
import {
  MAX_EVIDENCE,
  requestEvidence,
  requestIndex,
  serviceFields,
  serviceName,
  sortedUniq,
  throttleAware,
} from './shared.ts';

const ID = 'TRACK-01';
const INVENTORY: ReadonlySet<ServiceCategory> = new Set([
  'analytics',
  'ads',
  'session-recording',
  'tag-manager',
]);
const STAGES: readonly TrackingStage[] = ['loaded', 'initialised', 'event-sent'];
/**
 * The proven stage of one timing. `none` = the timing was carried out and no request of the service followed;
 * `not-checked` = the timing never took place (no banner click of that action), so absence proves nothing.
 */
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
 * Was the timing carried out? Before any interaction is always observed (the run needs an evaluable page); "after
 * reject" / "after accept" need a successful click of that action in a phase that was not skipped — a banner that
 * was not recognised, a skipped phase or a failed click leaves the timing unobserved.
 */
function timingObserved(browser: BrowserSection, timing: InteractionTiming): boolean {
  if (timing === 'before-interaction') return true;
  const action = timing === 'after-reject' ? 'reject' : 'accept';
  return browser.phases.some(
    (p) => p.status !== 'skipped' && p.click?.success === true && p.click.action === action,
  );
}

/**
 * The stage a service reached AT one timing: the highest stage of its loaded requests of that timing; a tracking
 * cookie or storage key of the service seen at the same timing proves at least `initialised`. A stage of another
 * timing never raises it (library before the interaction, event only after accept → two different pairs).
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
      (c) =>
        c.serviceId === serviceId &&
        c.tracking &&
        (c.state === 'accepted' || c.state === 'sent') &&
        c.timing === timing,
    ) || derived.storage.some((c) => c.serviceId === serviceId && c.tracking && c.timing === timing);
  if (initialisedProof) stage = higher(stage, 'initialised');
  return stage;
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
    const byService = new Map<string, ClassifiedRequest[]>();
    for (const c of derived.requests) {
      if (!c.serviceId || !INVENTORY.has(c.category)) continue;
      // Reached the page (network response, SW or cache); a blocked or unanswered request is no inventory.
      if (!records.has(c.requestId) || !c.loaded) continue;
      byService.set(c.serviceId, [...(byService.get(c.serviceId) ?? []), c]);
    }

    const observations: Observation[] = [];
    for (const [serviceId, reqs] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
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
      observations.push({
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
      });
    }
    return throttleAware(browser, {
      status: 'completed',
      observations,
      limitations: browser.requestCap.truncated ? ['request-cap-truncated'] : [],
    });
  },
});
