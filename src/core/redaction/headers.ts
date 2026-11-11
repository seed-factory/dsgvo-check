/**
 * Response headers as stored in snapshots and evidence, one normalizer for the HTTP collector and the browser. A kept
 * header is stored by its grammar: what its syntax allows is kept (keywords of closed sets, names and tokens that are
 * no identifiers, URLs resolved and sanitized), every other part is `[redacted]`, so text a server puts into a header
 * cannot reach a snapshot as free text. Headers without a grammar here keep no value; of `Set-Cookie` only the cookie
 * name is stored. Product headers keep their value redacted too and carry only the product/version pairs read from it.
 */

import type { HeaderRecord } from '../snapshot/common.ts';
import { hasAddressMarker, REDACTED } from '../url/email.ts';
import { sanitizeUrl } from '../url/url.ts';
import { contentSecurityPolicy, cspFrameAncestors } from './header-csp.ts';
import {
  type Grammar,
  linkTarget,
  literalMask,
  MAX_HEADER_VALUE,
  mediaType,
  originOf,
  REFERRER_POLICIES,
  referenceSanitized,
  siteName,
  type UrlSanitizer,
  words,
} from './header-grammar.ts';
import { PRODUCT_HEADERS, productVersionsOf } from './header-product-versions.ts';
import { foldedName, hasIdLikeRun, KEY_READ_LIMIT, nameHoldsAddress, storedKey } from './page-names.ts';

export { cspFrameAncestors } from './header-csp.ts';
export { MAX_HEADER_VALUE, type UrlSanitizer } from './header-grammar.ts';
export { PRODUCT_HEADERS, productVersionsOf } from './header-product-versions.ts';

const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const paramName = (s: string): boolean => PARAM_NAME.test(s) && !hasIdLikeRun(s);

/** Language, script, region, variant and singleton-extension subtags (RFC 5646: `en-US-u-ca-gregory`, `de-DE-x-private`), and `x-default`. */
const LANGUAGE_TAG =
  /^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}(?:-[A-Za-z0-9](?:-[A-Za-z0-9]{2,8}){1,5}){0,3}|x-default)$/i;
const languageTag = (s: string): boolean => s.length <= 35 && LANGUAGE_TAG.test(s) && !hasIdLikeRun(s);

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
