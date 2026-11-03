/** Browser collector constants; the timings come from the operator settings and are injectable for tests via `BrowserTiming`. */
import type { Config } from '../../core/config/schema.ts';
import { DEFAULT_CONFIG } from '../../core/config/schema.ts';
import type { BrowserPhase, Viewport } from '../../core/snapshot/common.ts';
import { QUERY_ALLOWLIST } from '../../core/url/url.ts';

export interface PhaseTiming {
  minDwellMs: number;
  /** Quiet not reached sets `quietReached: false`. */
  hardCapMs: number;
}

export interface BrowserTiming {
  quietWindowMs: number;
  maxInflight: number;
  phases: Record<BrowserPhase, PhaseTiming>;
  navigationPauseMs: number;
  navigationTimeoutMs: number;
  loadTimeoutMs: number;
  cmpCallTimeoutMs: number;
  /** Retry delay after a 5xx/429 on the start page (Retry-After wins, capped at 30 s). */
  retryDelayMs: number;
  /** Time reserved before the scan deadline; no new page is started after that. */
  deadlineReserveMs: number;
}

export function browserTiming(b: Config['browser']): BrowserTiming {
  return {
    quietWindowMs: b.quietWindowMs,
    maxInflight: b.maxInflight,
    phases: {
      A: { minDwellMs: b.phaseAMinDwellMs, hardCapMs: b.phaseAHardCapMs },
      B: { minDwellMs: b.phaseBMinDwellMs, hardCapMs: b.phaseBHardCapMs },
      C: { minDwellMs: b.phaseCMinDwellMs, hardCapMs: b.phaseCHardCapMs },
    },
    navigationPauseMs: b.navigationPauseMs,
    navigationTimeoutMs: b.navigationTimeoutMs,
    loadTimeoutMs: b.loadTimeoutMs,
    cmpCallTimeoutMs: b.cmpCallTimeoutMs,
    retryDelayMs: b.retryDelayMs,
    deadlineReserveMs: b.deadlineReserveMs,
  };
}

export const DEFAULT_TIMING: BrowserTiming = browserTiming(DEFAULT_CONFIG.browser);

export const VIEWPORT: Viewport = { width: 1366, height: 768 };
export const LOCALE = 'de-DE';
export const TIMEZONE = 'Europe/Berlin';
export const BROWSER_CHANNEL = 'chromium';

export const REQUEST_QUERY_ALLOWLIST: ReadonlySet<string> = QUERY_ALLOWLIST;

/** Resource types that never become quiet (excluded from the inflight count). */
export const LONG_LIVED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['eventsource', 'websocket', 'media']);

export const BASE_KNOWN_GAPS = [
  'pagehide-beacons',
  'preconnect-without-request',
  'third-party-storage-partitioning-disabled',
  'expandables-not-clicked',
  'blocked-cookies-not-recorded',
];
