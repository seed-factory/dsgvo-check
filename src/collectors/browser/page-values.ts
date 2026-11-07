/**
 * Values the scanned page controls, reduced to what the browser collector keeps. Every `page.evaluate` runs in the
 * page's main world, whose script can replace `String`, `Array.prototype.push` or `RegExp.prototype.test` and edit the
 * logs of the init scripts, so what comes back is checked here, in Node: a token of a closed set of standard markup or
 * protocol, a value of a fixed grammar, a name, or nothing. The sets are standard markup and protocol tokens, so they
 * stay in code.
 */
import { hasIdLikeRun } from '../../core/redaction/page-names.ts';
import type { Box } from '../../core/snapshot/common.ts';
import { REDACTED, safeDecode } from '../../core/url/email.ts';

/** A string as the page returned it, '' for anything else, cut at `max` like the page code does. */
export function str(v: unknown, max = Number.POSITIVE_INFINITY): string {
  return typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : '';
}

/** A flag counts only when the page returned `true` itself: a string or an object is no answer. */
export const flag = (v: unknown): boolean => v === true;

/** A count of the page: a safe integer of at least 0, else 0. */
export function count(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** An array of the page, or none. */
export const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** A record of the page whose fields are read one by one. */
export const fields = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A box of four finite numbers, else null. */
export function box(v: unknown): Box | null {
  const b = fields(v);
  return finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height)
    ? { x: b.x, y: b.y, width: b.width, height: b.height }
    : null;
}

/** HTML "set of space-separated tokens": split on ASCII whitespace, compared ASCII case-insensitively. */
const tokensOf = (v: string): string[] =>
  v
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean);

/** Link types of `<a rel>` and `<area rel>` (HTML Standard, "Link types", and the registered extensions). */
const ANCHOR_LINK_TYPES: ReadonlySet<string> = new Set([
  'alternate',
  'author',
  'bookmark',
  'external',
  'help',
  'license',
  'next',
  'nofollow',
  'noopener',
  'noreferrer',
  'opener',
  'prev',
  'privacy-policy',
  'search',
  'tag',
  'terms-of-service',
  'me',
  'sponsored',
  'ugc',
]);

/** The known link types of an anchor's `rel`, lower case; undefined when none is left. */
export function anchorRel(raw: string): string | undefined {
  const kept = tokensOf(raw).filter((t) => ANCHOR_LINK_TYPES.has(t));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

/** The `<link rel>` and `Link` header types the scanner records: resource hints, preloads and stylesheets. */
const HINT_LINK_TYPES: ReadonlySet<string> = new Set([
  'preconnect',
  'dns-prefetch',
  'preload',
  'modulepreload',
  'prefetch',
  'prerender',
  'stylesheet',
]);

/** The hint types of a `rel`, whole tokens only, lower case; undefined when it names none. */
export function hintRel(raw: string): string | undefined {
  const kept = tokensOf(raw).filter((t) => HINT_LINK_TYPES.has(t));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

/** Request destinations of the Fetch Standard that `<link as>` and a `Link` header's `as` name. */
const FETCH_DESTINATIONS: ReadonlySet<string> = new Set([
  'audio',
  'document',
  'embed',
  'fetch',
  'font',
  'image',
  'json',
  'manifest',
  'object',
  'report',
  'script',
  'serviceworker',
  'sharedworker',
  'style',
  'track',
  'video',
  'worker',
  'xslt',
]);

/** `as` as a Fetch destination, lower case; undefined for anything else. */
export function fetchDestination(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  return FETCH_DESTINATIONS.has(v) ? v : undefined;
}

/** `<form method>`: an invalid value means GET (HTML, "method" attribute). */
export function formMethod(raw: string): 'get' | 'post' | 'dialog' {
  const v = raw.trim().toLowerCase();
  return v === 'post' || v === 'dialog' ? v : 'get';
}

/** `<script type>` keywords besides MIME types. */
const SCRIPT_TYPE_KEYWORDS: ReadonlySet<string> = new Set(['module', 'importmap', 'speculationrules']);
/** A top-level media type (`text`, `application`, the `javascript` of blocked scripts): a token without dots. */
const MIME_TYPE = /^[a-z][a-z0-9-]{0,39}$/;
/** Structured syntax suffixes of the IANA registry (RFC 6839 and later): `ld+json`, `svg+xml`. */
const MIME_SUFFIXES =
  'json|xml|ber|cbor|cbor-seq|der|fastinfoset|gzip|json-seq|jwt|sqlite3|tlv|wbxml|yaml|zip|zstd';
/**
 * A subtype of RFC 6838: a tree facet with its dotted name (`vnd.api`, `x.foo`), or a plain name with an optional
 * JavaScript version (`x-magento-init`, `javascript1.5`), then a registered suffix. A dot elsewhere would let a host
 * name or an address through (`max.mustermann+example.de`).
 */
const MIME_SUBTYPE = new RegExp(
  `^(?:(?:vnd|prs|x)\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*|[a-z0-9][a-z0-9-]*(?:\\d\\.\\d)?)(?:\\+(?:${MIME_SUFFIXES}))?$`,
);
const MAX_MIME_PART = 40;

/**
 * `<script type>` without MIME parameters, lower case: a keyword or a `type/subtype` MIME type in the grammar of RFC
 * 6838 without an id-like run (`text/plain` of a consent tool's blocked script, `module`, `application/ld+json`);
 * `other` for anything else, undefined when empty.
 */
export function scriptType(raw: string): string | undefined {
  const v = (raw.split(';')[0] ?? '').trim().toLowerCase();
  if (v === '') return undefined;
  if (SCRIPT_TYPE_KEYWORDS.has(v)) return v;
  const [type = '', subtype = '', ...rest] = v.split('/');
  const ok =
    rest.length === 0 &&
    MIME_TYPE.test(type) &&
    subtype.length <= MAX_MIME_PART &&
    MIME_SUBTYPE.test(subtype) &&
    !hasIdLikeRun(v);
  return ok ? v : 'other';
}

/** Methods a page sends that the records name; a page can give `fetch` any token as a method. */
const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'OPTIONS',
  'PATCH',
]);

export function requestMethod(raw: string): string {
  return HTTP_METHODS.has(raw) ? raw : 'OTHER';
}

/** GA4 and Meta Pixel event names (`page_view`, `PageView`, `purchase`); a value with an id-like run is no event name. */
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function isEventName(v: string): boolean {
  return EVENT_NAME.test(v) && !hasIdLikeRun(v);
}

/** Google Consent Mode parameters in the forms the tags send (`gcs=G100`, `gcd=13l3l3l3l1`, `npa=1`, `dma=0`). */
const CONSENT_SIGNAL_FORMS: Readonly<Record<string, RegExp>> = {
  gcs: /^G1[01-]{2}$/,
  gcd: /^1[0-9](?:[A-Za-z_-][0-9]){2,8}$/,
  npa: /^[01]$/,
  dma: /^[01]$/,
};

export function isConsentSignal(key: string, v: string): boolean {
  return CONSENT_SIGNAL_FORMS[key]?.test(v) ?? false;
}

/** A cookie path the records keep: `/`, `/shop`, `/wp-admin/`. */
const COOKIE_PATH = /^\/[A-Za-z0-9._~%+/-]*$/;
const MAX_COOKIE_PATH = 200;

/**
 * The path of a cookie as stored. The page chooses it (`document.cookie`, `Set-Cookie` of any response) and the
 * browser keeps any path that starts with `/`, query and address characters included, so only a plain path without an
 * id-like run in a segment passes, also once decoded; anything else is `[redacted]`. Segments are judged one by one:
 * across a `/` a year and a version (`/product2023/v2/`) would read as one base64 run. Keys and setter matching use
 * the raw path.
 */
export function storedCookiePath(path: string): string {
  const decoded = safeDecode(path);
  const plain =
    path.length <= MAX_COOKIE_PATH &&
    COOKIE_PATH.test(path) &&
    COOKIE_PATH.test(decoded) &&
    !decoded.includes('%') &&
    !decoded.split('/').some(hasIdLikeRun);
  return plain ? path : REDACTED;
}

const HOSTNAME = /^[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*$/;
const MAX_HOSTNAME = 253;

/** A lower-case host name as `location.hostname` gives it (no port, no user info, no path). */
export function isHostname(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_HOSTNAME && HOSTNAME.test(v);
}

/** No `=`, `;`, `,`, whitespace or control character: what RFC 6265 leaves out of a cookie name. */
const COOKIE_NAME = /^[^=;,\s\p{Cc}]{1,200}$/u;

export function isCookieName(v: unknown): v is string {
  return typeof v === 'string' && COOKIE_NAME.test(v);
}
