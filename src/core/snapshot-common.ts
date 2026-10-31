/**
 * Primitive types shared by all snapshot sections. Snapshot data is already redacted (D20):
 * no cookie / Web Storage / TC-String values, query parameters redacted except the allowlist.
 */

/** Browser phases of the prototype (A′ and M are not implemented, see BRIEF "Упрощения"). */
export type BrowserPhase = 'A' | 'B' | 'C';
/** All phases that may appear in findings. Open set in the report schema. */
export type Phase = BrowserPhase | 'A-prime' | 'M' | 'http' | 'tls' | 'dns';

/** Milliseconds relative to a reference point (navigation start of the page, or the click in B/C). */
export type RelativeMs = number;

/** ISO 8601 UTC timestamp. */
export type IsoTimestamp = string;

/** A URL after `sanitizeUrl()` (query values redacted to `[redacted]` unless allowlisted, no fragment, no credentials). */
export type SanitizedUrl = string;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Response/request header. Names are lower-case. `set-cookie` values are never stored (names go to `setCookieNames`). */
export interface HeaderRecord {
  name: string;
  value: string;
  /** The stored `value` was cut at the storage limit (2048 characters); absent when it is complete. */
  truncated?: boolean;
  /**
   * CSP headers only: `frame-ancestors` evaluated on the complete value as the server sent it, BEFORE any editing and
   * before the cut (G42, S-net-2). Set when the value has the directive or is at least MAX_HEADER_VALUE long (cut, or
   * complete at exactly the limit, R12); absent on a shorter value without it (and in snapshots of older versions).
   */
  frameAncestors?: FrameAncestorsFact;
}

/** `frame-ancestors` of a CSP header value; several comma-joined policies are summed up. */
export interface FrameAncestorsFact {
  /** Some policy of the value has the directive. */
  present: boolean;
  /** Some policy has it without a source that matches every origin (`*`, `https:`, `http:`). */
  restricts: boolean;
  /**
   * Sources of the first restricting policy (else of the first policy with the directive), at most 20 of at most 200
   * characters. Each one is reduced to a keyword (`'self'`), `*`, a scheme (`https:`) or `[scheme://]host[:port]`:
   * user info, addresses, path, query and fragment are not stored, anything else is `[redacted]` (S-net-2).
   */
  sources: string[];
}

export interface CollectorError {
  /** Stable machine code, e.g. `navigation-timeout`, `ERR_NAME_NOT_RESOLVED`, `servfail`. */
  code: string;
  message: string;
  phase?: Phase;
  url?: SanitizedUrl;
}

/** Outcome of one collector run, recorded in `snapshot.collection`. */
export interface CollectorStatus {
  status: 'ok' | 'partial' | 'error' | 'skipped' | 'not-run';
  /** Machine-readable reason for skipped/error, e.g. `not-required`, `tls-blocked`, `not-implemented`. */
  reason?: string;
  error?: CollectorError;
  durationMs: number;
}
