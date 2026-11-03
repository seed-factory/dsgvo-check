/** Browser collector constants; timings are injectable for tests via `BrowserTiming`. */
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

export const DEFAULT_TIMING: BrowserTiming = {
  quietWindowMs: 2_000,
  maxInflight: 1,
  phases: {
    A: { minDwellMs: 6_000, hardCapMs: 20_000 },
    B: { minDwellMs: 4_000, hardCapMs: 12_000 },
    C: { minDwellMs: 4_000, hardCapMs: 12_000 },
  },
  navigationPauseMs: 1_500,
  navigationTimeoutMs: 30_000,
  loadTimeoutMs: 15_000,
  cmpCallTimeoutMs: 15_000,
  retryDelayMs: 3_000,
  deadlineReserveMs: 20_000,
};

/** Shared across phases. */
export const REQUEST_LIMIT = 2_000;

export const VIEWPORT: Viewport = { width: 1366, height: 768 };
export const LOCALE = 'de-DE';
export const TIMEZONE = 'Europe/Berlin';
export const BROWSER_CHANNEL = 'chromium';

export const SCREENSHOT_MAX_BYTES = 200 * 1024;
export const SCREENSHOT_MAX_VIEWPORT_SHARE = 0.5;

export const REQUEST_QUERY_ALLOWLIST: ReadonlySet<string> = QUERY_ALLOWLIST;

// Parameter and cookie names that carry a user or device identifier (lower-case). Only the NAME is recorded; values
// stay in memory for correlation and are never written.
export const IDENTIFIER_PARAMS: ReadonlySet<string> = new Set([
  'cid', // GA client id
  'uid',
  '_gid',
  '_ga',
  'fbp',
  'fbc',
  '_fbp',
  '_fbc',
  'gclid',
  'dclid',
  'wbraid',
  'gbraid',
  'msclkid',
  'fbclid',
  'ttclid',
  'ttp',
  '_ttp',
  'li_fat_id',
  '_id', // Matomo visitor id
  '_pk_id',
  'vid',
  'ecid',
  'client_id',
  'clientid',
  'user_id',
  'userid',
  'anonymous_id',
  'ajs_anonymous_id',
  'visitor_id',
  'visitorid',
  'uuid',
  '_hjid',
  'hjuid',
  'muid',
  '_uetvid',
  '_uetsid',
]);

export const IDENTIFIER_COOKIES: readonly RegExp[] = [
  /^_ga(_.*)?$/,
  /^_gid$/,
  /^_fbp$/,
  /^_fbc$/,
  /^_gcl_/,
  /^ide$/i,
  /^nid$/i,
  /^muid$/i,
  /^_pk_id/,
  /^_hjsession/i,
  /^_uetvid$/,
  /^_ttp$/,
  /^li_sugr$/,
  /^bcookie$/,
];

/** Resource types that never become quiet (excluded from the inflight count). */
export const LONG_LIVED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['eventsource', 'websocket', 'media']);

export const BASE_KNOWN_GAPS = [
  'pagehide-beacons',
  'preconnect-without-request',
  'third-party-storage-partitioning-disabled',
  'expandables-not-clicked',
  'blocked-cookies-not-recorded',
];
