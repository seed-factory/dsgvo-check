/** Pure helpers shared by HDR-01, TLS-01 and TLS-02 (no I/O); the HTTP collector uses them too. */

import type { HeaderRecord } from '../../core/api.ts';
import type { HttpHop, HttpSection } from '../../core/snapshot/http.ts';

/** What a Node `authorizationError` means for a visitor. */
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

/**
 * `error.code` of a document the HTTP collector saw answered by a bot or WAF challenge (signatures in
 * test/data/browser/challenges.yaml): its headers are the protection's, not the site's.
 */
export const BLOCKED_DOCUMENT = 'blocked';

export function headerValues(headers: readonly HeaderRecord[], name: string): string[] {
  const n = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
}

/** Directives whose repetition makes a browser drop the header; it ignores directives it does not know (`preload`). */
const HSTS_DIRECTIVES: ReadonlySet<string> = new Set(['max-age', 'includesubdomains']);

/** RFC 6797 §6.1: `max-age` is required and each directive appears once; the UA uses only the first header. */
function parseHsts(value: string): { ok: true; maxAge: number } | { ok: false; problem: string } {
  const directives = value
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  // Chromium and Firefox drop a header that repeats max-age or includeSubDomains, so its first max-age protects nothing.
  const names = directives
    .map((d) => (d.split('=')[0] ?? '').trim().toLowerCase())
    .filter((n) => HSTS_DIRECTIVES.has(n));
  if (new Set(names).size !== names.length) return { ok: false, problem: 'repeated-directive' };
  const maxAge = directives.find((d) => /^max-age\s*=/i.test(d));
  const m = maxAge ? /^max-age\s*=\s*"?(\d+)"?$/i.exec(maxAge) : null;
  if (!m) return { ok: false, problem: 'no-max-age' };
  const n = Number(m[1]);
  if (n === 0) return { ok: false, problem: 'max-age-zero' };
  return { ok: true, maxAge: n };
}

/** The HSTS policy of a response as a browser reads it (first header, first comma-separated value); null without one. */
export function hstsOf(headers: readonly HeaderRecord[]): ReturnType<typeof parseHsts> | null {
  const hsts = headerValues(headers, 'strict-transport-security')[0];
  if (hsts === undefined) return null;
  return parseHsts(hsts.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0] ?? '');
}

/** A page of at most this size is a stub (parking page, redirect stub), not content served over http. */
const STUB_BYTES = 1024;

/** The answer is a stub read whole: it serves no content of the site. */
export function isHttpStub(hop: Pick<HttpHop, 'bodyTruncated' | 'bodyBytes'>): boolean {
  return !hop.bodyTruncated && (hop.bodyBytes ?? 0) <= STUB_BYTES;
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

/** Lower-case host where the start document's redirect chain ended, else the target it could not complete; null if unknown. */
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
