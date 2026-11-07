// Failures of the passive probes (HTTP requests and TLS handshakes): one error type with a short code, and the mapping
// from Node, undici and DNS codes to the outcome kept in the snapshot.

/** Codes from undici, Node and the abort signal that all mean "ran out of time". */
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'TimeoutError',
]);
export const DNS_ERROR_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL'];

export class ProbeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeError';
    this.code = code;
  }
}

export function toProbeError(err: unknown, signal: AbortSignal): ProbeError {
  if (err instanceof ProbeError) return err;
  const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  let code = e?.code ?? e?.cause?.code ?? e?.name ?? 'error';
  if (signal.aborted && !TIMEOUT_CODES.has(code)) code = 'TimeoutError';
  return new ProbeError(code, e?.message ?? String(err), { cause: err });
}

export type ChainOutcome =
  | 'ok'
  | 'redirect-limit'
  | 'connection-refused'
  | 'timeout'
  | 'tls-error'
  | 'dns-error'
  | 'throttled'
  | 'error';

export function outcomeOf(code: string): ChainOutcome {
  if (code === 'ECONNREFUSED') return 'connection-refused';
  if (DNS_ERROR_CODES.includes(code)) return 'dns-error';
  if (TIMEOUT_CODES.has(code) || code === 'aborted') return 'timeout';
  if (code === 'throttled') return 'throttled';
  if (/^(ERR_SSL|ERR_TLS|EPROTO|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return 'tls-error';
  return 'error';
}
