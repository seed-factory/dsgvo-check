/**
 * Value-like tokens in free text that a page prints about its visitor: a consent dialog shows the visitor's consent ID,
 * UID or the time of the answer next to the names of the services it lists. Each is replaced by `[redacted]` before the
 * text is stored. Pure and idempotent; words, service names and short numbers stay, so that the names can be searched.
 */
import { REDACTED } from '../url/email.ts';

/** Invisible characters that would split one value into tokens too short to look like one. */
const INVISIBLE_RE = /[­​-‍⁠﻿]/g;

/**
 * A label that names an identifier (`UID:`, `Consent-ID:`, `Ihre Einwilligungs-ID:`): the token after it is a value
 * whatever its shape, also a word such as `anonymous`. The label must not end a longer word (`Valid:`).
 */
const ID_LABEL_RE = /(^|[^\p{L}\p{N}])((?:uu?id|id)\s*[:=]\s*)(\S+)/giu;

/** A run of the characters identifiers and their base64 or UUID forms are written with. */
const RUN_RE = /[A-Za-z0-9_+/=-]+/g;

/** Letters and digits of a run from this many on: random identifiers are at least this long. */
const MIN_MIXED_CHARS = 8;
/** A run of letters only is an identifier when it is this long and switches case inside words this often. */
const MIN_CASE_RUN_CHARS = 16;
const MIN_CASE_SWITCHES = 3;
/** Twelve digits in a row are an identifier or a time stamp rather than a date, a size or a duration. */
const LONG_NUMBER_RE = /\d{12}/;

function valueLike(run: string): boolean {
  const alnum = run.replace(/[^A-Za-z0-9]/g, '');
  if (alnum.length >= MIN_MIXED_CHARS && /\d/.test(alnum) && /[A-Za-z]/.test(alnum)) return true;
  if (LONG_NUMBER_RE.test(run)) return true;
  // Base64 without a digit: a lower-case letter followed by a capital again and again, unlike a product name.
  return (
    alnum.length >= MIN_CASE_RUN_CHARS && (run.match(/[a-z](?=[A-Z])/g)?.length ?? 0) >= MIN_CASE_SWITCHES
  );
}

/** Replaces consent IDs, UIDs, tokens and long numbers in `text` by `[redacted]`. */
export function redactValueTokens(text: string): string {
  const labelled = text
    .replace(INVISIBLE_RE, '')
    .replace(ID_LABEL_RE, (_m, before: string, label: string) => `${before}${label}${REDACTED}`);
  return labelled.replace(RUN_RE, (run) => (valueLike(run) ? REDACTED : run));
}
