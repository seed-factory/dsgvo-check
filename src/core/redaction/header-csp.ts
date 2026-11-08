import type { FrameAncestorsFact } from '../snapshot/common.ts';
import {
  containsAddress,
  decodeLenient,
  maskEmails,
  maskObfuscatedEmails,
  QUOTED_LOCAL,
  REDACTED,
} from '../url/email.ts';
import {
  ADDRESS_MASK,
  absoluteSanitized,
  type Grammar,
  literalMask,
  MAX_HEADER_VALUE,
  mediaType,
  policyName,
  REFERRER_POLICIES,
  referenceSanitized,
  siteName,
  type UrlSanitizer,
  words,
} from './header-grammar.ts';
import { hasIdLikeRun } from './page-names.ts';

/** The quoted local part of an address with its `@` (`"alice smith"@`). */
const QUOTED_ADDRESS = new RegExp(`${QUOTED_LOCAL}@`, 'g');

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

export const contentSecurityPolicy: Grammar = (value, base, sanitize) => {
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
