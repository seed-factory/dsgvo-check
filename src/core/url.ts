/** Target validation, URL sanitizing (D20) and registrable-domain helpers. */
import { getDomain } from 'tldts';
import { InvalidInputError } from './errors.ts';
import type { TargetInfo } from './snapshot.ts';

/**
 * Query parameters whose values are kept. Everything else becomes `[redacted]` (D20).
 * Only site-level identifiers/settings, never visitor identifiers. Generic names (`id`, `tid`, `v`, `t`) keep their
 * value only in the expected form, see `QUERY_VALUE_RULES`.
 */
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

export const REDACTED = '[redacted]';

/** `sanitizeUrl` and `redactTarget` cut their result at this length: what lies behind it is never seen. */
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

/**
 * Value rules for allowlisted generic parameter names (FP-06): the value is kept only when it has the form of a
 * site-level setting; anything else (customer numbers, timestamps, cache busters, tokens) is redacted.
 */
export const QUERY_VALUE_RULES: Readonly<Record<string, (value: string, url: URL) => boolean>> = {
  id: (value, url) => TAG_ID.test(value) || (isMetaPixel(url) && /^\d{1,20}$/.test(value)),
  tid: (value) => TAG_ID.test(value),
  v: (value) => VERSION.test(value),
  t: (value) => UA_HIT_TYPES.has(value.toLowerCase()),
};

function keepValue(name: string, value: string, url: URL, allowlist: ReadonlySet<string>): boolean {
  const key = name.toLowerCase();
  if (!allowlist.has(key)) return false;
  // An allowlisted name keeps a value of the expected form, never a visitor's address that ended up inside it (a quote
  // or a comma glued an address to the URL: `?hl=de','alice@example.test`; R-privacy-1).
  if (containsAddress(value)) return false;
  const rule = QUERY_VALUE_RULES[key];
  return rule ? rule(value, url) : true;
}

const EMAIL_LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?';
/** The last label: letters (a top-level domain) or punycode; version numbers (`pkg@3.7.1`) are not domains. */
const EMAIL_TLD = '(?:\\p{L}{2,63}|xn--[a-z0-9-]{2,59})';
const EMAIL_DOMAIN = `(?!\\d+x\\.)(?:${EMAIL_LABEL}\\.){1,10}${EMAIL_TLD}`;
/**
 * What can NOT be part of an unquoted local part: control characters, blanks of every script, the specials of
 * RFC 5322 (`"` `(` `)` `,` `:` `;` `<` `>` `@` `[` `\` `]`) and the non-ASCII quotes and brackets (categories Pi, Pf, Ps,
 * Pe: `„alice@…“`, `«alice@…»`, `（alice@…）` keep their marks). Everything else belongs to the local part: the whole
 * `atext` of RFC 5322, letters, digits and marks of any script and, as RFC 6531 allows, every other non-ASCII character
 * (emoji, `™`, `€`, `·`, `–`). A negated class: a character that is not listed is a part of the address, so that a
 * rare one cannot cut the mask short (R-privacy-4). Written for the `u` flag.
 */
const LOCAL_BORDER = String.raw`\x00-\x20\x7f"(),:;<>@\[\\\]\s\p{Z}\p{Cc}\p{Pi}\p{Pf}\p{Ps}\p{Pe}`;
/**
 * The characters that are also the structure of a URL (`/`, `?`, `#`, `&`, `=`). In free text they belong to the local
 * part (`R&D@…`, `a/b@…`); in a string that is already a URL they are borders (path, query), and an address must not
 * swallow them: `…/p?x=1` must not lose its `?`.
 */
const LOCAL_URL_STRUCTURE = '/?#&=';
/**
 * One character of the local part. `{` and `}` are `atext`, but they are in the categories Ps and Pe: they get their own
 * branch. The two branches share no character, so the alternation cannot backtrack in several ways.
 */
const localChar = (extraBorder: string) => `(?:[^${LOCAL_BORDER}${extraBorder}]|[{}])`;
/**
 * A quoted local part (`"alice smith"@…`): any characters but `"` and `\`, a backslash escapes the next one. At most 64
 * characters inside, like the unquoted form.
 */
export const QUOTED_LOCAL = String.raw`"(?:[^"\\\r\n]|\\.){1,64}"`;
/**
 * `local@domain`, and `local@domain@domain…` as one address: the mask keeps the last domain. Matched separately, the
 * second `domain@domain` would be taken for an address on the second pass (`a@b.test@c.test` → idempotency).
 */
const emailSource = (extraBorder: string) =>
  `(?:${QUOTED_LOCAL}|${localChar(extraBorder)}{1,64})@${EMAIL_DOMAIN}(?:@${EMAIL_DOMAIN})*`;

/**
 * A bare e-mail address in free text. The local part is capped at 64 characters (RFC 5321) so that the scan stays
 * linear on long text: every start position looks at 64 characters at most, and the quoted form is bounded the same
 * way. An already masked `[redacted]@domain` is not matched: `]` is not a local-part character. Not an address:
 * `package@3.7.1` (CDN paths), `logo@2x.png` (image names).
 */
const EMAIL_RE = new RegExp(emailSource(''), 'giu');
/** The same inside a string that is a URL (or a part of one): the structure characters are not part of the address. */
const EMAIL_IN_URL_RE = new RegExp(emailSource(LOCAL_URL_STRUCTURE), 'giu');

/**
 * `local@` right in front of masks `[redacted]@domain` (a mask is followed by the domain: `a@[redacted]@` alone is no
 * address, and no mask). Two addresses of different depth of encoding in one segment
 * (`alice%40a%25252Einvalid-bob%2540b.invalid`): at the earliest round the dot of the first is still escaped, its domain
 * is not one, and the second address takes it for its local part. What stays is the local part of the first address,
 * `alice@`, next to the mask of the second (review of P4). It is masked as well.
 */
const orphanLocal = (extraBorder: string) =>
  new RegExp(
    `(?:${QUOTED_LOCAL}|${localChar(extraBorder)}{1,64})@(?=(?:\\[redacted\\]@)+[\\p{L}\\p{N}])`,
    'giu',
  );
const ORPHAN_LOCAL_RE = orphanLocal('');
const ORPHAN_LOCAL_IN_URL_RE = orphanLocal(LOCAL_URL_STRUCTURE);

const maskedAddress = (m: string) => `${REDACTED}@${m.slice(m.lastIndexOf('@') + 1).toLowerCase()}`;

/** Every bare address `local@domain` in `text` → `[redacted]@domain` (the domain is kept, lower-cased). */
export function maskEmails(text: string): string {
  if (!text.includes('@')) return text;
  return text.replace(EMAIL_RE, maskedAddress);
}

/** `maskEmails` for a string that is a URL: `/`, `?`, `#`, `&` and `=` end the local part (they structure the URL). */
export function maskEmailsInUrl(text: string): string {
  if (!text.includes('@')) return text;
  return text.replace(EMAIL_IN_URL_RE, maskedAddress);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const ESCAPE_RUN = /(?:%[0-9a-f]{2})+/gi;

/** Decode a run of `%XX` escapes; an escape that is no valid UTF-8 stays as written, the others around it are decoded. */
function decodeEscapeRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    // at least one escape is invalid: go through the bytes
  }
  let out = '';
  let i = 0;
  while (i < run.length) {
    const byte = Number.parseInt(run.slice(i + 1, i + 3), 16);
    // length of the UTF-8 sequence that starts with this byte; 0: a continuation byte or a byte UTF-8 never uses
    let need = 0;
    if (byte < 0x80) need = 1;
    else if (byte >= 0xc2 && byte <= 0xdf) need = 2;
    else if (byte >= 0xe0 && byte <= 0xef) need = 3;
    else if (byte >= 0xf0 && byte <= 0xf4) need = 4;
    if (need > 0 && i + need * 3 <= run.length) {
      try {
        out += decodeURIComponent(run.slice(i, i + need * 3));
        i += need * 3;
        continue;
      } catch {
        // not a valid sequence: keep the byte as written
      }
    }
    out += run.slice(i, i + 3);
    i += 3;
  }
  return out;
}

/**
 * `decodeURIComponent` that does not give up: valid escapes are decoded, a stray `%`, `%ZZ` or an escape that is no
 * valid UTF-8 (`%E9`) stays as written. Used to *find* addresses and parameters; one invalid escape next to `%40` must
 * not hide the address (S-privacy-5). Linear. Equal to `decodeURIComponent` when every escape is valid.
 */
export function decodeLenient(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(ESCAPE_RUN, decodeEscapeRun);
}

/**
 * Is there an e-mail address in `text`, written out or percent-encoded (up to three rounds: `%2540` is `%40` is `@`)?
 * Used on parts of a URL that are kept (a query value, a key): they must not carry an address. Each round is linear.
 */
export function containsAddress(text: string): boolean {
  let current = text;
  for (let round = 0; round < 3; round++) {
    if (maskEmails(current) !== current) return true;
    const next = decodeLenient(current);
    if (next === current) return false;
    current = next;
  }
  return maskEmails(current) !== current;
}

/**
 * `mailto:local@domain` → `mailto:[redacted]@domain` for every recipient; headers (subject, cc, body) are dropped
 * (5.3). Accepts the value with or without the `mailto:` scheme and recipients that carry their own `mailto:` (DMARC
 * `rua` lists); the prefix is kept per recipient. Only the domain survives, whatever follows it is dropped.
 */
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
      // a domain that is only dots and hyphens is no domain: `[redacted]@` would become `[redacted]` on a second pass
      const domain = rawDomain?.replace(/[.-]+$/, '');
      const masked = domain ? `${REDACTED}@${domain.toLowerCase()}` : REDACTED;
      return prefixed ? `mailto:${masked}` : masked;
    });
  // a first recipient that carries its own prefix (`mailto:,mailto:x@y`) must not double the one in front
  return `mailto:${recipients.length > 0 ? recipients.join(',') : REDACTED}`
    .replace(/^mailto:(?:mailto:)+/, 'mailto:')
    .slice(0, MAX_URL_LENGTH);
}

/**
 * Values of parameters in the path. Matrix parameters (`/activity;dc_pre=…;ord=…`) and `prefix:k=v&k=v` segments
 * carry visitor identifiers of ad and sync tags like a query does (D20); the rule is syntactic, not a length or
 * entropy guess. Names of the query allowlist keep a value of the expected form, every other value is redacted.
 * Segments without `=` stay as they are.
 */
function redactPathParam(part: string, url: URL, allowlist: ReadonlySet<string>): string {
  const eq = part.indexOf('=');
  if (eq < 0) return part;
  const name = part.slice(0, eq);
  return keepValue(safeDecode(name), safeDecode(part.slice(eq + 1)), url, allowlist)
    ? part
    : `${name}=${REDACTED}`;
}

/** First part of a segment: `k=v`, `k=v&k=v` or `prefix:k=v&k=v` (the last two: every value is redacted). */
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

/**
 * Percent-escapes of the characters that the parameter rule is built on (`;` `=` `&` `:`) count as the characters
 * themselves: `max@example.test%3Bord%3D12345` is a matrix parameter like `max@example.test;ord=12345` (review R11).
 */
const ENCODED_PARAM_SYNTAX = /%(3B|3D|26|3A)/gi;
const PARAM_SYNTAX: Readonly<Record<string, string>> = { '3B': ';', '3D': '=', '26': '&', '3A': ':' };

/**
 * Mask the addresses of a decoded path segment. A `/` or `\` in it comes from `%2F` or `%5C` and is written back
 * escaped: it stays the border of what is masked, so the structure of the path does not change. `=` and `&` are the
 * syntax of path parameters (`k=v&k=v`) when the segment has a parameter: the address must not swallow them, or the
 * second pass would read the segment differently from the first (idempotency). Without a parameter they are ordinary
 * characters of a local part (`R&D@…`).
 */
function maskEmailsInSegment(decoded: string): string {
  const withParams = decoded.includes('=');
  const mask = withParams ? maskEmailsInUrl : maskEmails;
  const orphan = withParams ? ORPHAN_LOCAL_IN_URL_RE : ORPHAN_LOCAL_RE;
  return decoded
    .split(/([/\\])/)
    .map((piece, i) => (i % 2 === 1 ? piece : mask(piece).replace(orphan, `${REDACTED}@`)))
    .join('');
}

/** Rounds of decoding in which an address is looked for in a part of a URL: as `containsAddress` and `hasAddress`. */
const DECODE_ROUNDS = 3;
/** How often a segment is masked again when a mask lays an address bare that sat at a deeper level of encoding. */
const MASK_PASSES = 4;

/**
 * A decoded segment written back. The characters that would change the structure of the path stay escaped (`%2F` must
 * not become a segment border). The URL setter escapes `?`, `#` and spaces of a path itself.
 */
const escapeDecoded = (text: string) =>
  text.replaceAll('%', '%25').replaceAll('/', '%2F').replaceAll('\\', '%5C');
/** The same for an opaque path, which no URL setter rewrites: a `?`, a `#`, a blank or a control would change it. */
const escapeDecodedOpaque = (text: string) =>
  escapeDecoded(text).replace(/[\p{Cc} ?#]/gu, encodeURIComponent);

/**
 * Mask the addresses that are visible in `segment` after one to three rounds of lenient decoding (the first round: the
 * segment as written, with its valid escapes decoded; one invalid escape (`%ZZ`, `%E9`) must not keep `%40` from being
 * decoded, S-privacy-5; an address encoded twice, `%2540`, is visible in the second round, P4). The earliest round
 * that shows one decides: that decoded form is masked and written back, so that `m%C3%BCller%40…` and the rest of the
 * segment behave as they always did. Without an address the segment stays as it is.
 */
function maskSegmentOnce(segment: string, writeBack: (decoded: string) => string): string {
  let decoded = segment;
  for (let round = 1; round <= DECODE_ROUNDS; round++) {
    const next = decodeLenient(decoded);
    // a round that decodes nothing shows nothing new (the first one still looks at a segment without escapes)
    if (round > 1 && next === decoded) break;
    decoded = next;
    if (decoded.includes('@')) {
      const masked = maskEmailsInSegment(decoded);
      if (masked !== decoded) return writeBack(masked);
    }
  }
  return segment;
}

/**
 * `maskSegmentOnce` until nothing is left to mask: the written-back form may show an address of a deeper level that
 * the first mask did not look at (`a@b.test%2540c.test`), and a second pass over the result must not find it. The
 * passes are bounded; what still has an address after them is not a segment worth keeping.
 */
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
  // Only a segment with a parameter is rewritten; an encoded `;` or `:` alone leaves the segment as it is.
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

/**
 * `redactPathSegmentOnce` until nothing changes. The masked form is written back decoded, and a deeper level of
 * encoding can show up in it as syntax: `…%2540example.invalid%253Bord%253D1` becomes `…@example.invalid;ord=1`, a
 * path parameter that only the next pass reads. The result is the fixed point, so that `sanitizeUrl` of its own output
 * returns it (review of P4); a segment that does not settle within the passes is replaced.
 */
function redactPathSegment(segment: string, url: URL, allowlist: ReadonlySet<string>): string {
  let current = segment;
  for (let pass = 0; ; pass++) {
    const next = redactPathSegmentOnce(current, url, allowlist);
    if (next === current) return current;
    if (pass === MASK_PASSES) return REDACTED;
    current = next;
  }
}

/**
 * Redact identifiers and e-mail addresses in the path of a URL whose path is a list of segments (`http(s):`, `ws:`,
 * `ftp:`, `foo://host/…`). The opaque path of `foo:…` or `sms:…` is no list: see `redactOpaquePath`.
 */
function redactPath(u: URL, allowlist: ReadonlySet<string>): void {
  const path = u.pathname;
  // `%` for the encoded `@` (also encoded twice or three times) and `=`
  if (!path.startsWith('/') || !/[=@%]/.test(path)) return;
  const next = path
    .split('/')
    .map((segment) => redactPathSegment(segment, u, allowlist))
    .join('/');
  if (next !== path) u.pathname = next;
}

/**
 * The URL as a string, with the addresses of an opaque path masked (P3). The path of `foo:alice@mail.invalid`,
 * `javascript:alert(1)alice@…`, `sms:…`, `view-source:https://…/alice@…` is not a list of segments and no setter
 * rewrites it, so the masked pieces (cut at `/` like a path) are put into the string and the URL is parsed again: the
 * result is what the URL parser makes of it, and a second pass finds nothing to change. Without an address the string
 * is the one of the URL. Phone numbers (`tel:`) and the like are no addresses.
 */
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

/** A URL reduced to its scheme. `file:[redacted]` would parse on the next pass (as `file:///[redacted]`): it is written so. */
const schemeOnly = (scheme: string) =>
  scheme.toLowerCase() === 'file:' ? `file:///${REDACTED}` : `${scheme}${REDACTED}`;

/**
 * The string as the URL parser reads it: leading and trailing C0 controls and blanks are removed, and so are tabs and
 * line breaks anywhere. A string that is cut the same way here parses as the same URL on the next pass: `\thttp://[a%40b.test/`
 * must not keep its tab, or its scheme is not seen now and is the next time (review of P3).
 */
function withoutParserNoise(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 0x20) start++;
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--;
  const trimmed = start === 0 && end === raw.length ? raw : raw.slice(start, end);
  return /[\t\n\r]/.test(trimmed) ? trimmed.replace(/[\t\n\r]/g, '') : trimmed;
}

/**
 * Best-effort redaction of a string that is not a parsable URL: userinfo, query and fragment are removed, addresses are
 * masked, also those that are only visible after decoding.
 */
function redactUnparsable(input: string): string {
  const raw = withoutParserNoise(input);
  // A blank in front of the fragment is the end of the string once the fragment is gone (`https://x.test #f`), and the
  // URL parser drops it: what is left may parse, and then the next pass reads it as a URL, so this one does.
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
  // What the decoded pieces write back may stand next to an escape (`%2F@…`) that the mask of bare addresses takes for
  // a local part: both run until the result no longer changes, so that a second pass finds nothing.
  let current = masked;
  for (let pass = 0; pass < MASK_PASSES; pass++) {
    const next = maskEmailsInUrl(maskEncodedAddresses(current));
    if (next === current) break;
    current = next;
  }
  // a blank in front of the removed fragment or query ends up at the end: the next pass would read it differently
  return withoutParserNoise(current).slice(0, MAX_URL_LENGTH);
}

/**
 * Characters that must not stand raw in a stored string: controls (a decoded `%0A` or `%1B`), the line and paragraph
 * separators and the bidirectional controls that reorder the text around them.
 */
const RAW_UNSAFE = /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A decoded piece of an unparsable URL written back: nothing may turn into a query or a fragment on the next pass, and
 * no control or separator comes out raw (review of P3: a relative `Location` of `/alice%40x.test%0A…` would put a line
 * break into the snapshot).
 */
const escapeDecodedUnparsable = (text: string) =>
  escapeDecoded(text).replaceAll('?', '%3F').replaceAll('#', '%23').replace(RAW_UNSAFE, encodeURIComponent);

/**
 * The addresses that are only visible after decoding (`https://exa mple.test/alice%40mail.invalid`) in a string that is
 * not a parsable URL (P4): the pieces of the path as for a parsable one. An encoded address in the host part has no
 * place to go (it would turn into userinfo on the next pass): the URL is reduced to its scheme. The host part is the
 * first piece after the scheme, however many slashes come in front of it (`http:///x` is `http://x`).
 */
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

/**
 * A name or a value of `application/x-www-form-urlencoded` as `URLSearchParams` reads it: `+` is a blank, `%XX` is a
 * byte, a stray `%` stays, the bytes are UTF-8 (an invalid sequence becomes U+FFFD, a BOM is kept). Linear.
 */
function formDecode(s: string): string {
  const spaced = s.includes('+') ? s.replaceAll('+', ' ') : s;
  if (!spaced.includes('%')) return spaced;
  try {
    return decodeURIComponent(spaced);
  } catch {
    // an escape that is no valid UTF-8, or a stray `%`: go through the bytes
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

/**
 * Redact the query of `u` in one pass over the string. The iterator of `URLSearchParams` is quadratic in the number of
 * parameters (P2): the browser collector hands every request URL to `sanitizeUrl`, whatever its length. The sequences
 * are cut at `&`, the name from the value at the first `=`, empty sequences are skipped: the algorithm of
 * `application/x-www-form-urlencoded`, so the result is the same as with the iterator. The query is the last part of the
 * URL, and the result is cut at `MAX_URL_LENGTH`: once the pairs written so far fill that many characters (a
 * decoded character never takes fewer in the encoded query), the rest is not looked at.
 */
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

/**
 * Remove credentials and fragment; redact query values not in the allowlist, values of path parameters and e-mail
 * addresses in the path (also those encoded up to three times) and in the opaque part of `foo:…`, `sms:…`,
 * `javascript:…`. Invalid URLs are returned redacted. Linear in the length of the URL.
 */
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
  // The host of a scheme without a special host is opaque: `foo://alice%40mail.invalid/` has the address in it.
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

/**
 * The scan target as it may appear in snapshots, reports, logs and messages (D20): credentials and fragment removed,
 * query values redacted like any other URL. Also for input that is rejected or not parsable.
 */
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

/** Copy of `target` that is safe to store: `input` and `url` redacted. The raw target stays with the collectors. */
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
 * Validate the scan target (5.2 row "URL не http(s), credentials в URL" → invalid-input).
 * A bare hostname gets `https://`. The result holds the raw URL for navigation; store only `redactTargetInfo()` of it.
 * `host` keeps the URL form (IPv6 literals in brackets, like `URL.hostname`); use `bareHost()` for DNS and sockets.
 */
export function parseTarget(input: string): TargetInfo {
  const trimmed = input.trim();
  if (!trimmed) throw new InvalidInputError('target-missing', 'Keine Ziel-URL angegeben.');
  const withScheme = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new InvalidInputError('target-invalid-url', `Ungültige URL: ${redactTarget(trimmed)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidInputError(
      'target-unsupported-scheme',
      `Nur http(s)-URLs werden unterstützt: ${u.protocol}`,
    );
  }
  if (u.username || u.password) {
    throw new InvalidInputError('target-credentials', 'Zugangsdaten in der URL sind nicht erlaubt.');
  }
  if (!u.hostname)
    throw new InvalidInputError('target-invalid-url', `Ungültige URL: ${redactTarget(trimmed)}`);
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
