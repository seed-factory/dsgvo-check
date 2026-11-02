/** Pure helpers shared by HDR-01, TLS-01 and TLS-02 (no I/O); the HTTP collector uses them too. */
import type { HttpSection } from '../../collectors/http/types.ts';
import type { HeaderRecord } from '../../core/api.ts';

/** What a Node `authorizationError` means for a visitor (research http-dns-tls-mail §2.1). */
export type TlsProblem =
  | 'expired'
  | 'not-yet-valid'
  | 'name-mismatch'
  | 'self-signed'
  | 'untrusted-root'
  | 'incomplete-chain'
  | 'invalid';

const TLS_ERRORS: Readonly<Record<string, TlsProblem>> = {
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not-yet-valid',
  ERR_TLS_CERT_ALTNAME_INVALID: 'name-mismatch',
  HOSTNAME_MISMATCH: 'name-mismatch',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'untrusted-root',
  UNABLE_TO_GET_ISSUER_CERT: 'untrusted-root',
  CERT_UNTRUSTED: 'untrusted-root',
  CERT_REJECTED: 'untrusted-root',
  // Node does no AIA fetching; browsers complete such chains, so this is not a blocking error for visitors.
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'incomplete-chain',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'incomplete-chain',
};

export function tlsProblemOf(code: string | null | undefined): TlsProblem | null {
  if (!code) return null;
  return TLS_ERRORS[code] ?? 'invalid';
}

/** True when a browser would accept the connection: authorized, or only the intermediate is missing. */
export function browserAcceptsTls(authorized: boolean | null | undefined, error: string | null | undefined) {
  if (authorized !== false) return true;
  return tlsProblemOf(error) === 'incomplete-chain';
}

/** All values of a (lower-case) header name, in order. */
export function headerValues(headers: readonly HeaderRecord[], name: string): string[] {
  const n = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
}

export function isSuccess(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= 200 && status < 300;
}

export function isRedirect(status: number | null | undefined): boolean {
  return typeof status === 'number' && [301, 302, 303, 307, 308].includes(status);
}

/** Header values in evidence are truncated: they are external text. */
export function evidenceValue(value: string | undefined | null, max = 300): string | null {
  if (value === undefined || value === null) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export const DAY_MS = 86_400_000;

/**
 * Host where the start document's redirect chain ended: the final hop, else the redirect target the chain
 * could not complete. Lower case; null when unknown.
 */
export function startFinalHost(http: Pick<HttpSection, 'chains' | 'documents'>): string | null {
  const start = http.documents.find((d) => d.role === 'start');
  const chain = start?.chainId ? http.chains.find((c) => c.id === start.chainId) : undefined;
  const last = chain?.hops.at(-1);
  const url = chain?.final?.url ?? last?.location ?? last?.url ?? start?.finalUrl;
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
