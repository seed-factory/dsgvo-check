/** Detection and masking of e-mail addresses (`[redacted]@domain`), and the lenient percent-decoding that finds encoded ones. */

export const REDACTED = '[redacted]';

const EMAIL_LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?';
/** The last label: letters (a top-level domain) or punycode; version numbers (`pkg@3.7.1`) are no domains. */
const EMAIL_TLD = '(?:\\p{L}{2,63}|xn--[a-z0-9-]{2,59})';
const EMAIL_DOMAIN = `(?!\\d+x\\.)(?:${EMAIL_LABEL}\\.){1,10}${EMAIL_TLD}`;
/**
 * Characters that can NOT be part of an unquoted local part: controls, blanks, the RFC 5322 specials and non-ASCII
 * quotes and brackets. A negated class, so a rare character cannot cut the mask short (RFC 6531 allows non-ASCII).
 */
const LOCAL_BORDER = String.raw`\x00-\x20\x7f"(),:;<>@\[\\\]\s\p{Z}\p{Cc}\p{Pi}\p{Pf}\p{Ps}\p{Pe}`;
/** Characters that also structure a URL: in free text they belong to the local part (`R&D@…`), in a URL they are borders. */
const LOCAL_URL_STRUCTURE = '/?#&=';
/** One character of the local part; `{` and `}` are `atext` but in categories Ps/Pe, so they get their own branch. */
const localChar = (extraBorder: string) => `(?:[^${LOCAL_BORDER}${extraBorder}]|[{}])`;
/** A quoted local part (`"alice smith"@…`), at most 64 characters inside like the unquoted form. */
export const QUOTED_LOCAL = String.raw`"(?:[^"\\\r\n]|\\.){1,64}"`;
/** `local@domain` and `local@domain@domain…` as ONE address (the last domain is kept), or a second pass would mask differently. */
const emailSource = (extraBorder: string) =>
  `(?:${QUOTED_LOCAL}|${localChar(extraBorder)}{1,64})@${EMAIL_DOMAIN}(?:@${EMAIL_DOMAIN})*`;

/** A bare address in free text; the local part is capped at 64 characters (RFC 5321) to keep the scan linear. An already masked `[redacted]@domain` does not match. */
const EMAIL_RE = new RegExp(emailSource(''), 'giu');
/** The same inside a URL: the structure characters are not part of the address. */
const EMAIL_IN_URL_RE = new RegExp(emailSource(LOCAL_URL_STRUCTURE), 'giu');

/**
 * `local@` right before masks `[redacted]@domain`: two addresses at different encoding depths in one segment leave the
 * local part of the first (`alice@`) next to the mask of the second, and it is masked too.
 */
const orphanLocal = (extraBorder: string) =>
  new RegExp(
    `(?:${QUOTED_LOCAL}|${localChar(extraBorder)}{1,64})@(?=(?:\\[redacted\\]@)+[\\p{L}\\p{N}])`,
    'giu',
  );
const ORPHAN_LOCAL_RE = orphanLocal('');
const ORPHAN_LOCAL_IN_URL_RE = orphanLocal(LOCAL_URL_STRUCTURE);

const maskedAddress = (m: string) => `${REDACTED}@${m.slice(m.lastIndexOf('@') + 1).toLowerCase()}`;

/**
 * `info(at)example.de` and `info [at] example.de`: an address written so that harvesters miss it is an address all the
 * same. Only the bracketed forms count; a plain " at " is English prose ("meet at noon").
 */
const BLANK = String.raw`[\s\p{Z}]`;
const OBFUSCATED_AT = `${BLANK}{0,3}(?:\\(${BLANK}{0,2}at${BLANK}{0,2}\\)|\\[${BLANK}{0,2}at${BLANK}{0,2}\\])${BLANK}{0,3}`;
/** No mailbox domain starts with `www.`: "1010 Wien (AT) www.example.at" names a country and a website. */
const OBFUSCATED_DOMAIN = `(?!www\\.)${EMAIL_DOMAIN}`;
const obfuscatedSource = (extraBorder: string) =>
  `(?:${QUOTED_LOCAL}|${localChar(extraBorder)}{1,64})${OBFUSCATED_AT}(${OBFUSCATED_DOMAIN})`;
/** An address in the `(at)` or `[at]` form, without a capture group, for a pattern of its own (a `mailto:` value). */
export const OBFUSCATED_ADDRESS = `(?:${QUOTED_LOCAL}|${localChar('')}{1,64})${OBFUSCATED_AT}${OBFUSCATED_DOMAIN}`;
const OBFUSCATED_RE = new RegExp(obfuscatedSource(''), 'giu');
const OBFUSCATED_IN_URL_RE = new RegExp(obfuscatedSource(LOCAL_URL_STRUCTURE), 'giu');
const MAY_BE_OBFUSCATED = /[([][\s\p{Z}]{0,2}at[\s\p{Z}]{0,2}[)\]]/iu;

function maskObfuscated(text: string, re: RegExp): string {
  if (!MAY_BE_OBFUSCATED.test(text)) return text;
  return text.replace(re, (_m, domain: string) => `${REDACTED}@${domain.toLowerCase()}`);
}

/** Only the addresses in the `(at)` and `[at]` forms → `[redacted]@domain`. */
export function maskObfuscatedEmails(text: string): string {
  return maskObfuscated(text, OBFUSCATED_RE);
}

/** Cheap pre-check before the masks: an `@` or an `(at)` / `[at]` marker. */
export function mayHoldAddress(text: string): boolean {
  return text.includes('@') || MAY_BE_OBFUSCATED.test(text);
}

/** Every bare address in `text`, also in the `(at)` and `[at]` forms → `[redacted]@domain` (domain kept, lower-cased). */
export function maskEmails(text: string): string {
  const masked = text.includes('@') ? text.replace(EMAIL_RE, maskedAddress) : text;
  return maskObfuscated(masked, OBFUSCATED_RE);
}

/** `maskEmails` for a URL: `/`, `?`, `#`, `&` and `=` end the local part. */
export function maskEmailsInUrl(text: string): string {
  const masked = text.includes('@') ? text.replace(EMAIL_IN_URL_RE, maskedAddress) : text;
  return maskObfuscated(masked, OBFUSCATED_IN_URL_RE);
}

/** `maskEmails` (or `maskEmailsInUrl` with `inUrl`) plus orphaned local parts before masks, for one decoded path piece. */
export function maskAddressPiece(piece: string, inUrl: boolean): string {
  const masked = inUrl ? maskEmailsInUrl(piece) : maskEmails(piece);
  return masked.replace(inUrl ? ORPHAN_LOCAL_IN_URL_RE : ORPHAN_LOCAL_RE, `${REDACTED}@`);
}

/** `decodeURIComponent` that keeps malformed escapes as they are. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const ESCAPE_RUN = /(?:%[0-9a-f]{2})+/gi;

/** Length of the UTF-8 sequence that starts with this byte; 0 for a continuation byte or one UTF-8 never uses. */
function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

/** Whether `next` may follow `lead` as the byte at position `part`: a continuation byte, and no overlong form, surrogate or code point above U+10FFFF. */
function isContinuationOf(lead: number, next: number, part: number): boolean {
  if (next < 0x80 || next > 0xbf) return false;
  if (part !== 1) return true;
  return !(
    (lead === 0xe0 && next < 0xa0) ||
    (lead === 0xed && next > 0x9f) ||
    (lead === 0xf0 && next < 0x90) ||
    (lead === 0xf4 && next > 0x8f)
  );
}

/** The byte of the `%XX` escape that starts at `at`. */
const escapeByteAt = (run: string, at: number) => Number.parseInt(run.slice(at + 1, at + 3), 16);

/** The character of the UTF-8 sequence written as escapes from `at`; null when it is incomplete or invalid. */
function decodeSequenceAt(run: string, at: number): { char: string; escapes: number } | null {
  const byte = escapeByteAt(run, at);
  const need = utf8SequenceLength(byte);
  if (need === 0 || at + need * 3 > run.length) return null;

  let point = byte & (0x7f >> need);
  for (let part = 1; part < need; part++) {
    const next = escapeByteAt(run, at + part * 3);
    if (!isContinuationOf(byte, next, part)) return null;
    point = (point << 6) | (next & 0x3f);
  }
  return { char: String.fromCodePoint(need === 1 ? byte : point), escapes: need };
}

/** Decodes a run of `%XX` escapes; an escape that is no valid UTF-8 stays as written, the others are decoded. */
function decodeEscapeRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    // at least one escape is invalid: go through the bytes
  }

  // validate the UTF-8 bytes directly: malformed input must not throw once per escape
  let out = '';
  let i = 0;
  while (i < run.length) {
    const decoded = decodeSequenceAt(run, i);
    if (decoded) {
      out += decoded.char;
      i += decoded.escapes * 3;
    } else {
      out += run.slice(i, i + 3);
      i += 3;
    }
  }
  return out;
}

/** `decodeURIComponent` that does not give up: a stray `%`, `%ZZ` or invalid-UTF-8 escape stays as written, so it cannot hide an address next to `%40`. Linear. */
export function decodeLenient(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(ESCAPE_RUN, decodeEscapeRun);
}

/** Is there an address in `text`, written out or percent-encoded (up to three rounds: `%2540` → `%40` → `@`)? */
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
