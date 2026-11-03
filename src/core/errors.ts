/**
 * Reasons that end a scan as `failed` (exit 2, table 5.2). Each maps 1:1 to an `exitReasons` code.
 * `browser-unavailable` is reported as exit reason `invalid-input` per 5.2 ("браузер не установлен или не стартовал").
 * `timeout` = the global `--timeout` hit before phase A finished on the start page (set by the orchestrator only).
 */
import type { MessageParams } from './report-schema.ts';

export type FatalReason =
  | 'unreachable'
  | 'blocked'
  | 'timeout'
  | 'sandbox-unavailable'
  | 'browser-unavailable'
  | 'invalid-input'
  | 'internal-error'
  | 'report-write-failed';

/**
 * A scan-level failure. Collectors throw it (or return it in `CollectorResult.fatal`) to abort the scan.
 * The user-facing text is `failure.<code>` in data/texts, rendered with `params` in the language of the report.
 */
export class ScanFatalError extends Error {
  readonly reason: FatalReason;
  /** Stable machine code for `scan.failure.code`, e.g. `target-nxdomain`, `start-page-403`. */
  readonly code: string;
  readonly params: MessageParams;
  constructor(reason: FatalReason, code: string, params: MessageParams = {}, options?: { cause?: unknown }) {
    super(Object.keys(params).length > 0 ? `${code} ${JSON.stringify(params)}` : code, options);
    this.name = 'ScanFatalError';
    this.reason = reason;
    this.code = code;
    this.params = params;
  }
}

/** Invalid CLI arguments, config or target URL. */
export class InvalidInputError extends ScanFatalError {
  constructor(code: string, params: MessageParams = {}) {
    super('invalid-input', code, params);
    this.name = 'InvalidInputError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
