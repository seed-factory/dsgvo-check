/** Target validation, URL sanitizing and registrable-domain helpers. E-mail masking lives in email.ts. */
import { getDomain } from 'tldts';
import { InvalidInputError } from '../runtime/errors.ts';
import type { TargetInfo } from '../snapshot/index.ts';
import {
  containsAddress,
  decodeLenient,
  maskAddressPiece,
  maskEmailsInUrl,
  REDACTED,
  safeDecode,
} from './email.ts';

/** Query parameters whose values are kept; everything else becomes `[redacted]`. Site-level settings only, never visitor ids. */
export const QUERY_ALLOWLIST: ReadonlySet<string> = new Set([
  'id', // gtag/GTM container id (G-…, GTM-…) — identifies the site's account
  'tid',
  'v',
  'ver',
  'version',
  'en', // GA4 event name
  'ev', // Meta Pixel event name
  't', // UA hit type
  'gcs',
  'gcd',
  'npa',
  'dma',
  'family', // Google Fonts
  'display',
  'subset',
  'render', // reCAPTCHA
  'hl',
  'output',
  'libraries',
]);

/** `http:` and `https:` are the only schemes the scanner navigates to or fetches. */
export function isHttpUrl(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/** The port a URL without an explicit one connects to. */
export function defaultHttpPort(protocol: string): 443 | 80 {
  return protocol === 'https:' ? 443 : 80;
}

/** Parse an absolute URL or resolve one against a base; malformed input has no URL. */
export function parseUrl(raw: string, base?: string, httpOnly = false): URL | null {
  try {
    const url = new URL(raw, base);
    return httpOnly && !isHttpUrl(url) ? null : url;
  } catch {
    return null;
  }
}

/** Hard cap on the length of a sanitized URL. */
const MAX_URL_LENGTH = 2048;

/** Tag/account ids of Google tags (gtag.js, GTM, Ads, Floodlight, Universal Analytics). */
const TAG_ID = /^(?:G|GT|GTM|AW|DC|UA)-[A-Z0-9][A-Z0-9-]{0,30}$/i;
/** Universal Analytics hit types (`t`). */
const UA_HIT_TYPES: ReadonlySet<string> = new Set([
  'pageview',
  'screenview',
  'event',
  'transaction',
  'item',
  'social',
  'exception',
  'timing',
]);
/** Version-like value (`v=2`, `v=2.1.0`); long digit runs (timestamps, ids) and hashes do not match. */
const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;

const isMetaPixel = (u: URL) => /(^|\.)facebook\.com$/i.test(u.hostname) && /^\/tr\/?$/.test(u.pathname);

/** Allowlisted generic names keep their value only in the expected form; anything else is redacted. */
export const QUERY_VALUE_RULES: Readonly<Record<string, (value: string, url: URL) => boolean>> = {
  id: (value, url) => TAG_ID.test(value) || (isMetaPixel(url) && /^\d{1,20}$/.test(value)),
  tid: (value) => TAG_ID.test(value),
  v: (value) => VERSION.test(value),
  t: (value) => UA_HIT_TYPES.has(value.toLowerCase()),
};

function keepValue(name: string, value: string, url: URL, allowlist: ReadonlySet<string>): boolean {
  const key = name.toLowerCase();
  if (!allowlist.has(key)) return false;
  // a visitor's address glued onto an allowlisted value (`?hl=de','alice@example.test`) must not survive
  if (containsAddress(value)) return false;
  const rule = QUERY_VALUE_RULES[key];
  return rule ? rule(value, url) : true;
}

/** `mailto:local@domain` → `mailto:[redacted]@domain` per recipient; headers (subject, cc, body) are dropped. */
export function maskMailto(raw: string): string {
  const body = decodeLenient(
    raw
      .trim()
      .replace(/^mailto:\s*/i, '')
      .replace(/[?#].*$/s, ''),
  );
  const recipients = body
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const prefixed = /^mailto:/i.test(r);
      const address = prefixed ? r.slice('mailto:'.length).trim() : r;
      const at = address.lastIndexOf('@');
      const rawDomain = at >= 0 ? /^[\p{L}\p{N}.-]+/u.exec(address.slice(at + 1))?.[0] : undefined;
      // a domain of only dots and hyphens would turn `[redacted]@` into `[redacted]` on a second pass
      const domain = rawDomain?.replace(/[.-]+$/, '');
      const masked = domain ? `${REDACTED}@${domain.toLowerCase()}` : REDACTED;
      return prefixed ? `mailto:${masked}` : masked;
    });
  // a first recipient with its own prefix (`mailto:,mailto:x@y`) must not double the one in front
  return `mailto:${recipients.length > 0 ? recipients.join(',') : REDACTED}`
    .replace(/^mailto:(?:mailto:)+/, 'mailto:')
    .slice(0, MAX_URL_LENGTH);
}

/** Path parameters (`;k=v`, `prefix:k=v&k=v`) carry visitor ids like a query: allowlisted names keep a well-formed value, all else is redacted. */
function redactPathParam(part: string, url: URL, allowlist: ReadonlySet<string>): string {
  const eq = part.indexOf('=');
  if (eq < 0) return part;
  const name = part.slice(0, eq);
  return keepValue(safeDecode(name), safeDecode(part.slice(eq + 1)), url, allowlist)
    ? part
    : `${name}=${REDACTED}`;
}

/** First part of a segment: `k=v`, `k=v&k=v` or `prefix:k=v&k=v` (the last two redact every value). */
function redactLeadParams(first: string, url: URL, allowlist: ReadonlySet<string>): string {
  const eq = first.indexOf('=');
  if (eq < 0) return first;
  const colon = first.indexOf(':');
  const prefixed = colon >= 0 && colon < eq;
  const prefix = prefixed ? first.slice(0, colon + 1) : '';
  const pairs = first.slice(prefix.length).split('&');
  const everyValue = prefixed || pairs.length > 1;
  return (
    prefix +
    pairs
      .map((pair) => {
        if (!everyValue) return redactPathParam(pair, url, allowlist);
        const i = pair.indexOf('=');
        return i < 0 ? pair : `${pair.slice(0, i)}=${REDACTED}`;
      })
      .join('&')
  );
}

/** Percent-escapes of `;` `=` `&` `:` count as the characters themselves for the path-parameter rule. */
const ENCODED_PARAM_SYNTAX = /%(3B|3D|26|3A)/gi;
const PARAM_SYNTAX: Readonly<Record<string, string>> = { '3B': ';', '3D': '=', '26': '&', '3A': ':' };

/** Masks addresses in a decoded segment; `/` and `\` stay escaped, `=` and `&` are borders only if the segment has a parameter. */
function maskEmailsInSegment(decoded: string): string {
  const withParams = decoded.includes('=');
  return decoded
    .split(/([/\\])/)
    .map((piece, i) => (i % 2 === 1 ? piece : maskAddressPiece(piece, withParams)))
    .join('');
}

/** Decoding rounds in which an address is looked for. */
const DECODE_ROUNDS = 3;
/** Upper bound on re-masking passes. */
const MASK_PASSES = 4;

/** Writes a decoded segment back; characters that would change the path structure stay escaped. */
const escapeDecoded = (text: string) =>
  text.replaceAll('%', '%25').replaceAll('/', '%2F').replaceAll('\\', '%5C');
/** Same for an opaque path, which no URL setter rewrites. */
const escapeDecodedOpaque = (text: string) =>
  escapeDecoded(text).replace(/[\p{Cc} ?#]/gu, encodeURIComponent);

/** Masks an address visible after 1-3 rounds of lenient decoding; the earliest round that shows one is masked and written back. */
function maskSegmentOnce(segment: string, writeBack: (decoded: string) => string): string {
  let decoded = segment;
  for (let round = 1; round <= DECODE_ROUNDS; round++) {
    const next = decodeLenient(decoded);
    // a round that decodes nothing shows nothing new
    if (round > 1 && next === decoded) break;
    decoded = next;
    if (decoded.includes('@')) {
      const masked = maskEmailsInSegment(decoded);
      if (masked !== decoded) return writeBack(masked);
    }
  }
  return segment;
}

/** Repeats `maskSegmentOnce` until stable (the written-back form may expose a deeper-encoded address); a segment that does not settle is replaced. */
function maskSegmentAddresses(
  segment: string,
  writeBack: (decoded: string) => string = escapeDecoded,
): string {
  let current = segment;
  for (let pass = 0; ; pass++) {
    const next = maskSegmentOnce(current, writeBack);
    if (next === current) return current;
    if (pass === MASK_PASSES) return REDACTED;
    current = next;
  }
}

function redactPathSegmentOnce(segment: string, url: URL, allowlist: ReadonlySet<string>): string {
  let out = segment;
  // only a segment with a parameter is rewritten
  const syntax = segment.replace(
    ENCODED_PARAM_SYNTAX,
    (_, hex: string) => PARAM_SYNTAX[hex.toUpperCase()] ?? '',
  );
  if (syntax.includes('=')) {
    const [first = '', ...rest] = syntax.split(';');
    out = [
      redactLeadParams(first, url, allowlist),
      ...rest.map((p) => redactPathParam(p, url, allowlist)),
    ].join(';');
  }
  return maskSegmentAddresses(out);
}

/** Repeats `redactPathSegmentOnce` to a fixed point: a deeper encoding level can surface as parameter syntax only on the next pass. */
function redactPathSegment(segment: string, url: URL, allowlist: ReadonlySet<string>): string {
  let current = segment;
  for (let pass = 0; ; pass++) {
    const next = redactPathSegmentOnce(current, url, allowlist);
    if (next === current) return current;
    if (pass === MASK_PASSES) return REDACTED;
    current = next;
  }
}

/** Redacts identifiers and addresses in a path made of segments; opaque paths (`foo:…`, `sms:…`) go through `redactOpaquePath`. */
function redactPath(u: URL, allowlist: ReadonlySet<string>): void {
  const path = u.pathname;
  // `%` for encoded `@` (also encoded twice or three times) and `=`
  if (!path.startsWith('/') || !/[=@%]/.test(path)) return;
  const next = path
    .split('/')
    .map((segment) => redactPathSegment(segment, u, allowlist))
    .join('/');
  if (next !== path) u.pathname = next;
}

/** URL string with the addresses of an opaque path masked; no setter rewrites such a path, so the pieces are spliced in and reparsed. */
function redactOpaquePath(u: URL): string {
  const href = u.toString();
  const path = u.pathname;
  if (path === '' || path.startsWith('/')) return href;
  const masked = path
    .split('/')
    .map((piece) => maskSegmentAddresses(piece, escapeDecodedOpaque))
    .join('/');
  if (masked === path) return href;
  if (!href.startsWith(u.protocol + path)) return `${u.protocol}${REDACTED}`;
  try {
    return new URL(`${u.protocol}${masked}${href.slice(u.protocol.length + path.length)}`).toString();
  } catch {
    return `${u.protocol}${REDACTED}`;
  }
}

/** URL reduced to its scheme; `file:` keeps `///` so that it parses the same on the next pass. */
const schemeOnly = (scheme: string) =>
  scheme.toLowerCase() === 'file:' ? `file:///${REDACTED}` : `${scheme}${REDACTED}`;

/** The string as the URL parser reads it (outer C0 controls and blanks, inner tabs and line breaks removed). */
function withoutParserNoise(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 0x20) start++;
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--;
  const trimmed = start === 0 && end === raw.length ? raw : raw.slice(start, end);
  return /[\t\n\r]/.test(trimmed) ? trimmed.replace(/[\t\n\r]/g, '') : trimmed;
}

/** Best-effort redaction of a non-parsable URL: userinfo, query and fragment removed, addresses masked, also encoded ones. */
function redactUnparsable(input: string): string {
  const raw = withoutParserNoise(input);
  // a blank before the fragment is dropped by the URL parser once the fragment is gone, and what is left may parse
  const withoutFragment = withoutParserNoise(raw.replace(/#.*$/s, ''));
  if (withoutFragment !== raw) {
    try {
      new URL(withoutFragment);
      return sanitizeUrl(withoutFragment);
    } catch {
      // still no URL: masked below
    }
  }
  const masked = maskEmailsInUrl(
    withoutFragment.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/is, '$1').replace(/\?.*$/s, `?${REDACTED}`),
  );
  // run both masks to a fixed point: decoded pieces can land next to an escape (`%2F@…`) that the bare-address mask reads as a local part
  let current = masked;
  for (let pass = 0; pass < MASK_PASSES; pass++) {
    const next = maskEmailsInUrl(maskEncodedAddresses(current));
    if (next === current) break;
    current = next;
  }
  // a blank left by the removed fragment or query would read differently on the next pass
  return withoutParserNoise(current).slice(0, MAX_URL_LENGTH);
}

/** Characters that must not stay raw in a stored string: controls, line/paragraph separators, bidi controls. */
const RAW_UNSAFE = /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Writes back a decoded piece of an unparsable URL: nothing may become a query or fragment, no control comes out raw. */
const escapeDecodedUnparsable = (text: string) =>
  escapeDecoded(text).replaceAll('?', '%3F').replaceAll('#', '%23').replace(RAW_UNSAFE, encodeURIComponent);

/** Masks addresses visible only after decoding in a non-parsable URL; one in the host part would become userinfo next pass, so the URL is cut to its scheme. */
function maskEncodedAddresses(text: string): string {
  const head = /^([a-z][a-z0-9+.-]*:)([/\\]*)([^/?#]*)/i.exec(text);
  if (head && containsAddress(head[3] as string)) return schemeOnly(head[1] as string);
  const rest = text.slice(head?.[0].length ?? 0);
  const query = rest.indexOf('?');
  const path = query < 0 ? rest : rest.slice(0, query);
  const masked = path
    .split('/')
    .map((piece) => maskSegmentAddresses(piece, escapeDecodedUnparsable))
    .join('/');
  return `${head?.[0] ?? ''}${masked}${query < 0 ? '' : rest.slice(query)}`;
}

const FORM_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const FORM_ENCODER = new TextEncoder();
const hexDigit = (c: number) =>
  c >= 0x30 && c <= 0x39
    ? c - 0x30
    : c >= 0x41 && c <= 0x46
      ? c - 0x37
      : c >= 0x61 && c <= 0x66
        ? c - 0x57
        : -1;

/** Decodes a form-urlencoded name or value like `URLSearchParams` (`+` is a blank, a stray `%` stays, invalid UTF-8 becomes U+FFFD) in linear time. */
function formDecode(s: string): string {
  const spaced = s.includes('+') ? s.replaceAll('+', ' ') : s;
  if (!spaced.includes('%')) return spaced;
  try {
    return decodeURIComponent(spaced);
  } catch {
    // invalid UTF-8 or a stray `%`: go through the bytes
  }
  const bytes = FORM_ENCODER.encode(spaced);
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    const high = byte === 0x25 && i + 2 < bytes.length ? hexDigit(bytes[i + 1] as number) : -1;
    const low = high >= 0 ? hexDigit(bytes[i + 2] as number) : -1;
    if (low >= 0) {
      out[n++] = (high << 4) | low;
      i += 2;
    } else {
      out[n++] = byte;
    }
  }
  return FORM_DECODER.decode(out.subarray(0, n));
}

/** Redacts the query in one linear pass (the `URLSearchParams` iterator is quadratic) and stops once the output exceeds `MAX_URL_LENGTH`. */
function redactQuery(u: URL, allowlist: ReadonlySet<string>): void {
  const query = u.search.slice(1);
  const out = new URLSearchParams();
  let size = 0;
  for (let start = 0; start <= query.length; ) {
    let end = query.indexOf('&', start);
    if (end < 0) end = query.length;
    if (end > start) {
      const pair = query.slice(start, end);
      const eq = pair.indexOf('=');
      const k = formDecode(eq < 0 ? pair : pair.slice(0, eq));
      const v = eq < 0 ? '' : formDecode(pair.slice(eq + 1));
      // a key is a part of the page too: `?alice@example.test` is the key `alice@example.test` with an empty value
      const key = containsAddress(k) ? REDACTED : k;
      const value = keepValue(k, v, u, allowlist) ? v : REDACTED;
      out.append(key, value);
      size += key.length + value.length + 2;
      if (size > MAX_URL_LENGTH) break;
    }
    start = end + 1;
  }
  u.search = out.toString().replaceAll('%5Bredacted%5D', REDACTED);
}

/** Removes credentials and fragment; redacts query values off the allowlist, path parameters and addresses (also encoded, also in opaque paths). Linear. */
export function sanitizeUrl(raw: string, allowlist: ReadonlySet<string> = QUERY_ALLOWLIST): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return redactUnparsable(raw);
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}${REDACTED}`;
  if (u.protocol === 'mailto:') return maskMailto(raw);
  u.username = '';
  u.password = '';
  u.hash = '';
  // an opaque host (`foo://alice%40mail.invalid/`) can carry an address
  if (u.host.includes('%') && containsAddress(u.host)) return schemeOnly(u.protocol);
  if (u.search) redactQuery(u, allowlist);
  redactPath(u, allowlist);
  return redactOpaquePath(u).slice(0, MAX_URL_LENGTH);
}

/** Host in URL form (`[2001:db8::1]`) → bare form for DNS lookups, address checks and sockets (`2001:db8::1`). */
export function bareHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1');
}

const hasScheme = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s);

/** The scan target as it may appear in snapshots, reports, logs and messages; also for rejected or unparsable input. */
export function redactTarget(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withScheme = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(withScheme);
  } catch {
    return redactUnparsable(withScheme);
  }
  return sanitizeUrl(withScheme);
}

/** Copy of `target` that is safe to store; the raw target stays with the collectors. */
export function redactTargetInfo(target: TargetInfo): TargetInfo {
  return { ...target, input: redactTarget(target.input), url: sanitizeUrl(target.url) };
}

/** Registrable domain (eTLD+1) using the PSL including private suffixes; null for IPs and bare suffixes. */
export function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

export function isSameSite(hostA: string, hostB: string): boolean {
  const a = registrableDomain(hostA);
  const b = registrableDomain(hostB);
  if (a === null || b === null) return hostA.toLowerCase() === hostB.toLowerCase();
  return a === b;
}

/**
 * Validates the scan target; a bare hostname gets `https://`. The result holds the raw URL for navigation, so store
 * only `redactTargetInfo()` of it. `host` keeps URL form (IPv6 in brackets); use `bareHost()` for DNS and sockets.
 */
export function parseTarget(input: string): TargetInfo {
  const trimmed = input.trim();
  if (!trimmed) throw new InvalidInputError('target-missing');
  const withScheme = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new InvalidInputError('target-invalid-url', { url: redactTarget(trimmed) });
  }
  if (!isHttpUrl(u)) {
    throw new InvalidInputError('target-unsupported-scheme', { scheme: u.protocol });
  }
  if (u.username || u.password) {
    throw new InvalidInputError('target-credentials');
  }
  if (!u.hostname) throw new InvalidInputError('target-invalid-url', { url: redactTarget(trimmed) });
  u.hash = '';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return {
    input: trimmed,
    url: u.toString(),
    scheme: u.protocol === 'https:' ? 'https' : 'http',
    host,
    etld1: registrableDomain(host),
    finalUrl: null,
    finalHost: null,
  };
}
