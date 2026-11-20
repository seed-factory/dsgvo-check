/**
 * Redaction of free text that a collector copies into the snapshot or a check puts into evidence: link text, names,
 * titles, legal-document parts, DNS TXT. Pure and idempotent. Domains and service names stay; phone numbers are untouched.
 */

import {
  decodeLenient,
  maskEmails,
  maskEmailsInUrl,
  maskObfuscatedEmails,
  OBFUSCATED_ADDRESS,
  QUOTED_LOCAL,
  REDACTED,
} from '../url/email.ts';
import { maskMailto, QUERY_ALLOWLIST, sanitizeUrl } from '../url/url.ts';

export { maskEmails, maskMailto };

/** A quoted address glued to a token belongs to it: the bare-address mask would eat the `"` and change the result on the second pass. */
const quotedTail = (char: string) => `(?:${QUOTED_LOCAL}@${char}+)*`;
const urlChar = String.raw`[^\s<>"]`;
/** A character of a `mailto:` value; not one that starts a URL, which is a token of its own. */
const mailtoChar = String.raw`(?:(?!https?:\/\/)[^\s<>";])`;

/**
 * An http(s) URL or a `mailto:` value (the address may follow whitespace). Tokens end at whitespace, `<`, `>` and `"`;
 * `mailto:` also at `;` (DMARC tags) and in front of a URL. An apostrophe does not end a token: it is legal in URLs. An
 * address in the `(at)` form holds blanks, so it is a value of its own: cut at the first blank, its local part would
 * stay apart from its domain.
 */
const URL_TOKEN = String.raw`https?:\/\/${urlChar}+${quotedTail(urlChar)}`;
const MAILTO_TOKEN = String.raw`mailto:\s*(?:${OBFUSCATED_ADDRESS}${mailtoChar}*|${QUOTED_LOCAL}@${mailtoChar}+|${mailtoChar}+)${quotedTail(mailtoChar)}`;
const TOKEN_RE = new RegExp(`${URL_TOKEN}|${MAILTO_TOKEN}`, 'giu');

const OPENERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const BRACKETS: ReadonlySet<string> = new Set(['(', ')', '[', ']', '{', '}']);
/** Sentence punctuation, closing brackets and quotes at the end of a token. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}»«“”„‘’>'`]/;

/** Splits trailing sentence punctuation off a token; a closing bracket stays when the token has its opener. Linear. */
function splitTrailingPunctuation(token: string): { core: string; tail: string } {
  const count = new Map<string, number>();
  for (const ch of token) {
    if (BRACKETS.has(ch)) count.set(ch, (count.get(ch) ?? 0) + 1);
  }

  let end = token.length;
  while (end > 0) {
    const ch = token.charAt(end - 1);
    if (!TRAILING_PUNCTUATION.test(ch)) break;
    // the `]` of our own `[redacted]` is no punctuation: a stray `]` earlier in the token would make the second pass cut it
    if (ch === ']' && end >= REDACTED.length && token.startsWith(REDACTED, end - REDACTED.length)) break;

    const opener = OPENERS[ch];
    if (opener !== undefined) {
      const closes = count.get(ch) ?? 0;
      if ((count.get(opener) ?? 0) >= closes) break;
      count.set(ch, closes - 1);
    }
    end--;
  }

  return { core: token.slice(0, end), tail: token.slice(end) };
}

/** A `.` or `..` segment (also `%2e`, or after a backslash): the URL parser resolves it, so the parsed form hides what the text held. */
export const DOT_SEGMENT = /[/\\](?:\.|%2e){1,2}(?=[/\\?#]|$)/i;

function redactUrlToken(core: string, allowlist: ReadonlySet<string>): string {
  const sanitized = sanitizeUrl(core, allowlist);
  try {
    const parsed = new URL(core);
    parsed.hash = '';
    // nothing sensitive: keep the text as written, unless it has a dot segment (`/alice%40x.test/../p` parses as `/p`)
    if (sanitized === parsed.toString() && !DOT_SEGMENT.test(core)) return core.replace(/#.*$/s, '');
  } catch {
    // not parsable: the sanitized form is the best-effort redaction
  }
  return sanitized;
}

/** Is there an address in a `mailto:` body: a literal "@" or a percent-encoded one, also twice (`%2540`). At most three rounds. */
function hasAddress(body: string): boolean {
  let current = body;
  for (let round = 0; round < 3; round++) {
    if (current.includes('@')) return true;
    const next = decodeLenient(current);
    if (next === current) return false;
    current = next;
  }
  return current.includes('@');
}

function redactToken(token: string, allowlist: ReadonlySet<string>): string {
  const mail = /^mailto:(\s*)([\s\S]*)$/i.exec(token);
  if (mail) {
    const [, space = '', value = ''] = mail;
    // the `(at)` form becomes `[redacted]@domain` first, so the value reads as the address it is
    const body = maskObfuscatedEmails(value);

    // after whitespace only a token with an address counts ("mailto: Kontakt aufnehmen" is prose); the prose stays but
    // any token inside it is redacted. The body is shorter than the token, so the recursion ends.
    if (space !== '' && !hasAddress(body)) return `mailto:${space}${redactText(body, allowlist)}`;
    const { core, tail } = splitTrailingPunctuation(body);
    return `${maskMailto(core)}${tail}`;
  }

  const { core, tail } = splitTrailingPunctuation(token);
  // `sanitizeUrl` masks addresses in the path; what is left (a kept query value) is masked here
  return `${maskEmailsInUrl(redactUrlToken(core, allowlist))}${tail}`;
}

/** Redacts addresses, `mailto:` values and URLs in `text`; `allowlist` names the query parameters whose value is kept. */
export function redactText(text: string, allowlist: ReadonlySet<string> = QUERY_ALLOWLIST): string {
  if (text === '') return text;

  // tokens first and as a whole: a bare address ending right before one (`a@x.dehttps://…`) must not swallow its start
  let out = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    out += maskEmails(text.slice(last, match.index));
    out += redactToken(match[0], allowlist);
    last = match.index + match[0].length;
  }

  return out + maskEmails(text.slice(last));
}
