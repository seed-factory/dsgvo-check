/**
 * Response headers as stored in snapshots and evidence, one normalizer for the HTTP collector and the browser: no
 * `Set-Cookie`, URLs resolved and sanitized, values only for security and technical headers, others by name (`[redacted]`).
 * Product headers keep their value redacted too and carry only the product/version pairs read from it.
 */

import type { FrameAncestorsFact, HeaderRecord, ProductVersion } from '../snapshot/common.ts';
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
 * Headers that name the server software. Their value stays `[redacted]` like any free text (it can carry hostnames,
 * addresses or contact data); only the product tokens read from it are stored. A header mapped to a product names it
 * by its own name and sends the version alone (`X-AspNet-Version: 4.0.30319`).
 */
export const PRODUCT_HEADERS: ReadonlyMap<string, string | null> = new Map([
  ['server', null],
  ['x-powered-by', null],
  ['x-generator', null],
  ['x-redirect-by', null],
  ['x-aspnet-version', 'ASP.NET'],
  ['x-aspnetmvc-version', 'ASP.NET MVC'],
]);

const MAX_PRODUCT_VERSIONS = 4;
const MAX_PRODUCT_LENGTH = 40;
const MAX_VERSION_LENGTH = 30;
/** Longer tokens cannot hold a valid pair and are not even sliced out of the value. */
const MAX_TOKEN_LENGTH = MAX_PRODUCT_LENGTH + 1 + MAX_VERSION_LENGTH;

/** A letter, then letters, digits, `_`, `+`, `-`. No dot: a dotted name cannot be told apart from a hostname. */
const PRODUCT_RE = /^[A-Za-z][A-Za-z0-9_+-]*$/;
/** Product names are words (`Oracle-Application-Server-10g`); more digits or a longer word is an identifier or a hash. */
const MAX_PRODUCT_DIGITS = 4;
const MAX_PRODUCT_WORD = 20;
/**
 * Numbers of at most eight digits joined by dots, an optional letter, then suffixes of at most ten characters
 * (`1.1.1f`, `8.1.2-1ubuntu2.14`, `9.4.43.v20210629`). Longer numbers or suffixes are identifiers rather than versions;
 * `@`, `:`, `/`, `?`, `;` and `%` never match. Only tested on at most `MAX_VERSION_LENGTH` characters.
 */
const VERSION_RE = /^\d{1,8}(?:\.\d{1,8})*[A-Za-z]?(?:[-+_.~][0-9A-Za-z]{1,10})*$/;
/** Four dotted numbers at the start read as an IPv4 address, also in octal or padded form (`10.0.0.1`, `0177.0.0.1`). */
const IPV4_START_RE = /^\d+(?:\.\d+){3}(?!\d)/;
/** The one dotted label shape that starts with a letter in a version: a letter and a build number (`v20210629`). */
const LETTER_LABEL_RE = /^[A-Za-z]\d+$/;
/** Eight or more hex digits with a letter among them: a hash, a UUID part or a token, not a word or a date. */
const HEX_ID_RE = /^(?=[0-9a-f]*[a-f])[0-9a-f]{8,}$/i;

/** A version of domain shape: a label that starts with a letter (`2.4.web01`, `1.w3b01`), or two labels with letters. */
function hostLikeVersion(version: string): boolean {
  const labels = version.split('.');
  if (labels.slice(1).some((label) => /^[A-Za-z]/.test(label) && !LETTER_LABEL_RE.test(label))) return true;
  return labels.filter((label) => /[A-Za-z]/.test(label)).length >= 2;
}

function validVersion(version: string): boolean {
  return (
    version.length <= MAX_VERSION_LENGTH &&
    VERSION_RE.test(version) &&
    !IPV4_START_RE.test(version) &&
    !hostLikeVersion(version) &&
    !version.split(/[-+_.~]/).some((part) => HEX_ID_RE.test(part))
  );
}

function validProduct(product: string): boolean {
  if (!PRODUCT_RE.test(product)) return false;
  if ((product.match(/\d/g)?.length ?? 0) > MAX_PRODUCT_DIGITS) return false;
  return product.split(/[-_+]/).every((word) => word.length <= MAX_PRODUCT_WORD && !HEX_ID_RE.test(word));
}

/** `name/version` of one token; `null` when either part is not of the strict shape. */
function productPair(token: string): ProductVersion | null {
  const slash = token.indexOf('/');
  if (slash < 1 || slash > MAX_PRODUCT_LENGTH) return null;
  const product = token.slice(0, slash);
  const version = token.slice(slash + 1);
  return validProduct(product) && validVersion(version) ? { product, version } : null;
}

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Blanks separate tokens; a comma only before a blank or at the end, as between joined fields (a URL path has commas). */
const isSeparator = (value: string, i: number): boolean =>
  isBlank(value[i]) || (value[i] === ',' && (i + 1 === value.length || isBlank(value[i + 1])));

/**
 * Product tokens of a value, passed to `take` until it returns false. Comments and quoted strings are skipped (RFC 9110
 * §5.6.4 and §5.6.5: comments nested, both with `\` escapes; an unclosed one hides the rest of the value). The grammar
 * puts a blank between a product and a comment, so a run of text glued to a comment or a quoted string (`a/(b)c/1`
 * inside a URL, the quoted local part of an e-mail address) yields no token at all. One linear pass, no expression over
 * the value.
 */
function forEachProductToken(value: string, take: (token: string) => boolean): void {
  let depth = 0;
  let quoted = false;
  /** Start of the current run of non-blank text, -1 between runs. */
  let start = -1;
  let enclosed = false;
  const end = (at: number): boolean => {
    const ok = start < 0 || enclosed || at - start > MAX_TOKEN_LENGTH || take(value.slice(start, at));
    start = -1;
    enclosed = false;
    return ok;
  };

  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (isSeparator(value, i)) {
      if (!end(i)) return;
      continue;
    }
    if (start < 0) start = i;
    if (c === '(' || c === '"') {
      enclosed = true;
      if (c === '(') depth = 1;
      else quoted = true;
    }
  }
  end(value.length);
}

/**
 * The product/version pairs of a product header, at most four and each once. Hosts, addresses, e-mail addresses, URLs
 * and comments are never kept: only tokens of the strict shape above pass.
 */
export function productVersionsOf(name: string, value: string): ProductVersion[] {
  const implied = PRODUCT_HEADERS.get(name.toLowerCase()) ?? null;
  const out: ProductVersion[] = [];

  forEachProductToken(value, (token) => {
    if (implied !== null) {
      // the version header sends one version: only its first token counts
      if (validVersion(token)) out.push({ product: implied, version: token });
      return false;
    }
    const pair = productPair(token);
    if (pair && !out.some((p) => p.product === pair.product && p.version === pair.version)) out.push(pair);
    return out.length < MAX_PRODUCT_VERSIONS;
  });
  return out;
}

/** URL headers have their URLs sanitized, value headers their embedded URLs, every other header loses its value. */
function sanitizedHeaderValue(name: string, value: string, base: string, sanitize: UrlSanitizer): string {
  if (URL_HEADERS.has(name)) return sanitizeUrlHeader(name, value, base, sanitize);
  if (VALUE_HEADERS.has(name)) return sanitizeUrlsIn(value, base, sanitize);
  return REDACTED;
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
  const sanitized = sanitizedHeaderValue(n, value, base, sanitize);
  const full = csp ? sanitizeSchemelessSources(sanitized) : sanitized;

  const truncated = full.length > MAX_HEADER_VALUE;
  const record: HeaderRecord = { name: n, value: truncated ? full.slice(0, MAX_HEADER_VALUE) : full };
  if (truncated) record.truncated = true;

  if (csp) {
    const fact = cspFrameAncestors(value);
    // a complete value of exactly the limit carries the fact too, or it could not be told from a cut value of an older snapshot
    if (truncated || fact.present || full.length >= MAX_HEADER_VALUE) record.frameAncestors = fact;
  }
  // also when empty: it tells a value without a version from an older snapshot that did not read the value
  if (PRODUCT_HEADERS.has(n)) record.productVersions = productVersionsOf(n, value);
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
