/** Primitive types shared by all snapshot sections; the data is already redacted (no cookie / Web Storage / TC-String values). */
import type { MessageParams } from '../report/schema.ts';

/** Browser phases of the prototype (A′ and M are not implemented). */
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
  /** CSP only: `frame-ancestors` evaluated on the complete value as sent, before editing and the cut. Set when the directive is present or the value reached `MAX_HEADER_VALUE`. */
  frameAncestors?: FrameAncestorsFact;
  /**
   * Product headers only (`Server`, `X-Powered-By`, …), whose `value` stays `[redacted]`: the `product/version` pairs
   * of the value, at most four. Empty when the value names no version; absent in snapshots older than this field.
   */
  productVersions?: ProductVersion[];
}

/** One RFC 9110 product token with a version, e.g. `PHP/7.2.34`; comments, hosts, addresses and URLs are not kept. */
export interface ProductVersion {
  product: string;
  version: string;
}

/** `frame-ancestors` of a CSP header value; several comma-joined policies are summed up. */
export interface FrameAncestorsFact {
  /** Some policy of the value has the directive. */
  present: boolean;
  /** Some policy has it without a source that matches every origin (`*`, `https:`, `http:`). */
  restricts: boolean;
  /** Sources of the first restricting policy (else of the first with the directive), at most 20 of at most 200 characters, reduced to keyword, `*`, scheme or `[scheme://]host[:port]`; anything else is `[redacted]`. */
  sources: string[];
}

export interface CollectorError {
  /** Stable machine code, e.g. `navigation-timeout`, `ERR_NAME_NOT_RESOLVED`, `servfail`. */
  code: string;
  message: string;
  phase?: Phase;
  url?: SanitizedUrl;
  /**
   * The parameters of the `failure.<code>` text of a fatal the error stands for, e.g. `signals` (the labels of the bot
   * or WAF protection signals) of `start-page-blocked`. Absent in older snapshots.
   */
  params?: MessageParams;
}

/** Outcome of one collector run, recorded in `snapshot.collection`. */
export interface CollectorStatus {
  status: 'ok' | 'partial' | 'error' | 'skipped' | 'not-run';
  /** Machine-readable reason for skipped/error, e.g. `not-required`, `tls-blocked`, `not-implemented`. */
  reason?: string;
  error?: CollectorError;
  durationMs: number;
}
