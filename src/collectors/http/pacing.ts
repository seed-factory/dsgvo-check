// Pacing and back-off of the requests to one host: the start interval and the limits of the overload policy of
// `HttpClient`, which reacts to repeated 429/503 answers.
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../../core/config/schema.ts';

export const DEFAULT_MIN_INTERVAL_MS = DEFAULT_CONFIG.http.minIntervalMs;
/** Pause after the third 429/503 in a row when the server sends no usable Retry-After. */
export const DEFAULT_THROTTLE_PAUSE_MS = 2_000;
/** Upper bound for honouring `Retry-After`, so one header cannot stall the scan. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Consecutive 429/503 answers from one host that count as throttling. */
export const THROTTLE_SERIES = 3;

export interface PacerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const REAL_CLOCK: PacerClock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    await sleep(ms, undefined, signal ? { signal } : {});
  },
};

// Per-host pacing: request starts to one host are at least `intervalMs` apart. Slots are handed out in call order
// (`#nextAt`); the gap is measured between real starts (`#lastStart`) because a late wake-up could leave two requests
// closer than the interval, so a request that wakes too early sleeps the rest.
export class HostPacer {
  readonly #intervalMs: number;
  readonly #clock: PacerClock;
  readonly #nextAt = new Map<string, number>();
  readonly #lastStart = new Map<string, number>();

  constructor(intervalMs: number, clock: PacerClock = REAL_CLOCK) {
    this.#intervalMs = intervalMs;
    this.#clock = clock;
  }

  async wait(host: string, signal?: AbortSignal): Promise<void> {
    // Reserve the next slot in call order, then sleep until it is due.
    const now = this.#clock.now();
    const at = Math.max(now, this.#nextAt.get(host) ?? 0);
    this.#nextAt.set(host, at + this.#intervalMs);
    if (at > now) await this.#clock.sleep(at - now, signal);

    // Re-check against the real previous start and sleep the rest when woken early.
    for (;;) {
      const start = this.#clock.now();
      const earliest = (this.#lastStart.get(host) ?? Number.NEGATIVE_INFINITY) + this.#intervalMs;
      if (start >= earliest) {
        this.#lastStart.set(host, start);
        return;
      }
      await this.#clock.sleep(earliest - start, signal);
    }
  }

  defer(host: string, ms: number): void {
    this.#nextAt.set(host, Math.max(this.#nextAt.get(host) ?? 0, this.#clock.now() + ms));
  }
}

/** `Retry-After` as delay-seconds or HTTP-date (RFC 9110 §10.2.3); null when absent or unusable. */
export function retryAfterMs(value: string | null, now: number): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
