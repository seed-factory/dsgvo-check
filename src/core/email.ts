/**
 * E-mail addresses in free text and URLs: detection, masking to `[redacted]@domain` (AGENTS rule 2), and the lenient
 * percent-decoding that finds encoded addresses. `REDACTED` is the marker of every redaction.
 */

export const REDACTED = '[redacted]';

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
 * rare one cannot cut the mask short. Written for the `u` flag.
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
 * `alice@`, next to the mask of the second. It is masked as well.
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

/**
 * `maskEmails` (or `maskEmailsInUrl` with `inUrl`) plus the orphaned local parts in front of masks: one decoded piece
 * of a path segment, whose addresses may sit at different depths of encoding.
 */
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

/** Decode a run of `%XX` escapes; an escape that is no valid UTF-8 stays as written, the others around it are decoded. */
function decodeEscapeRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    // at least one escape is invalid: go through the bytes
  }
  // Validate UTF-8 bytes directly: malformed input must not throw once per escape.
  const byteAt = (at: number) => Number.parseInt(run.slice(at + 1, at + 3), 16);
  let out = '';
  let i = 0;
  while (i < run.length) {
    const byte = byteAt(i);
    // length of the UTF-8 sequence that starts with this byte; 0: a continuation byte or a byte UTF-8 never uses
    let need = 0;
    if (byte < 0x80) need = 1;
    else if (byte >= 0xc2 && byte <= 0xdf) need = 2;
    else if (byte >= 0xe0 && byte <= 0xef) need = 3;
    else if (byte >= 0xf0 && byte <= 0xf4) need = 4;
    if (need > 0 && i + need * 3 <= run.length) {
      let point = byte & (0x7f >> need);
      let valid = true;
      for (let part = 1; part < need; part++) {
        const next = byteAt(i + part * 3);
        if (
          next < 0x80 ||
          next > 0xbf ||
          (part === 1 &&
            ((byte === 0xe0 && next < 0xa0) ||
              (byte === 0xed && next > 0x9f) ||
              (byte === 0xf0 && next < 0x90) ||
              (byte === 0xf4 && next > 0x8f)))
        ) {
          valid = false;
          break;
        }
        point = (point << 6) | (next & 0x3f);
      }
      if (valid) {
        out += String.fromCodePoint(need === 1 ? byte : point);
        i += need * 3;
        continue;
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
 * not hide the address. Linear. Equal to `decodeURIComponent` when every escape is valid.
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
