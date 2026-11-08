/**
 * Response headers as stored in snapshots and evidence, one normalizer for the HTTP collector and the browser. A kept
 * header is stored by its grammar: what its syntax allows is kept (keywords of closed sets, names and tokens that are
 * no identifiers, URLs resolved and sanitized), every other part is `[redacted]`, so text a server puts into a header
 * cannot reach a snapshot as free text. Headers without a grammar here keep no value; of `Set-Cookie` only the cookie
 * name is stored. Product headers keep their value redacted too and carry only the product/version pairs read from it.
 */

import type { FrameAncestorsFact, HeaderRecord, ProductVersion } from '../snapshot/common.ts';
import {
  containsAddress,
  decodeLenient,
  hasAddressMarker,
  maskEmails,
  maskObfuscatedEmails,
  QUOTED_LOCAL,
  REDACTED,
} from '../url/email.ts';
import { sanitizeUrl } from '../url/url.ts';
import { foldedName, hasIdLikeRun, KEY_READ_LIMIT, nameHoldsAddress, storedKey } from './page-names.ts';
import { DOT_SEGMENT } from './redact.ts';

export const MAX_HEADER_VALUE = 2048;

export type UrlSanitizer = (url: string) => string;

type Grammar = (value: string, base: string, sanitize: UrlSanitizer) => string;

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

/**
 * A `[redacted]` the server wrote is text, not our mask: it is written so that no later step reads it as one (and
 * `alice[redacted]@host` keeps its `@`).
 */
const literalMask = (text: string): string =>
  text.includes(REDACTED) ? text.replaceAll(REDACTED, '%5Bredacted%5D') : text;

function absoluteSanitized(raw: string, base: string, sanitize: UrlSanitizer): string {
  try {
    return sanitize(new URL(raw.trim(), base).toString());
  } catch {
    return REDACTED;
  }
}

/** What the URL sanitizer leaves of an address it masked. */
const ADDRESS_MASK = `${REDACTED}@`;
/** The quoted local part of an address with its `@` (`"alice smith"@`). */
const QUOTED_ADDRESS = new RegExp(`${QUOTED_LOCAL}@`, 'g');
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
function linkTarget(raw: string, base: string, sanitize: UrlSanitizer): string {
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
function referenceSanitized(token: string, base: string, sanitize: UrlSanitizer): string {
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
function originOf(raw: string, sanitize: UrlSanitizer): string {
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
const siteName = (s: string): boolean =>
  s.length <= MAX_NAME && /^[A-Za-z0-9_-]+$/.test(s) && !hasIdLikeRun(s);

/** A Trusted Types policy name: letters, digits and `-#=_/.%`, no identifier, no address. */
const policyName = (s: string): boolean =>
  s.length <= MAX_NAME && /^[\w#=/.%-]+$/.test(s) && !hasIdLikeRun(s) && !hasAddressMarker(s);

const MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const mediaType = (s: string): boolean => s.length <= 100 && MEDIA_TYPE.test(s) && !hasIdLikeRun(s);

const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const paramName = (s: string): boolean => PARAM_NAME.test(s) && !hasIdLikeRun(s);

/** Language, script, region, variant and singleton-extension subtags (RFC 5646: `en-US-u-ca-gregory`, `de-DE-x-private`), and `x-default`. */
const LANGUAGE_TAG =
  /^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}(?:-[A-Za-z0-9](?:-[A-Za-z0-9]{2,8}){1,5}){0,3}|x-default)$/i;
const languageTag = (s: string): boolean => s.length <= 35 && LANGUAGE_TAG.test(s) && !hasIdLikeRun(s);

const REFERRER_POLICIES = words(
  'no-referrer no-referrer-when-downgrade origin origin-when-cross-origin same-origin strict-origin strict-origin-when-cross-origin unsafe-url',
);

/**
 * End of the field at `from`: the next of `separators` outside a double-quoted string (`\` escapes inside). With
 * `quotes` off every separator ends a field, as the checks split the headers that have no quoted strings.
 */
function fieldEnd(value: string, from: number, separators: string, quotes = true): number {
  let quoted = false;
  for (let i = from; i < value.length; i++) {
    const c = value.charAt(i);
    if (!quotes) {
      if (separators.includes(c)) return i;
    } else if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (separators.includes(c)) return i;
  }
  return value.length;
}

/** `[field, separator, field, …, field]`; a separator inside a quoted string belongs to its field. */
function splitFields(value: string, separators: string, quotes = true): string[] {
  const out: string[] = [];
  for (let start = 0; ; ) {
    const end = fieldEnd(value, start, separators, quotes);
    out.push(value.slice(start, end));
    if (end >= value.length) return out;
    out.push(value.charAt(end));
    start = end + 1;
  }
}

/** `map` of the text of a part without its surrounding blanks, which stay where they were. */
function keepBlanks(part: string, map: (body: string) => string): string {
  const body = part.trim();
  if (body === '') return part;
  const at = part.indexOf(body);
  return part.slice(0, at) + map(body) + part.slice(at + body.length);
}

/**
 * The fields of a list header through `map` (field, index); separators and blanks as sent. Fields that map to `[redacted]`
 * one after the other are one: the consumers of these lists ignore what they do not know, and a long run of unknown
 * entries must not grow the stored value past the limit and push a directive that decides a verdict out of it. Empty
 * fields between them go with them.
 */
function mapFields(
  value: string,
  separators: string,
  map: (field: string, index: number) => string,
  quotes = true,
): string {
  const parts = splitFields(value, separators, quotes);
  const out: string[] = [];
  let afterMask = false;
  /** Entries after the last mask: separators and empty fields. */
  let tail = 0;
  for (const [i, part] of parts.entries()) {
    if (i % 2 === 1 || part.trim() === '') {
      out.push(part);
      if (afterMask) tail++;
      continue;
    }
    const mapped = keepBlanks(part, (body) => map(body, i / 2));
    if (mapped.trim() !== REDACTED) {
      afterMask = false;
      out.push(mapped);
    } else if (afterMask) {
      out.length -= tail;
      tail = 0;
    } else {
      afterMask = true;
      tail = 0;
      out.push(mapped);
    }
  }
  return out.join('');
}

const MAX_AGE_DIGITS = 15;

/**
 * `max-age`, `includeSubDomains` and `preload`. HSTS-01 and the TLS checks read the value without regard to quotes: they
 * cut it at the commas that have an even number of `"` after them and split the first part at every `;`. The stored
 * value is cut at the same places and keeps no quote, so that reading it gives the verdict of the value as sent. The
 * name of a directive stays when its value is not allowed (`max-age=[redacted]`), so that a repeated directive still
 * reads as repeated. A `max-age` of more digits than browsers tell apart is written as 15 nines (or 0).
 */
function hstsDirective(field: string): string {
  const eq = field.indexOf('=');
  const name = (eq < 0 ? field : field.slice(0, eq)).trim();
  const key = name.toLowerCase();
  if (key !== 'max-age' && key !== 'includesubdomains' && key !== 'preload') return REDACTED;
  if (eq < 0) return field;
  const digits = key === 'max-age' ? /^"?(\d+)"?$/.exec(field.slice(eq + 1).trim())?.[1] : undefined;
  if (digits === undefined) return `${name}=${REDACTED}`;
  return `${name}=${digits.length <= MAX_AGE_DIGITS ? digits : /^0+$/.test(digits) ? '0' : '9'.repeat(MAX_AGE_DIGITS)}`;
}

const strictTransportSecurity: Grammar = (value) => {
  let quotesAfter = (value.match(/"/g) ?? []).length;
  let out = '';
  let start = 0;
  const flush = (end: number): void => {
    out += mapFields(value.slice(start, end), ';', hstsDirective, false);
  };
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '"') quotesAfter--;
    else if (c === ',' && quotesAfter % 2 === 0) {
      flush(i);
      out += ',';
      start = i + 1;
    }
  }
  flush(value.length);
  return out;
};

const REPORT_TO = /^report-to="?([A-Za-z0-9_-]+)"?$/i;

/**
 * A list header of keywords from a closed set, and optionally the reporting group of the cross-origin policies, which
 * are structured fields with quoted strings. The other lists have none: every separator ends a keyword, as the checks read them.
 */
const keywordList =
  (keywords: ReadonlySet<string>, separators: string, reporting = false): Grammar =>
  (value) =>
    mapFields(
      value,
      separators,
      (field) => {
        if (keywords.has(field.toLowerCase())) return field;
        const group = reporting ? REPORT_TO.exec(field)?.[1] : undefined;
        return group !== undefined && siteName(group) ? field : REDACTED;
      },
      reporting,
    );

/** `ALLOWALL` is no valid value, but HDR-01 reads it next to a conflicting one; a quote or `;` around a keyword stays, it is the misconfiguration. */
const FRAME_KEYWORD = /^["']?(?:deny|sameorigin|allowall)["']?;?$/i;
const ALLOW_FROM = /^allow-from\s+(\S+)$/i;

const xFrameOptions: Grammar = (value, _base, sanitize) =>
  mapFields(
    value,
    ',',
    (field) => {
      if (FRAME_KEYWORD.test(field)) return field;
      const origin = ALLOW_FROM.exec(field)?.[1];
      return origin === undefined ? REDACTED : `ALLOW-FROM ${originOf(origin, sanitize)}`;
    },
    false,
  );

const xXssProtection: Grammar = (value, base, sanitize) =>
  mapFields(value, ';', (field) => {
    if (/^(?:0|1|mode=block)$/i.test(field)) return field;
    return /^report=/i.test(field)
      ? `report=${referenceSanitized(field.slice(7), base, sanitize)}`
      : REDACTED;
  });

/** The features of the Permissions Policy registry, the ones browsers ship or trial, and the client hint features (a closed list: a name that is open at its end could carry an id). */
const POLICY_FEATURES = words(
  'ch-ua ch-ua-arch ch-ua-bitness ch-ua-form-factors ch-ua-full-version ch-ua-full-version-list ch-ua-mobile ch-ua-model ch-ua-platform ch-ua-platform-version ch-ua-wow64 ch-device-memory ch-dpr ch-width ch-viewport-width ch-viewport-height ch-downlink ch-ect ch-rtt ch-save-data ch-prefers-color-scheme ch-prefers-reduced-motion ch-prefers-reduced-transparency accelerometer all-screens-capture ambient-light-sensor attribution-reporting autofill autoplay battery bluetooth browsing-topics camera captured-surface-control clipboard-read clipboard-write compute-pressure conversion-measurement cross-origin-isolated deferred-fetch deferred-fetch-minimal digital-credentials-get direct-sockets display-capture document-domain encrypted-media execution-while-not-rendered execution-while-out-of-viewport focus-without-user-activation fullscreen gamepad geolocation gyroscope hid identity-credentials-get idle-detection interest-cohort join-ad-interest-group keyboard-map language-detector language-model layout-animations legacy-image-formats local-fonts local-network-access magnetometer microphone midi navigation-override notifications on-device-speech-recognition otp-credentials oversized-images payment picture-in-picture popins private-aggregation private-state-token-issuance private-state-token-redemption publickey-credentials-create publickey-credentials-get push rewriter run-ad-auction screen-wake-lock serial shared-autofill shared-storage shared-storage-select-url smart-card speaker speaker-selection storage-access summarizer sync-script sync-xhr translator trust-token-redemption unload unoptimized-images unsized-media usb vertical-scroll vibrate vr wake-lock web-printing web-share window-management window-placement writer xr-spatial-tracking',
);
const POLICY_ENTRY = /^([A-Za-z][A-Za-z0-9-]*)=(\*|self|\(([^()]*)\))([\s\S]*)$/i;
const POLICY_KEYWORD = /^(?:self|src|\*)$/i;
const POLICY_PARAM = /^report-to\s*=\s*"?([A-Za-z0-9_-]+)"?$/i;

/** The members of an allowlist: keywords and quoted origins, of which only the origin is kept. */
function policyMembers(inner: string, sanitize: UrlSanitizer): string {
  const list = inner.trim() === '' ? [] : inner.trim().split(/\s+/);
  return list
    .map((member) => {
      if (POLICY_KEYWORD.test(member)) return member;
      if (!/^"[^"]*"$/.test(member)) return REDACTED;
      const origin = originOf(member.slice(1, -1), sanitize);
      return origin === REDACTED ? origin : `"${origin}"`;
    })
    .join(' ');
}

/**
 * `feature=(self "https://origin");report-to=group`: a feature of the registry, keywords and quoted origins (all that
 * is kept of a URL), and the reporting group as a structured field parameter.
 */
const permissionsPolicy: Grammar = (value, _base, sanitize) =>
  mapFields(value, ',', (field) => {
    const m = POLICY_ENTRY.exec(field);
    const feature = m?.[1] ?? '';
    const known = POLICY_FEATURES.has(feature.toLowerCase());
    const tail = m?.[4] ?? '';
    if (!m || !known || (tail.trim() !== '' && !tail.trimStart().startsWith(';'))) return REDACTED;

    const allowlist = m[3] === undefined ? (m[2] ?? '') : `(${policyMembers(m[3], sanitize)})`;
    const params = mapFields(tail, ';', (param) => {
      const group = POLICY_PARAM.exec(param)?.[1];
      return group !== undefined && siteName(group) ? param : REDACTED;
    });
    return `${feature}=${allowlist}${params}`;
  });

const CHARSET = /^"?([A-Za-z0-9_.:-]{1,40})"?$/;

/** `type/subtype`, the charset, and the names of other parameters (`boundary`, `token`) without their values; a parameter with an address marker is `[redacted]` whole, its name may be a local part. */
const contentType: Grammar = (value) =>
  mapFields(value, ';', (field, index) => {
    if (index === 0) return mediaType(field) ? field : REDACTED;
    const eq = field.indexOf('=');
    const name = field.slice(0, Math.max(eq, 0)).trim();
    if (eq < 0 || !paramName(name) || hasAddressMarker(field)) return REDACTED;
    const charset = CHARSET.exec(field.slice(eq + 1).trim())?.[1];
    const keep = name.toLowerCase() === 'charset' && charset !== undefined && !hasIdLikeRun(charset);
    return `${name}=${keep ? field.slice(eq + 1).trim() : REDACTED}`;
  });

const contentLanguage: Grammar = (value) =>
  mapFields(value, ',', (field) => (languageTag(field) ? field : REDACTED));

const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Seconds (at most seven digits, about 115 days) or an HTTP date. */
const retryAfter: Grammar = (value) =>
  /^\d{1,7}$/.test(value.trim()) || HTTP_DATE.test(value.trim()) ? value : REDACTED;

const LINK_RELATIONS = words(
  'about alternate amphtml appendix apple-touch-icon apple-touch-icon-precomposed archives author authorization_endpoint blocked-by bookmark canonical chapter cite-as collection compression-dictionary contents convertedfrom copyright create-form current deprecation describedby describes disclosure dns-prefetch duplicate edit edit-form expect edit-media enclosure external first glossary help hosts hub icon index item last latest-version license linkset lrdd manifest mask-icon me media-feed memento micropub modulepreload monitor monitor-group next next-archive nofollow noopener noreferrer ohttp-keys opener openid2.local_id openid2.provider original p3pv1 payment pgpkey pingback preconnect predecessor-version prefetch preload prerender prev prev-archive preview previous privacy-policy profile publication rdap-active rdap-bottom rdap-down rdap-top rdap-up related replies restconf ruleinput search section self service service-desc service-doc service-meta shortlink sip-trunking-capability sponsored start status stylesheet subsection successor-version sunset tag terms-of-service timegate timemap token_endpoint type ugc up version-history via webmention working-copy working-copy-of',
);
const LINK_DESTINATIONS = words(
  'audio document embed fetch font image manifest object report script serviceworker sharedworker style track video worker xslt',
);
const MEDIA_FEATURE =
  /^(?:(?:min-|max-)?(?:width|height|aspect-ratio|resolution|device-width|device-height|device-aspect-ratio|color|monochrome|-webkit-device-pixel-ratio|device-pixel-ratio)|orientation|scan|grid|hover|pointer|any-hover|any-pointer|prefers-color-scheme|prefers-reduced-motion|prefers-contrast|prefers-reduced-transparency|display-mode|forced-colors|inverted-colors|update|overflow-block|overflow-inline|color-gamut|dynamic-range)$/i;
const MEDIA_IDENTS = words(
  'landscape portrait dark light reduce no-preference more less custom none fine coarse hover standalone fullscreen minimal-ui browser srgb p3 rec2020 high standard slow fast progressive interlace',
);
const MEDIA_NUMBER =
  /^\d{1,5}(?:\.\d{1,3})?(?:px|em|rem|dppx|dpi|dpcm|x|vw|vh|cm|mm|in|pt|pc)?$|^\d{1,4}\/\d{1,4}$/;
const MEDIA_KEYWORDS = words('all print screen speech and not only or ,');
/** `(feature)` or `(feature: value)` of a media query. */
const MEDIA_CONDITION = /^\(\s*([a-z-]{1,40})\s*(?::\s*([\w./-]{1,20})\s*)?\)$/i;

/** A media query list: media types, `and`, `not`, `only`, `or`, commas, and conditions on the features of the registry. */
function mediaQuery(inner: string): string {
  const parts = inner.match(/\([^()]*\)|[^\s(),]+|,/g) ?? [];
  const ok = parts.every((part) => {
    if (MEDIA_KEYWORDS.has(part.toLowerCase())) return true;
    const m = MEDIA_CONDITION.exec(part);
    const value = m?.[2];
    return (
      m !== null &&
      MEDIA_FEATURE.test(m[1] ?? '') &&
      (value === undefined || MEDIA_NUMBER.test(value) || MEDIA_IDENTS.has(value.toLowerCase()))
    );
  });
  return ok && parts.length > 0 ? parts.join(' ').replace(/ ,/g, ',') : REDACTED;
}

/** Each blank-separated word through `word`; a list with no word is no value. */
function eachWord(inner: string, word: (w: string) => string): string {
  const list = inner.split(/\s+/).filter(Boolean);
  return list.length === 0 ? REDACTED : list.map(word).join(' ');
}

const wordOf = (allowed: ReadonlySet<string>) => (inner: string) =>
  eachWord(inner, (w) => (allowed.has(w.toLowerCase()) ? w : REDACTED));

type LinkValue = (inner: string, base: string, sanitize: UrlSanitizer) => string;

/** Link parameters by name: the grammar of the value. A name not listed here is `[redacted]` with its value. */
const relations: LinkValue = (inner, base, sanitize) =>
  eachWord(inner, (w) => {
    if (LINK_RELATIONS.has(w.toLowerCase())) return w;
    return /^https?:\/\//i.test(w) ? linkTarget(w, base, sanitize) : REDACTED;
  });

const LINK_PARAMS: ReadonlyMap<string, LinkValue> = new Map<string, LinkValue>([
  ['rel', relations],
  ['rev', relations],
  ['as', wordOf(LINK_DESTINATIONS)],
  [
    'crossorigin',
    (inner) => (inner === '' || /^(?:anonymous|use-credentials)$/i.test(inner) ? inner : REDACTED),
  ],
  ['fetchpriority', wordOf(words('high low auto'))],
  ['referrerpolicy', wordOf(REFERRER_POLICIES)],
  ['blocking', wordOf(words('render'))],
  ['type', (inner) => (mediaType(inner) ? inner : REDACTED)],
  ['hreflang', (inner) => (languageTag(inner) ? inner : REDACTED)],
  ['media', (inner) => mediaQuery(inner)],
  [
    'integrity',
    (inner) =>
      eachWord(inner, (w) => {
        const algorithm = /^(sha256|sha384|sha512)-/i.exec(w)?.[1];
        return algorithm === undefined ? REDACTED : `${algorithm}-${REDACTED}`;
      }),
  ],
  ['anchor', (inner, base, sanitize) => referenceSanitized(inner, base, sanitize)],
]);
/** Parameters that carry text or lists of URLs: only their names are kept. */
const LINK_TEXT_PARAMS = words('title title* imagesrcset imagesizes nopush');

function linkParam(body: string, base: string, sanitize: UrlSanitizer): string {
  const eq = body.indexOf('=');
  const name = (eq < 0 ? body : body.slice(0, eq)).trim();
  const key = name.toLowerCase();
  const grammar = LINK_PARAMS.get(key);
  if (!grammar && !LINK_TEXT_PARAMS.has(key)) return REDACTED;
  if (eq < 0) return name;

  const raw = body.slice(eq + 1).trim();
  const quoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"');
  const safe = grammar?.(quoted ? raw.slice(1, -1) : raw, base, sanitize) ?? REDACTED;
  return `${name}=${quoted && safe !== REDACTED ? `"${safe}"` : safe}`;
}

/**
 * `<target>; name=value, <target>…`: targets resolved and sanitized, parameters by `LINK_PARAMS`. Anything else, such
 * as a URL without brackets or a target left open, is `[redacted]` up to the next separator. One pass, which stops
 * once the output passes the limit: after an open target the rest of the value is one `[redacted]`.
 */
const linkValue: Grammar = (value, base, sanitize) => {
  let out = '';
  let i = 0;
  /** The last thing written was a parameter or stray text that is `[redacted]` whole; the next one adds nothing. */
  let afterMask = false;
  while (i < value.length && out.length <= MAX_HEADER_VALUE) {
    const c = value.charAt(i);
    if (c === ',' || /\s/.test(c)) {
      out += c;
      if (c === ',') afterMask = false;
      i++;
    } else if (c === '<') {
      const close = value.indexOf('>', i + 1);
      if (close < 0) return out + REDACTED;
      out += `<${linkTarget(value.slice(i + 1, close), base, sanitize)}>`;
      afterMask = false;
      i = close + 1;
    } else {
      const end = fieldEnd(value, c === ';' ? i + 1 : i, ';,');
      const piece =
        c === ';'
          ? `;${keepBlanks(value.slice(i + 1, end), (body) => linkParam(body, base, sanitize))}`
          : REDACTED;
      const mask = piece.replace(/^;/, '').trim() === REDACTED;
      if (!mask || !afterMask) out += piece;
      afterMask = mask;
      i = end;
    }
  }
  return out;
};

/** Line terminators of JavaScript, which `.` does not match: no refresh address may hold one. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const REFRESH_DELAY = /^[\d.]+/;
const MAX_DELAY_RUN = 11;
const MAX_DELAY_DIGITS = 7;

/**
 * `Refresh` / `<meta http-equiv="refresh">`: `<delay>[;|, [url=]['"]<address>['"]]`; `null` when the value is no refresh.
 * Trims by hand in linear passes: a lazy `(.*?)` before `\s*$` was quadratic on a long run of spaces in untrusted HTML.
 */
function parseRefresh(value: string): { delay: string; address: string } | null {
  const afterSpace = value.trimStart();
  const delay = REFRESH_DELAY.exec(afterSpace)?.[0];
  // a longer number is an identifier, not a delay
  if (!delay || delay.length > MAX_DELAY_RUN || delay.replaceAll('.', '').length > MAX_DELAY_DIGITS)
    return null;

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

const refresh: Grammar = (value, base, sanitize) => {
  const parsed = parseRefresh(value);
  if (!parsed) return REDACTED;
  return parsed.address ? `${parsed.delay}; url=${linkTarget(parsed.address, base, sanitize)}` : parsed.delay;
};

const location: Grammar = (value, base, sanitize) => linkTarget(value, base, sanitize);

/** CSP headers: the frame-ancestors fact is derived from the complete value. */
const CSP_HEADERS: ReadonlySet<string> = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
]);

/** Sources that match every network origin (`*`, a bare scheme): such a list does not restrict framing. */
const UNRESTRICTED_SOURCES: ReadonlySet<string> = new Set(['*', 'https:', 'http:']);
const MAX_FRAME_ANCESTOR_SOURCES = 20;
const MAX_SOURCE_LENGTH = 200;

/** Directives of CSP 1 to 3 and the ones browsers or vendors added; any other name is `[redacted]`. */
const CSP_DIRECTIVES = words(
  'default-src script-src script-src-elem script-src-attr style-src style-src-elem style-src-attr img-src font-src connect-src media-src object-src child-src frame-src worker-src manifest-src prefetch-src base-uri form-action frame-ancestors navigate-to sandbox plugin-types report-uri report-to upgrade-insecure-requests block-all-mixed-content require-sri-for require-trusted-types-for trusted-types referrer reflected-xss disown-opener webrtc fenced-frame-src',
);
/** Quoted keywords of a source list; a nonce or hash keeps its kind and loses its payload, any other quoted token is `[redacted]`. */
const CSP_KEYWORDS: ReadonlySet<string> = new Set(
  [
    'self',
    'none',
    'unsafe-inline',
    'unsafe-eval',
    'unsafe-hashes',
    'strict-dynamic',
    'report-sample',
    'wasm-unsafe-eval',
    'inline-speculation-rules',
    'script',
    'allow-duplicates',
    'block',
    'allow',
    'trusted-types-eval',
    'unsafe-allow-redirects',
    'report-sha256',
    'report-sha384',
    'report-sha512',
  ].map((keyword) => `'${keyword}'`),
);
const CSP_SECRET_SOURCE = /^'(nonce|sha256|sha384|sha512|report-sha256|report-sha384|report-sha512)-[^']*'$/i;
/** Schemes of a source list: the web ones, browser internals and the schemes of app webviews. */
const CSP_SCHEMES = words(
  'http: https: ws: wss: ftp: data: blob: filesystem: mediastream: about: chrome: chrome-extension: moz-extension: safari-extension: resource: android-webview-video-poster: capacitor: content: file: gap: ionic: mailto: ms-appx: ms-appx-web: tel: webcal:',
);
const schemeSource = (token: string): boolean => CSP_SCHEMES.has(token.toLowerCase());
const CSP_URL_SCHEME = /^(?:https?|wss?|ftp)$/i;
const SANDBOX_TOKENS = words(
  'allow-downloads allow-downloads-without-user-activation allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation allow-top-navigation-by-user-activation allow-top-navigation-to-custom-protocols',
);

/** The host part of a host-source: `*.example.com`, `example.com`, an IPv6 literal or `*`; letters of any script. */
const HOST_PATTERN = String.raw`(?:\*\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.?|\[[0-9a-f:.]+\]|\*`;
/** `[scheme://]host[:port]` and whatever follows; the rest is judged by `hostSource`. */
const HOST_SOURCE_RE = new RegExp(
  `^(?:([a-z][a-z0-9+.-]*)://)?(${HOST_PATTERN})(?::(\\d{1,5}|\\*))?([^]*)$`,
  'iu',
);
/** A host source names a host: it has a dot, is `localhost`, an IPv6 literal or `*`; a single word is not one. */
const namedHost = (host: string): boolean =>
  host === '*' || host.startsWith('[') || /^localhost\.?$/i.test(host) || /[^.]\.[^.]/.test(host);
/** What a path of a source may hold; `%` is left out, so an encoded address never gets through. */
const CLEAN_PATH = /^[\w.~@+/-]*$/;
/** A path segment with an `@` is a package scope (`@scope`) or a numeric version (`pkg@1.2.3-beta.1`); `a@2x.host` is an address. */
const AT_SEGMENT = /^@[\w.~+-]+$|^[\w.~+-]+@\d{1,8}(?:\.\d{1,8}){0,2}(?:[-+][\w.]{1,20})?$/;

interface HostSource {
  scheme: string | undefined;
  hostPort: string;
  tail: string;
}

/**
 * Does an address of the token (also percent-encoded) take the host for its local part (`alice.smith?@mail.test`,
 * `alice.smith/@mail.test`)? An address further inside the path leaves the host a host.
 */
function addressReachesHost(token: string, lead: string, host: string): boolean {
  let current = token;
  for (let round = 0; round <= 3; round++) {
    if (maskEmails(current) !== current && !maskEmails(current).startsWith(lead + host)) return true;
    const next = decodeLenient(current);
    if (next === current) return false;
    current = next;
  }
  return false;
}

/** A token read as `[scheme://]host[:port]` followed by nothing or a path, query or fragment; user info, an address and junk are `null`. */
function hostSource(token: string): HostSource | null {
  const m = HOST_SOURCE_RE.exec(token);
  const tail = m?.[4] ?? '';
  if (!m || (tail !== '' && !'/?#'.includes(tail.charAt(0)))) return null;
  if (!namedHost(m[2] ?? '') || (m[1] !== undefined && !CSP_URL_SCHEME.test(m[1]))) return null;
  if (addressReachesHost(token, m[1] === undefined ? '' : `${m[1]}://`, m[2] ?? '')) return null;
  return { scheme: m[1], hostPort: `${m[2]}${m[3] ? `:${m[3]}` : ''}`, tail };
}

const hostOnly = (source: HostSource): string =>
  `${source.scheme === undefined ? '' : `${source.scheme}://`}${source.hostPort}`;

/** The path of a source when it is a plain one: name-like segments, no address, no ID-like run. Else nothing. */
function plainPath(tail: string): string {
  const path = tail.split(/[?#]/, 1)[0] ?? '';
  if (!CLEAN_PATH.test(path) || containsAddress(path)) return '';
  const plain = path
    .split('/')
    .every((segment) => (!segment.includes('@') || AT_SEGMENT.test(segment)) && !hasIdLikeRun(segment));
  return plain ? path : '';
}

/** A quoted keyword, else `[redacted]`. */
const quotedKeyword = (token: string): string => (CSP_KEYWORDS.has(token.toLowerCase()) ? token : REDACTED);

/**
 * A source of a directive that hides an address: keyword, `*`, a scheme, a source with a scheme and a named host, and
 * the domain of an address mask. A host without a scheme may be the local part (`alice.smith (at) …`): `[redacted]`.
 */
function hiddenSource(token: string, name: string): string {
  const mask = name === 'report-uri' ? MASK_DOMAIN.exec(token) : null;
  if (mask) return hasIdLikeRun(mask[1] ?? '') ? REDACTED : `${REDACTED}@${mask[1]}`;
  const source = token.startsWith("'") || token === '*' || schemeSource(token) ? null : hostSource(token);
  return source && source.scheme === undefined ? REDACTED : hostOnlySource(token);
}

/**
 * A source reduced to what the facts need: keyword, `*`, a scheme of the closed list, or `[scheme://]host[:port]` of a
 * named host. User info, addresses, path, query and fragment are dropped and anything else is `[redacted]`. Idempotent.
 */
function hostOnlySource(token: string): string {
  if (token === '*' || schemeSource(token)) return token;
  if (token.startsWith("'")) return quotedKeyword(token);
  const source = hostSource(token);
  return source ? hostOnly(source).slice(0, MAX_SOURCE_LENGTH) : REDACTED;
}

/**
 * One source expression of a CSP value: a keyword, a nonce or hash with the payload `[redacted]`, `*`, a scheme, or a
 * host source. Of a host source scheme, host and port stay; the path of an http(s) one too when it is plain (it goes
 * through the collector's sanitizer).
 */
function cspSource(token: string, base: string, sanitize: UrlSanitizer): string {
  if (token.startsWith("'")) {
    const secret = CSP_SECRET_SOURCE.exec(token);
    return secret ? `'${secret[1]}-${REDACTED}'` : quotedKeyword(token);
  }
  const source = hostSource(token);
  if (!source || !/^https?$/i.test(source.scheme ?? '')) return hostOnlySource(token);
  return absoluteSanitized(`${hostOnly(source)}${plainPath(source.tail)}`, base, sanitize);
}

/** A `report-uri` value: a URL reference through the sanitizer; one with a quote or bracket is cut to scheme and host. */
function cspUrl(token: string, base: string, sanitize: UrlSanitizer): string {
  if (/["'<>]/.test(token)) {
    const source = hostSource(token);
    return source && /^https?$/i.test(source.scheme ?? '') ? hostOnly(source) : REDACTED;
  }
  return referenceSanitized(token, base, sanitize);
}

const CSP_VALUES: ReadonlyMap<string, (token: string, base: string, sanitize: UrlSanitizer) => string> =
  new Map([
    ['report-uri', cspUrl],
    ['report-to', (token) => (siteName(token) ? token : REDACTED)],
    ['sandbox', (token) => (SANDBOX_TOKENS.has(token.toLowerCase()) ? token : REDACTED)],
    ['plugin-types', (token) => (mediaType(token) ? token : REDACTED)],
    ['require-sri-for', (token) => (/^(?:script|style)$/i.test(token) ? token : REDACTED)],
    ['referrer', (token) => (REFERRER_POLICIES.has(token.toLowerCase()) ? token : REDACTED)],
    ['reflected-xss', (token) => (/^(?:allow|block|filter)$/i.test(token) ? token : REDACTED)],
    [
      'trusted-types',
      (token, base, sanitize) => (policyName(token) ? token : cspSource(token, base, sanitize)),
    ],
  ]);

/** What is left of an address that was written to hide: the local part, words, `(dot)` and `@` around it. */
const HIDDEN_MARKER = /[([]\s*(?:at|dot|punkt)\s*[)\]]|(?:^|\s)(?:@|%(?:25)*40)|(?:@|%(?:25)*40)(?:\s|$)/i;
/** The mask of an address and its domain, at the start of a token; what follows the domain is cut. */
const MASK_DOMAIN = /^\[redacted\]@((?:[\p{L}\p{N}-]+\.)*[\p{L}\p{N}-]+)/u;

/**
 * An address in the `(at)` form or with a quoted local part is masked on the whole value first: blanks inside it would
 * make its local part a token of its own.
 */
const maskedCsp = (value: string): string =>
  maskObfuscatedEmails(literalMask(value).replace(QUOTED_ADDRESS, ADDRESS_MASK));

/** A segment that holds a mask of ours or a marker of a hidden address: its words may be the local part. */
const hidesAddress = (segment: string): boolean =>
  segment.includes(ADDRESS_MASK) || HIDDEN_MARKER.test(segment);

/**
 * `[text, separator, text, …]` of a CSP value at `;` and at a comma between policies. A comma glued to the text after
 * it inside a URL with a query or fragment (`?ids=1,2`) belongs to that URL.
 */
function cspSegments(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let query = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (/\s/.test(c)) query = false;
    else if (c === '?' || c === '#') query = true;
    else if (
      c === ';' ||
      (c === ',' && (!query || i + 1 === value.length || /\s/.test(value.charAt(i + 1))))
    ) {
      out.push(value.slice(start, i), c);
      start = i + 1;
      query = false;
    }
  }
  out.push(value.slice(start));
  return out;
}

/**
 * One directive: its name from the list of directives, then the tokens by the grammar of that name. In a directive
 * that hides an address only keywords, `*`, schemes, hosts with a scheme and the domain of the mask of a `report-uri`
 * stay. Stops
 * once the output passes the limit.
 */
function cspDirective(text: string, base: string, sanitize: UrlSanitizer): string {
  const hidden = hidesAddress(text);
  const value = (name: string, token: string): string => {
    if (hidden) return hiddenSource(token, name);
    return (CSP_VALUES.get(name) ?? cspSource)(token, base, sanitize);
  };

  let out = '';
  let last = 0;
  let name = '';
  let index = 0;
  for (const m of text.matchAll(/\S+/g)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (index++ === 0) {
      name = CSP_DIRECTIVES.has(m[0].toLowerCase()) ? m[0].toLowerCase() : '';
      out += name === '' ? REDACTED : m[0];
    } else out += value(name, m[0]);
    if (out.length > MAX_HEADER_VALUE) return out;
  }
  return out + text.slice(last);
}

const contentSecurityPolicy: Grammar = (value, base, sanitize) => {
  let out = '';
  /** The last directive of this policy is `[redacted]` whole; the next such one adds nothing, the facts come from the value as sent. */
  let afterMask = false;
  const segments = cspSegments(maskedCsp(value));
  for (let i = 0; i < segments.length; i += 2) {
    const separator = segments[i - 1] ?? '';
    const directive = cspDirective(segments[i]!, base, sanitize);
    const mask = directive.trim() === REDACTED;
    if (separator === ',') afterMask = false;
    if (mask && afterMask && separator === ';') continue;
    out += separator + directive;
    afterMask = mask;
    if (out.length > MAX_HEADER_VALUE) break;
  }
  return out;
};

/**
 * `frame-ancestors` of a CSP value, which may hold several comma-joined policies; one policy with the directive and
 * no wildcard source restricts framing, an empty list restricts like `'none'`. Both are read from the policy as sent.
 * Stored `sources` come from the masked tokens of the stored form, reduced to scheme, host and port.
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
        const masked = maskedCsp(part);
        const tokens = masked.trim().split(/\s+/).slice(1);
        const source = hidesAddress(masked) ? hiddenSource : hostOnlySource;
        sources = tokens.slice(0, MAX_FRAME_ANCESTOR_SOURCES).map((token) => source(token, ''));
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

/** The grammar of every header whose value is kept; any other header loses its value. */
const HEADER_GRAMMARS: ReadonlyMap<string, Grammar> = new Map([
  ['content-security-policy', contentSecurityPolicy],
  ['content-security-policy-report-only', contentSecurityPolicy],
  ['strict-transport-security', strictTransportSecurity],
  ['x-frame-options', xFrameOptions],
  ['x-content-type-options', keywordList(words('nosniff'), ',')],
  ['x-xss-protection', xXssProtection],
  ['referrer-policy', keywordList(REFERRER_POLICIES, ',')],
  ['permissions-policy', permissionsPolicy],
  [
    'cross-origin-opener-policy',
    keywordList(words('unsafe-none same-origin-allow-popups same-origin noopener-allow-popups'), ';,', true),
  ],
  ['cross-origin-embedder-policy', keywordList(words('unsafe-none require-corp credentialless'), ';,', true)],
  ['cross-origin-resource-policy', keywordList(words('same-site same-origin cross-origin'), ';,')],
  ['content-type', contentType],
  ['content-language', contentLanguage],
  ['retry-after', retryAfter],
  ['link', linkValue],
  ['location', location],
  ['content-location', location],
  ['refresh', refresh],
]);

function sanitizedHeaderValue(name: string, value: string, base: string, sanitize: UrlSanitizer): string {
  return HEADER_GRAMMARS.get(name)?.(literalMask(value), base, sanitize) ?? REDACTED;
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
  const full = sanitizedHeaderValue(n, value, base, sanitize);

  const truncated = full.length > MAX_HEADER_VALUE;
  const record: HeaderRecord = {
    name: storedHeaderName(n),
    value: truncated ? full.slice(0, MAX_HEADER_VALUE) : full,
  };
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

/**
 * The name of a response header: one with an ID-like run or an address marker (also percent-encoded or in fullwidth
 * characters) is `[redacted]`, a server can put a visitor's ID or address into a name.
 */
export const storedHeaderName = (name: string): string =>
  hasIdLikeRun(name) ||
  LITERAL_ADDRESS_MARKER.test(foldedName(name)) ||
  hasAddressMarker(name) ||
  hasAddressMarker(name.normalize('NFKC')) ||
  nameHoldsAddress(name)
    ? REDACTED
    : name;

/** No `=`, `;`, `,`, whitespace or control character: what RFC 6265 leaves out of a cookie name. */
const COOKIE_NAME = new RegExp(`^[^=;,\\s\\p{Cc}]{1,${KEY_READ_LIMIT}}$`, 'u');

/** Is this a cookie name by RFC 6265, whatever it holds? What is stored of it is `storedCookieName`. */
export function isCookieName(value: unknown): value is string {
  return typeof value === 'string' && COOKIE_NAME.test(value);
}

/**
 * The name of the cookie a `Set-Cookie` line sets as sent, null for a nameless one: the one rule of the HTTP collector
 * and the browser, which match cookies by it in memory. A pair without `=` has an empty name and its whole text as the
 * value (RFC 6265bis §5.6), so that text is never taken for a name. What is stored is `storedCookieName`.
 */
export function setCookieName(line: string): string | null {
  const semicolon = line.indexOf(';');
  const pair = semicolon < 0 ? line : line.slice(0, semicolon);
  const eq = pair.indexOf('=');
  const name = eq < 0 ? '' : pair.slice(0, eq).trim();
  return name === '' ? null : name;
}

/** A literal address marker in the NFKC form of a name without its format characters. */
const LITERAL_ADDRESS_MARKER = /@|[([]at[)\]]/i;

/**
 * The cookie name as every record stores it: a name that is no cookie name or holds an address marker (a literal `@`,
 * `(at)`, `[at]`, or an address written any other way) is `[redacted]` (the cookie is still counted), any other goes
 * through the one rule of storage keys, which masks the ids of a per-visitor shape and keeps the rest.
 */
export function storedCookieName(name: string, readLimit: number = KEY_READ_LIMIT): string {
  if (name.length > readLimit || !/^[^=;,\s\p{Cc}]+$/u.test(name) || nameHoldsAddress(name, readLimit))
    return REDACTED;
  return LITERAL_ADDRESS_MARKER.test(foldedName(name)) ? REDACTED : storedKey(name, readLimit);
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
