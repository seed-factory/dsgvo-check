// "Quiet" instead of `networkidle`: after MIN_DWELL, stop once no request has started within the quiet window and at
// most `maxInflight` are open; give up at HARD_CAP.
import { sleep } from '../util.ts';

export interface QuietParams {
  minDwellMs: number;
  hardCapMs: number;
  quietWindowMs: number;
  maxInflight: number;
}

export interface QuietSample {
  elapsedMs: number;
  /** Falls back to the reference point when no request started. */
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
  lastRequestStart(): number | null;
  inflight(): number;
}

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
