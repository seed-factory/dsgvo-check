/**
 * Reasons that end a scan as `failed` (exit 2, table 5.2). Each maps 1:1 to an `exitReasons` code.
 * `browser-unavailable` is reported as exit reason `invalid-input` per 5.2 ("браузер не установлен или не стартовал").
 * `timeout` = the global `--timeout` hit before phase A finished on the start page (set by the orchestrator only).
 */
export type FatalReason =
  | 'unreachable'
  | 'blocked'
  | 'timeout'
  | 'sandbox-unavailable'
  | 'browser-unavailable'
  | 'invalid-input'
  | 'internal-error'
  | 'report-write-failed';

/** A scan-level failure. Collectors throw it (or return it in `CollectorResult.fatal`) to abort the scan. */
export class ScanFatalError extends Error {
  readonly reason: FatalReason;
  /** Stable machine code for `scan.failure.code`, e.g. `target-nxdomain`, `start-page-403`. */
  readonly code: string;
  constructor(reason: FatalReason, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScanFatalError';
    this.reason = reason;
    this.code = code;
  }
}

/** Invalid CLI arguments, config or target URL. */
export class InvalidInputError extends ScanFatalError {
  constructor(code: string, message: string) {
    super('invalid-input', code, message);
    this.name = 'InvalidInputError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
