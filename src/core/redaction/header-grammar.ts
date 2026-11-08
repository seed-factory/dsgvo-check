import { hasAddressMarker, REDACTED } from '../url/email.ts';
import { hasIdLikeRun } from './page-names.ts';
import { DOT_SEGMENT } from './redact.ts';

export const MAX_HEADER_VALUE = 2048;

export type UrlSanitizer = (url: string) => string;

export type Grammar = (value: string, base: string, sanitize: UrlSanitizer) => string;

export const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

/**
 * A `[redacted]` the server wrote is text, not our mask: it is written so that no later step reads it as one (and
 * `alice[redacted]@host` keeps its `@`).
 */
export const literalMask = (text: string): string =>
  text.includes(REDACTED) ? text.replaceAll(REDACTED, '%5Bredacted%5D') : text;

export function absoluteSanitized(raw: string, base: string, sanitize: UrlSanitizer): string {
  try {
    return sanitize(new URL(raw.trim(), base).toString());
  } catch {
    return REDACTED;
  }
}

/** What the URL sanitizer leaves of an address it masked. */
export const ADDRESS_MASK = `${REDACTED}@`;
/** Leading `./` and `../` segments: they resolve away without taking any text of the URL with them. */
const LEADING_DOTS = /^(?:\.{1,2}\/)+/;
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*(?=:)/i;
const MAX_SCHEME = 20;

/** The text the URL parser reads: without leading C0 controls and blanks, without tabs and line breaks. */
function urlStart(raw: string): string {
  let from = 0;
  while (from < raw.length && raw.charCodeAt(from) <= 0x20) from++;
  return raw.slice(from).replace(/[\t\n\r]/g, '');
}

/**
 * `scheme:[redacted]` for a URL of another scheme than http(s): what follows the scheme is opaque text (`x:visitorId`,
 * `tel:+49…`). Null for a URL with http(s) or without a scheme.
 */
function otherSchemeUrl(raw: string): string | null {
  const scheme = SCHEME_PREFIX.exec(urlStart(raw))?.[0];
  if (scheme === undefined || /^https?$/i.test(scheme)) return null;
  return scheme.length <= MAX_SCHEME && !hasIdLikeRun(scheme)
    ? `${scheme.toLowerCase()}:${REDACTED}`
    : REDACTED;
}

/**
 * A URL of a header: http(s) resolved and sanitized, any other scheme `scheme:[redacted]`. An `@` the sanitizer does
 * not read as an address (`/u/alice@intranet`) makes it `[redacted]`.
 */
export function linkTarget(raw: string, base: string, sanitize: UrlSanitizer): string {
  const opaque = otherSchemeUrl(raw);
  if (opaque !== null) return opaque;
  const stored = absoluteSanitized(raw, base, sanitize);
  return hasAddressMarker(stored.replaceAll(ADDRESS_MASK, '')) ? REDACTED : stored;
}

/**
 * A URL reference (`/r?u=…`, `//host/r?u=…`, `r/x`, `https://host/x`), resolved against `base` and sanitized. When that
 * redacts nothing the token stays as written, without its fragment; not when it has a dot segment after its first
 * characters, which the parser resolves away together with the text before it. An `@` the sanitizer does not read as
 * an address (`/u/alice@intranet`, `/~alice@`) makes the whole token `[redacted]`; a token that does not parse keeps
 * no query. A token that is only a fragment is dropped. A reference with no `/`, `.` or `?` is a bare word, not a
 * path; another scheme than http(s) is opaque.
 */
export function referenceSanitized(token: string, base: string, sanitize: UrlSanitizer): string {
  const opaque = otherSchemeUrl(token);
  if (opaque !== null) return opaque;
  const written = token.replace(/#.*$/s, '');
  if (written === '') return '';
  if (!/^[a-z][a-z0-9+.-]*:|[/\\.?]/i.test(written)) return REDACTED;
  let stored: string;
  try {
    const href = new URL(written, base).href;
    const sanitized = sanitize(href);
    const kept = sanitized === href && !DOT_SEGMENT.test(`/${written.replace(LEADING_DOTS, '')}`);
    stored = kept ? written : sanitized;
  } catch {
    stored = written.replace(/\?.*$/s, `?${REDACTED}`);
  }
  return hasAddressMarker(stored.replaceAll(ADDRESS_MASK, '')) ? REDACTED : stored;
}

const ORIGIN_START = /^(?:https?|wss?):\/\//i;

/**
 * An origin written out (`https://host[:port]`), as the URL sanitizer writes it; path, query and fragment are dropped.
 * No http(s) or ws(s) scheme, user info or opaque origin: `[redacted]`.
 */
export function originOf(raw: string, sanitize: UrlSanitizer): string {
  if (!ORIGIN_START.test(raw)) return REDACTED;
  try {
    const url = new URL(raw);
    if (url.origin === 'null' || url.username || url.password) return REDACTED;
    return sanitize(`${url.origin}/`);
  } catch {
    return REDACTED;
  }
}

const MAX_NAME = 64;
/** A name the site chooses (a reporting group, a policy name): a token that is no identifier. */
export const siteName = (s: string): boolean =>
  s.length <= MAX_NAME && /^[A-Za-z0-9_-]+$/.test(s) && !hasIdLikeRun(s);

/** A Trusted Types policy name: letters, digits and `-#=_/.%`, no identifier, no address. */
export const policyName = (s: string): boolean =>
  s.length <= MAX_NAME && /^[\w#=/.%-]+$/.test(s) && !hasIdLikeRun(s) && !hasAddressMarker(s);

const MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
export const mediaType = (s: string): boolean => s.length <= 100 && MEDIA_TYPE.test(s) && !hasIdLikeRun(s);

export const REFERRER_POLICIES = words(
  'no-referrer no-referrer-when-downgrade origin origin-when-cross-origin same-origin strict-origin strict-origin-when-cross-origin unsafe-url',
);
