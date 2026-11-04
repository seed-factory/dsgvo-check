/** Executes one check over its snapshot slice; shared by the orchestrator and L1 test helpers so both map missing sections and exceptions alike. */

import { errorMessage } from '../runtime/errors.ts';
import {
  type BrowserPhase,
  type CollectorName,
  SECTION_PRODUCER,
  type Snapshot,
  type SnapshotSectionKey,
  sliceSnapshot,
} from '../snapshot/index.ts';
import type { ExecutedCheck } from './assess.ts';
import { type AnyCheck, type CheckContext, normalizeOutcome } from './check.ts';

/** The collector whose status explains a missing section: derived data comes from the browser, core sections from none. */
const COLLECTOR_OF_PRODUCER: Readonly<
  Record<(typeof SECTION_PRODUCER)[SnapshotSectionKey], CollectorName | null>
> = {
  browser: 'browser',
  http: 'http',
  tls: 'tls',
  dns: 'dns',
  derive: 'browser',
  core: null,
};

/**
 * Status of a check whose required section is missing: collector timeout → `error/timeout`; collector ran without the
 * section → `error/collector-error:<name>`; collector skipped → `skipped/<its reason>`; otherwise `skipped/not-collected`.
 */
export function missingSectionResult(
  missing: readonly SnapshotSectionKey[],
  snapshot: Snapshot,
  timedOut: boolean,
): ExecutedCheck {
  for (const key of missing) {
    const collector = COLLECTOR_OF_PRODUCER[SECTION_PRODUCER[key]];
    const st = collector ? snapshot.collection[collector] : undefined;

    if (st?.reason === 'timeout' || (timedOut && st === undefined)) {
      return {
        status: 'error',
        reason: 'timeout',
        outcome: null,
        durationMs: 0,
        limitations: [`missing:${key}`],
      };
    }

    if (st?.status === 'error' || st?.status === 'ok' || st?.status === 'partial') {
      return {
        status: 'error',
        reason: `collector-error:${collector}`,
        outcome: null,
        durationMs: 0,
        limitations: [`missing:${key}`],
        error: { code: 'collector-error', message: `section "${key}" missing (${collector}: ${st.status})` },
      };
    }

    if (st?.status === 'skipped') {
      return { status: 'skipped', reason: st.reason ?? 'collector-skipped', outcome: null, durationMs: 0 };
    }
  }
  return { status: 'skipped', reason: 'not-collected', outcome: null, durationMs: 0 };
}

/**
 * Reasons meaning "the data I need was not collected", with their phases. After the global timeout such a reason is the
 * deadline's doing only when its phase was cut; one from a phase that ended by itself is a fact about the site. `null` = whole collection cut.
 */
const REASON_PHASES: ReadonlyMap<string, readonly BrowserPhase[] | null> = new Map([
  ['timeout', null],
  ['insufficient-pages', ['A']],
  ['no-evaluable-pages', ['A']],
  ['no-pre-consent-observation', ['A']],
  ['no-network-observation', ['A']],
  ['phase-b-missing', ['B']],
  ['no-reject-click', ['B']],
  ['reject-not-confirmed', ['B']],
  ['phase-c-missing', ['C']],
  // the CMP facts come from the first screens of A and B
  ['cmp-not-observed', ['A', 'B']],
]);
/** Reasons with which a phase record says that the deadline stopped it (the local reserve counts). */
const DEADLINE_PHASE_REASONS: ReadonlySet<string> = new Set(['timeout', 'time-budget']);

/** The deadline cut `phase`: it has no record, or the record says the deadline stopped it. */
function phaseCutByDeadline(snapshot: Snapshot, phase: BrowserPhase): boolean {
  const record = snapshot.browser?.phases.find((p) => p.phase === phase);
  if (!record) return true;
  return (
    (record.status === 'skipped' || record.status === 'partial') &&
    record.reason !== undefined &&
    DEADLINE_PHASE_REASONS.has(record.reason)
  );
}

/**
 * `inconclusive` for lack of data becomes `error/timeout` when the global timeout cut the phase the missing data
 * belongs to; observations a check did make, other reasons and phases that ended by themselves stay.
 */
function cutByDeadline(result: ExecutedCheck, snapshot: Snapshot): ExecutedCheck {
  if (result.status !== 'inconclusive' || !result.reason) return result;
  if (snapshot.collection.browser?.reason !== 'timeout') return result;
  if ((result.outcome?.observations.length ?? 0) > 0) return result;

  const phases = REASON_PHASES.get(result.reason);
  if (phases === undefined) return result;
  if (phases !== null && !phases.some((p) => phaseCutByDeadline(snapshot, p))) return result;

  return {
    status: 'error',
    reason: 'timeout',
    outcome: null,
    durationMs: result.durationMs,
    limitations: [...(result.limitations ?? []), `deadline:${result.reason}`],
  };
}

/** Run `check` on `snapshot`. Never throws: exceptions become `error/exception` (→ `check-error:<id>` in the gate). */
export function executeCheck(
  check: AnyCheck,
  snapshot: Snapshot,
  ctx: CheckContext,
  opts: { timedOut?: boolean } = {},
): ExecutedCheck {
  const t0 = performance.now();
  const sliced = sliceSnapshot(snapshot, check.requires as SnapshotSectionKey[]);
  if (!sliced.ok) return missingSectionResult(sliced.missing, snapshot, opts.timedOut ?? false);

  try {
    const outcome = normalizeOutcome(check.run(sliced.slice, ctx));
    return cutByDeadline(
      {
        status: outcome.status,
        reason: outcome.reason ?? null,
        outcome,
        durationMs: Math.round(performance.now() - t0),
      },
      snapshot,
    );
  } catch (err) {
    return {
      status: 'error',
      reason: 'exception',
      outcome: null,
      durationMs: Math.round(performance.now() - t0),
      error: { code: 'check-exception', message: errorMessage(err) },
    };
  }
}
