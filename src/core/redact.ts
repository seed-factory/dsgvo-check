/**
 * Redaction of free text that a collector copies into the snapshot or that a check puts into evidence (AGENTS
 * rule 2): link text, accessible names, titles, parts of legal documents, DNS TXT records. Pure; no I/O.
 *
 * - `mailto:local@domain` → `mailto:[redacted]@domain` (headers dropped, one prefix per recipient kept);
 * - a bare `local@domain` → `[redacted]@domain` (the local part may be quoted or hold any character of RFC 5322);
 * - every `http(s)://…` substring goes through `sanitizeUrl` (query allowlist, path parameters, credentials, fragment).
 *
 * Domains and service names stay, so the matching of documents and services does not change. Phone numbers are not
 * touched (open question to the customer). The function is idempotent. Collectors call it before the text is
 * hashed, stored or used for evidence.
 */
import {
  decodeLenient,
  maskEmails,
  maskEmailsInUrl,
  maskMailto,
  QUERY_ALLOWLIST,
  QUOTED_LOCAL,
  REDACTED,
  sanitizeUrl,
} from './url.ts';

export { maskEmails, maskMailto };

/**
 * A quoted address that sits right behind a token, without a blank (`https://x.test/p?id="alice"@example.test`,
 * `mailto:a@x.test"b"@y.test`): the `"` ends the token, but the mask of the bare address eats that `"`, so on the
 * second pass the address would join the token and change it. The address belongs to the token from the start.
 * Each repetition starts with `"` and its tail cannot contain one: no ambiguity, at most 64 characters
 * looked at per attempt.
 */
const quotedTail = (char: string) => `(?:${QUOTED_LOCAL}@${char}+)*`;
/** A character of a URL token. */
const urlChar = String.raw`[^\s<>"]`;
/** A character of a `mailto:` value; not one that starts a URL (`https://…`), which is a token of its own. */
const mailtoChar = String.raw`(?:(?!https?:\/\/)[^\s<>";])`;

/**
 * An http(s) URL, a `mailto:` value (the address may follow whitespace). Tokens end at whitespace, `<`, `>` and `"`; a
 * `mailto:` value also ends at `;`, which separates the tags of a DMARC record (`rua=mailto:a@x;ruf=mailto:b@y;pct=100`):
 * the tags after the address must survive.
 *
 * An apostrophe (and a backtick) does not end a token: `'` is a legal character of a URL (`/o'brien`, `?name=l'a`), and
 * what follows it must still be redacted. A quote that really closes the text (`'https://…'`) is cut off
 * as trailing punctuation by `splitTrailingPunctuation`. In doubt more is redacted: two URLs that are joined by quotes
 * and a comma without a blank (`'https://a.test/x','https://b.test/y?t=1'`) are one token, and the query of it goes.
 *
 * A `mailto:` value is a list of recipients or a quoted address (`mailto: "alice smith"@example.test`). It ends in front
 * of a URL: a URL after `mailto:` and a blank is no recipient but a URL in prose (`mailto: https://shop.example.test/p;ord=…`),
 * and one that is glued to an address (`mailto:a@x.test#https://x.test/p;ord=…`) is a URL of its own. The URL token
 * has its own end, not the `;` of a DMARC tag.
 */
const URL_TOKEN = String.raw`https?:\/\/${urlChar}+${quotedTail(urlChar)}`;
const MAILTO_TOKEN = String.raw`mailto:\s*(?:${QUOTED_LOCAL}@${mailtoChar}+|${mailtoChar}+)${quotedTail(mailtoChar)}`;
const TOKEN_RE = new RegExp(`${URL_TOKEN}|${MAILTO_TOKEN}`, 'giu');

const OPENERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
/** Sentence punctuation, closing brackets and quotes (also `'` and the backtick) at the end of a token. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}»«“”„‘’>'`]/;

/**
 * Split trailing sentence punctuation off a token; closing brackets stay when the token has the opener. Linear: the
 * brackets are counted once, and cutting a closing bracket off the tail lowers only its own counter (openers are not
 * punctuation, so their number does not change while the tail shrinks). A run of 400 000 brackets must not hold the
 * thread.
 */
function splitTrailingPunctuation(token: string): { core: string; tail: string } {
  const count = new Map<string, number>();
  for (const ch of token) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === ')' || ch === ']' || ch === '}') {
      count.set(ch, (count.get(ch) ?? 0) + 1);
    }
  }
  let end = token.length;
  while (end > 0) {
    const ch = token.charAt(end - 1);
    if (!TRAILING_PUNCTUATION.test(ch)) break;
    // the `]` of our own mask `[redacted]` is not punctuation: with a stray `]` earlier in the token it would be cut off
    // on the second pass and the result would change (`https://x.test/p/]…?sid=[redacted]`)
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

/**
 * A segment `.` or `..` (also `%2e`, and with a backslash as a slash): the URL parser resolves it and drops the segment
 * in front of `..`, so a parsed form that equals the sanitized one does not show what the text held there.
 */
const DOT_SEGMENT = /[/\\](?:\.|%2e){1,2}(?=[/\\?#]|$)/i;

function redactUrlToken(core: string, allowlist: ReadonlySet<string>): string {
  const sanitized = sanitizeUrl(core, allowlist);
  try {
    const parsed = new URL(core);
    parsed.hash = '';
    // Nothing sensitive in it: keep the text as written (no added slash, no case folding of the host). Not when the
    // text has a dot segment: `/alice%40x.test/../p` parses as `/p`, and the text still holds the address.
    if (sanitized === parsed.toString() && !DOT_SEGMENT.test(core)) return core.replace(/#.*$/s, '');
  } catch {
    // not parsable: the sanitized form is the best-effort redaction
  }
  return sanitized;
}

/**
 * Is there an address in the body of a `mailto:` value? A literal "@" or one that is percent-encoded (also twice:
 * `%2540`); an invalid escape elsewhere does not matter. Three rounds of decoding at most, each linear.
 */
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
    const [, space = '', body = ''] = mail;
    // "mailto: Kontakt aufnehmen" is prose: after whitespace only a token with an address counts. An encoded address
    // ("mailto: %61lice%40example.test") counts as well. The prose itself stays, but whatever token sits
    // inside it does not (`mailto: x,mailto:y`); a URL after the blank is a token of its own, see `MAILTO_TOKEN`
    //. The body is shorter than the token and has no blank and no "@": the recursion ends.
    if (space !== '' && !hasAddress(body)) return `mailto:${space}${redactText(body, allowlist)}`;
    const { core, tail } = splitTrailingPunctuation(body);
    return `${maskMailto(core)}${tail}`;
  }
  const { core, tail } = splitTrailingPunctuation(token);
  // The address inside the URL is masked by `sanitizeUrl` (path); what is left (a kept query value) goes here.
  return `${maskEmailsInUrl(redactUrlToken(core, allowlist))}${tail}`;
}

/**
 * Redact e-mail addresses, `mailto:` values and URLs inside `text`. `allowlist` is the set of query parameter names
 * whose value is kept (default: the core allowlist; the browser collector passes its own).
 */
export function redactText(text: string, allowlist: ReadonlySet<string> = QUERY_ALLOWLIST): string {
  if (text === '') return text;
  // The tokens come first and as a whole: a bare address that ends right in front of one (`a@x.dehttps://…`, text
  // nodes joined without a blank) must not swallow its start. The address inside a token is the business of
  // `sanitizeUrl` / `maskMailto`, which know the structure of a URL; the text between the tokens is masked as text.
  let out = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    out += maskEmails(text.slice(last, match.index));
    out += redactToken(match[0], allowlist);
    last = match.index + match[0].length;
  }
  return out + maskEmails(text.slice(last));
}
