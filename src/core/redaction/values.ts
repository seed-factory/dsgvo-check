/**
 * Value-like tokens in free text that a page prints about its visitor: a consent dialog shows the visitor's consent ID,
 * UID or TC string next to the names of the services it lists. Each is replaced by `[redacted]` before the text is
 * stored, and so is a time stamp in milliseconds; dates and clock times stay. Pure and idempotent; words, service names
 * and short numbers stay, so that the names can be searched.
 */
import { REDACTED } from '../url/email.ts';

/**
 * Soft hyphen, zero-width space and joiners, word joiner and BOM: hyphenation plugins and spam protection put them into
 * a word, and they split an address or an identifier into parts that no masking recognises.
 */
const INVISIBLE_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** `text` without invisible characters; run it before any other redaction of the same text. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

/**
 * A label that names an identifier, and what separates it from the value. `UID:`, `Consent-ID:`, `Ihre
 * Einwilligungs-ID (UID):` with a short alias in brackets, the compounds pages glue to the word (`ConsentID`, `UserID`),
 * and `Consent-ID lautet` take the token after them whatever its shape, also a word such as `anonymous` (groups 1 and
 * 2). A label followed by a space only (group 3, cells of a table collapsed into one line) takes it when it holds a
 * digit. The label must not end a longer word (`Valid:`, `Android:`).
 */
const ID_LABEL_RE =
  /(?<![\p{L}\p{N}])(?:consent|einwilligungs|user|nutzer|visitor|besucher|session|client|device|controller)?(?:uu?)?id(?:\s*\([^()]{1,24}\))?(?:(\s*[:=]\s*)|(\s+(?:lautet|ist|is)(?:\s*:)?\s+)|(\s+))/giu;

/** The characters identifiers and their base64, UUID or TC string forms are written with. */
const VALUE_CHARS_RE = /^[A-Za-z0-9_+/=.-]+$/;

/** A further part of a labelled value that a space split off (`Consent-ID: 1234 5678`): value characters and a digit. */
const valuePart = (token: string): boolean => VALUE_CHARS_RE.test(token) && /\d/.test(token);

/** How many characters from `at` the value after a label takes; 0 when there is none to replace. */
function labelledValueLength(text: string, at: number, needsDigit: boolean): number {
  const token = /\S+/y;
  const tokenAt = (i: number): string => {
    token.lastIndex = i;
    return token.exec(text)?.[0] ?? '';
  };
  const first = tokenAt(at);
  if (!first || (needsDigit && !valuePart(first))) return 0;
  let end = at + first.length;
  for (let part = tokenAt(end + 1); text[end] === ' ' && valuePart(part); part = tokenAt(end + 1))
    end += 1 + part.length;
  return end - at;
}

function redactLabelled(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(ID_LABEL_RE)) {
    const at = m.index + m[0].length;
    // A label inside a value already replaced has nothing left to replace.
    if (m.index < last) continue;
    const length = labelledValueLength(text, at, m[3] !== undefined);
    if (length === 0) continue;
    out += `${text.slice(last, at)}${REDACTED}`;
    last = at + length;
  }
  return out + text.slice(last);
}

/**
 * A run of value characters; dots join its segments, so that a TC string (`CPxyz….YAAAA`) is replaced as a whole and no
 * segment of it is left.
 */
const RUN_RE = /[A-Za-z0-9_+/=-]+(?:\.[A-Za-z0-9_+/=-]+)*/g;

/** Letters and digits of a segment from this many on: random identifiers are at least this long. */
const MIN_MIXED_CHARS = 8;
/** A segment of letters only is an identifier when it is this long and switches case inside words this often. */
const MIN_CASE_RUN_CHARS = 16;
const MIN_CASE_SWITCHES = 3;
/** Twelve digits in a row are an identifier or a time stamp rather than a date, a size or a duration. */
const LONG_NUMBER_RE = /\d{12}/;

function valueLike(segment: string): boolean {
  const alnum = segment.replace(/[^A-Za-z0-9]/g, '');
  if (alnum.length >= MIN_MIXED_CHARS && /\d/.test(alnum) && /[A-Za-z]/.test(alnum)) return true;
  if (LONG_NUMBER_RE.test(segment)) return true;
  // Base64 without a digit: a lower-case letter followed by a capital again and again, unlike a product name.
  return (
    alnum.length >= MIN_CASE_RUN_CHARS && (segment.match(/[a-z](?=[A-Z])/g)?.length ?? 0) >= MIN_CASE_SWITCHES
  );
}

/** Replaces consent IDs, UIDs, TC strings, tokens and long numbers in `text` by `[redacted]`. */
export function redactValueTokens(text: string): string {
  return redactLabelled(stripInvisible(text)).replace(RUN_RE, (run) =>
    run.split('.').some(valueLike) ? REDACTED : run,
  );
}
