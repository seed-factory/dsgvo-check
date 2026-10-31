/**
 * "Quiet" instead of `networkidle` (D09, browser research §1.4): after MIN_DWELL, stop once no request has started
 * for the quiet window and at most `maxInflight` requests are still open; give up at HARD_CAP.
 */
import { sleep } from './util.ts';

export interface QuietParams {
  minDwellMs: number;
  hardCapMs: number;
  quietWindowMs: number;
  maxInflight: number;
}

export interface QuietSample {
  /** Time since the reference point (navigation start or click). */
  elapsedMs: number;
  /** Time since the last request started (or since the reference point when none started). */
  sinceLastStartMs: number;
  inflight: number;
}

export type QuietVerdict = 'wait' | 'quiet' | 'hard-cap';

export function quietDecision(s: QuietSample, p: QuietParams): QuietVerdict {
  if (s.elapsedMs >= p.hardCapMs) return 'hard-cap';
  if (s.elapsedMs < p.minDwellMs) return 'wait';
  return s.sinceLastStartMs >= p.quietWindowMs && s.inflight <= p.maxInflight ? 'quiet' : 'wait';
}

export interface ActivitySource {
  /** Epoch ms of the last request start, or null. */
  lastRequestStart(): number | null;
  inflight(): number;
}

/** Poll the activity source until quiet, hard cap or abort. Returns whether quiet was reached and the dwell. */
export async function waitForQuiet(
  source: ActivitySource,
  startedAt: number,
  params: QuietParams,
  signal: AbortSignal,
  pollMs = 100,
): Promise<{ quietReached: boolean; dwellMs: number }> {
  for (;;) {
    const now = Date.now();
    const last = source.lastRequestStart();
    const verdict = quietDecision(
      {
        elapsedMs: now - startedAt,
        sinceLastStartMs: now - Math.max(last ?? startedAt, startedAt),
        inflight: source.inflight(),
      },
      params,
    );
    if (verdict !== 'wait' || signal.aborted) {
      return { quietReached: verdict === 'quiet', dwellMs: now - startedAt };
    }
    await sleep(pollMs, signal);
  }
}
