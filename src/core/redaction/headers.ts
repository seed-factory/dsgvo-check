/**
 * Response headers as stored in snapshots and evidence, one normalizer for the HTTP collector and the browser: no
 * `Set-Cookie`, URLs resolved and sanitized, values only for security and technical headers, others by name (`[redacted]`).
 */

import type { FrameAncestorsFact, HeaderRecord } from '../snapshot/common.ts';
import { REDACTED } from '../url/email.ts';
import { sanitizeUrl } from '../url/url.ts';

export const MAX_HEADER_VALUE = 2048;

/** Headers whose value is kept: security headers and the technical headers the evaluation reads. */
export const VALUE_HEADERS: ReadonlySet<string> = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'x-xss-protection',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'content-type',
  'content-language',
  'retry-after',
]);

/** Headers that carry a URL (or a list of URLs): kept, with every URL resolved and sanitized. */
export const URL_HEADERS: ReadonlySet<string> = new Set(['location', 'content-location', 'refresh', 'link']);

export type UrlSanitizer = (url: string) => string;

function absoluteSanitized(raw: string, base: string, sanitize: UrlSanitizer): string {
  try {
    return sanitize(new URL(raw.trim(), base).toString());
  } catch {
    return REDACTED;
  }
}

/** Every absolute http(s) URL inside a header value, sanitized (CSP `report-uri`, `Report-To` JSON). */
function sanitizeUrlsIn(value: string, base: string, sanitize: UrlSanitizer): string {
  return value.replace(/https?:\/\/[^\s"'<>;,]+/gi, (u) => absoluteSanitized(u, base, sanitize));
}

/**
 * Resolves and sanitizes the `<…>` targets of a `Link` value, text outside them stays. One `indexOf` pass: a `[^>]*`
 * expression would scan to the end from every `<` of an untrusted value without `>` (`<meta http-equiv>`, up to 64 KiB).
 */
function sanitizeLinkTargets(value: string, base: string, sanitize: UrlSanitizer): string {
  let out = '';
  let pos = 0;
  for (let open = value.indexOf('<'); open >= 0; open = value.indexOf('<', pos)) {
    const close = value.indexOf('>', open + 1);
    if (close < 0) break;
    out += `${value.slice(pos, open)}<${absoluteSanitized(value.slice(open + 1, close), base, sanitize)}>`;
    pos = close + 1;
  }
  return out + value.slice(pos);
}

/** Line terminators of JavaScript, which `.` does not match: no refresh address may hold one. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const REFRESH_DELAY = /^[\d.]+/;

/**
 * `Refresh` / `<meta http-equiv="refresh">`: `<delay>[;|, [url=]['"]<address>['"]]`; `null` when the value is no refresh.
 * Trims by hand in linear passes: a lazy `(.*?)` before `\s*$` was quadratic on a long run of spaces in untrusted HTML.
 */
function parseRefresh(value: string): { delay: string; address: string } | null {
  const afterSpace = value.trimStart();
  const delay = REFRESH_DELAY.exec(afterSpace)?.[0];
  if (!delay) return null;
  let rest = afterSpace.slice(delay.length).trimStart();
  if (rest === '') return { delay, address: '' };
  if (rest[0] !== ';' && rest[0] !== ',') return null;
  rest = rest.slice(1).trimStart();
  if (rest.slice(0, 3).toLowerCase() === 'url') {
    const afterName = rest.slice(3).trimStart();
    if (afterName[0] === '=') rest = afterName.slice(1).trimStart();
  }
  rest = rest.trimEnd();
  if (LINE_TERMINATOR.test(rest)) return null;
  const quote = rest[0];
  const quoted = (quote === '"' || quote === "'") && rest.length >= 2 && rest.endsWith(quote);
  return { delay, address: quoted ? rest.slice(1, -1) : rest };
}

function sanitizeUrlHeader(name: string, value: string, base: string, sanitize: UrlSanitizer): string {
  if (name === 'location' || name === 'content-location') return absoluteSanitized(value, base, sanitize);
  if (name === 'link') return sanitizeLinkTargets(value, base, sanitize);
  const refresh = parseRefresh(value);
  if (!refresh) return REDACTED;
  return refresh.address
    ? `${refresh.delay}; url=${absoluteSanitized(refresh.address, base, sanitize)}`
    : refresh.delay;
}

/** CSP headers: the frame-ancestors fact is derived from the complete value. */
const CSP_HEADERS: ReadonlySet<string> = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
]);

/** Sources that match every network origin (`*`, a bare scheme): such a list does not restrict framing. */
const UNRESTRICTED_SOURCES: ReadonlySet<string> = new Set(['*', 'https:', 'http:']);
const MAX_FRAME_ANCESTOR_SOURCES = 20;
const MAX_SOURCE_LENGTH = 200;

/** Quoted keywords of a source list; any other quoted token (nonce, hash, junk) is dropped. */
const CSP_KEYWORDS: ReadonlySet<string> = new Set([
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'unsafe-hashes'",
  "'strict-dynamic'",
  "'report-sample'",
  "'wasm-unsafe-eval'",
  "'inline-speculation-rules'",
]);
/** The host part of a host-source: `*`, `*.example.com`, `example.com` or an IPv6 literal; letters of any script. */
const SOURCE_HOST_RE = /^(?:\*|(?:\*\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.?|\[[0-9a-f:.]+\])$/iu;

/**
 * Reduces a CSP source to what the facts need: keyword, `*`, scheme or `[scheme://]host[:port]`; user info, addresses,
 * path, query and fragment are dropped and anything that is not a host becomes `[redacted]`. Idempotent.
 */
function safeCspSource(source: string): string {
  const s = source.trim();
  if (s === '*' || /^[a-z][a-z0-9+.-]*:$/i.test(s)) return s.slice(0, MAX_SOURCE_LENGTH);
  if (s.startsWith("'")) return CSP_KEYWORDS.has(s.toLowerCase()) ? s : REDACTED;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]*)/i.exec(s);
  // user info ends at the last `@` of the authority (an address may hold `#`, `?` and `:`)
  const authority = (m?.[2] ?? '').replace(/^.*@/s, '').replace(/[?#].*$/s, '');
  const hp = /^(\[[0-9a-f:.]+\]|[^:]*)(?::(\d{1,5}|\*))?$/i.exec(authority);
  if (!hp || !SOURCE_HOST_RE.test(hp[1] ?? '')) return REDACTED;
  const scheme = m?.[1] ? `${m[1]}://` : '';
  return `${scheme}${hp[1]}${hp[2] ? `:${hp[2]}` : ''}`.slice(0, MAX_SOURCE_LENGTH);
}

/** A scheme-less token that can hold personal data: a host or an IPv6 literal followed by a path. */
const SOURCE_WITH_PATH =
  /^(?:(?:\*\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|\[[0-9a-f:.]+\])(?::(?:\d{1,5}|\*))?\//iu;

/** A non-`http(s)` token that carries user info, an address or a path (`portal.invalid/users/…`, `wss://api.invalid/x?user=…`). */
function isPersonalSource(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return false;
  if (/@|%40/i.test(token)) return true;
  if (token.includes('://')) return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*[/?#]/i.test(token);
  return SOURCE_WITH_PATH.test(token);
}

/** Reduces CSP tokens that are no `http(s)://` URL but carry user info, an address or a path; the URL sanitizer handles the `http(s)://` ones. */
function sanitizeSchemelessSources(value: string): string {
  return value.replace(/[^\s;,]+/g, (token) => (isPersonalSource(token) ? safeCspSource(token) : token));
}

/**
 * `frame-ancestors` of a CSP value, which may hold several comma-joined policies; one policy with the directive and
 * no wildcard source restricts framing, an empty list restricts like `'none'`. Stored `sources` are reduced to scheme, host and port.
 */
export function cspFrameAncestors(value: string): FrameAncestorsFact {
  let present = false;
  let restricts = false;
  let sources: string[] = [];
  for (const policy of value.split(',')) {
    for (const part of policy.split(';')) {
      const [directive, ...rest] = part.trim().split(/\s+/);
      if (directive?.toLowerCase() !== 'frame-ancestors') continue;
      const list = rest.filter(Boolean);
      const open = list.some((src) => UNRESTRICTED_SOURCES.has(src.toLowerCase()));
      if (!present || (!open && !restricts)) {
        sources = list.slice(0, MAX_FRAME_ANCESTOR_SOURCES).map(safeCspSource);
      }
      present = true;
      if (!open) restricts = true;
      break;
    }
  }
  return { present, restricts, sources };
}

/**
 * One header record: the value cut at `MAX_HEADER_VALUE` (flagged `truncated`) and, for CSP, the `frame-ancestors`
 * fact computed on the whole value as sent; stored when the directive is present or the value reached the limit.
 */
export function storedHeaderRecord(
  name: string,
  value: string,
  base: string,
  sanitize: UrlSanitizer,
): HeaderRecord {
  const n = name.toLowerCase();
  const csp = CSP_HEADERS.has(n);
  const sanitized = URL_HEADERS.has(n)
    ? sanitizeUrlHeader(n, value, base, sanitize)
    : VALUE_HEADERS.has(n)
      ? sanitizeUrlsIn(value, base, sanitize)
      : REDACTED;
  const full = csp ? sanitizeSchemelessSources(sanitized) : sanitized;
  const truncated = full.length > MAX_HEADER_VALUE;
  const record: HeaderRecord = { name: n, value: truncated ? full.slice(0, MAX_HEADER_VALUE) : full };
  if (truncated) record.truncated = true;
  if (csp) {
    const fact = cspFrameAncestors(value);
    // a complete value of exactly the limit carries the fact too, or it could not be told from a cut value of an older snapshot
    if (truncated || fact.present || full.length >= MAX_HEADER_VALUE) record.frameAncestors = fact;
  }
  return record;
}

/** Header records of a response; `sanitize` is the collector's URL sanitizer, `base` the response URL for relative values. */
export function snapshotHeaderRecords(
  raw: ReadonlyArray<{ name: string; value: string }>,
  base: string,
  sanitize: UrlSanitizer = sanitizeUrl,
): HeaderRecord[] {
  const out: HeaderRecord[] = [];
  for (const h of raw) {
    const name = h.name.toLowerCase();
    if (name === 'set-cookie') continue;
    out.push(storedHeaderRecord(name, h.value, base, sanitize));
  }
  return out;
}
