/**
 * Short values a collector takes from a page and keeps outside free text: an id, a class token or an attribute value a
 * click selector is built from, a tag name, a role, the key of a consent category, a cookie or storage name of a
 * detection signal, a script type, an event name, a segment of a cookie path, a language tag. The page chooses them, so
 * a visitor id, a consent id or an address could stand in any of them: only what reads as a name stays. A value with
 * query or address syntax, a URL, whitespace, an invisible or look-alike character, or a run that looks like an ID or a
 * token (a session id, a hash, a UUID, a phone number) is not a name. Pure; code that runs in the page gets the same
 * rules as data (`NAME_RULES`).
 */
import { containsAddress, decodeLenient, REDACTED } from '../url/email.ts';
import { hasIdLikeRun, ID_LIKE, OTHER_DIGIT_RE, type PagePattern, readsAsWords } from './id-like.ts';
import { redactText } from './redact.ts';

export { hasIdLikeRun, ID_LIKE, type PagePattern };

/**
 * The characters of a name, in the value as written and in NFKC: letters, digits, `_`, `.`, `:`, `/` and `-`.
 * Whitespace, format characters (zero-width space, bidi controls, soft hyphen), combining marks, private-use and
 * unassigned code points, default-ignorable letters (Hangul fillers), query and address syntax, quotes and brackets are
 * none of them; NFKC turns a fullwidth `＠`, `？` or `＝` into the ASCII one first.
 */
const NAME_CHARS: PagePattern = {
  source: String.raw`^(?:(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{N}_.:/-])+$`,
  flags: 'u',
};

/**
 * A URL out of characters a name may have: one with a scheme of an address, a document or code (`javascript:`,
 * `mailto:`), a protocol-relative one (`//host/…`) or a host name with a path (`host.test/u/…`). Other words before a
 * colon stay names (`md:w-1/2`, `hover:bg-blue-500`).
 */
const URL_LIKE: PagePattern = {
  source: String.raw`\/\/|^(?:https?|wss?|ftp|file|data|blob|javascript|vbscript|mailto|tel|sms|callto|intent):|^(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}\/`,
  flags: 'iu',
};

/** A selector value longer than this, as written or in NFKC, is no name. */
export const NAME_MAX_LENGTH = 80;

/** A custom element name may be long; a tag name beyond this is no name. */
export const TAG_NAME_MAX_LENGTH = 64;

/** HTML and custom element names as the parser lowercases them (`button`, `uc-button`). */
const TAG_NAME: PagePattern = { source: '^[a-z][a-z0-9]*(?:-[a-z0-9._-]*)?$', flags: '' };

/** The rules of `isNameLike` and `isTagName` as data, for the in-page probe. */
export const NAME_RULES = {
  maxLength: NAME_MAX_LENGTH,
  chars: NAME_CHARS,
  notName: [URL_LIKE],
  idLike: ID_LIKE,
  tag: { ...TAG_NAME, maxLength: TAG_NAME_MAX_LENGTH },
} as const;

const compile = (p: PagePattern): RegExp => new RegExp(p.source, p.flags);
const NAME_CHARS_RE = compile(NAME_CHARS);
const NOT_NAME_RES = NAME_RULES.notName.map(compile);
const TAG_NAME_RE = compile(TAG_NAME);

/**
 * A non-empty value of at most `maxLength` characters of a name, as written and in NFKC, without a URL, an address or an
 * ID-like run. On the Node side the value also passes the address check of the free-text redaction, so that a form of an
 * address it knows is no name whatever characters that form takes.
 */
export function isNameLike(value: unknown, maxLength: number = NAME_MAX_LENGTH): value is string {
  if (typeof value !== 'string') return false;
  const syntaxOk = (v: string) =>
    v.length > 0 && v.length <= maxLength && NAME_CHARS_RE.test(v) && !NOT_NAME_RES.some((re) => re.test(v));
  return (
    syntaxOk(value) && syntaxOk(value.normalize('NFKC')) && !containsAddress(value) && !hasIdLikeRun(value)
  );
}

export function isTagName(tag: string): boolean {
  return tag.length <= TAG_NAME_MAX_LENGTH && TAG_NAME_RE.test(tag) && !hasIdLikeRun(tag);
}

/** A cookie or storage name beyond this is no consent name of a vendor. */
const STORED_NAME_MAX_LENGTH = 128;

/**
 * A cookie or Web Storage name as a detection signal keeps it: letters, digits and `_`, `-`, `.`, `:` (Real Cookie
 * Banner's `real_cookie_banner-v:3_blog:1_path:…`). Never `=` or `;`, which separate a cookie's name from its value
 * and from the next cookie in `document.cookie`, never a blank, quote, `@`, `%` or a character outside ASCII.
 */
const STORED_NAME = /^[A-Za-z0-9_.:-]+$/;

export function hasStoredNameSyntax(name: string): boolean {
  return name.length <= STORED_NAME_MAX_LENGTH && STORED_NAME.test(name);
}

/** A stored name that carries no identifier; one that does still counts for recognition but is stored redacted. */
export function isStoredName(name: string): boolean {
  return hasStoredNameSyntax(name) && !hasIdLikeRun(name);
}

/** The key of a consent category beyond this is no name. */
export const CATEGORY_KEY_MAX_LENGTH = 64;

/** Letters and digits, then also blanks, `_`, `.` and `-`: `statistics`, `external-media`, `Präferenzen`, `2`. */
const CATEGORY_KEY = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;

export function isCategoryKey(key: string): boolean {
  return key.length <= CATEGORY_KEY_MAX_LENGTH && CATEGORY_KEY.test(key) && !hasIdLikeRun(key);
}

/**
 * The non-abstract roles of WAI-ARIA 1.2, with `image`, `suggestion` and `comment` of ARIA 1.3. A role token outside this
 * list is ignored by the browser too: it takes the next listed token, else the element's implicit role.
 */
export const ARIA_ROLES: readonly string[] = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'comment',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'image',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'mark',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'suggestion',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
];

const ROLE_SET: ReadonlySet<string> = new Set(ARIA_ROLES);

export function isAriaRole(role: string): boolean {
  return ROLE_SET.has(role);
}

/** BCP 47 language, script and region subtags; the variant and extension subtags after them are not kept. */
const LANGUAGE_PREFIX = /^[a-z]{2,3}(?:[-_][a-z]{4})?(?:[-_](?:[a-z]{2}|\d{3}))?(?=[-_]|$)/i;
/** Longest tag that counts as a language at all (RFC 5646, 4.4.1 asks implementations to support 35 characters). */
const MAX_LANGUAGE_TAG = 35;

/**
 * The language[-Script][-Region] start of a BCP 47 tag, as written (`de-DE`, `en`, `zh-Hant-TW`, `es-419`); an
 * underscore separator (`de_DE`) is taken as written too. Null for any other value, so text that only starts like a
 * tag (`de https://…`) is no language.
 */
export function languagePrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length > MAX_LANGUAGE_TAG) return null;
  return LANGUAGE_PREFIX.exec(v)?.[0] ?? null;
}

/** Letters of one case, with `-` or `_` between parts: a German compound in capitals is a word, not a token. */
const SINGLE_CASE_WORD = /^(?:\p{Lu}+|\p{Ll}+)(?:[-_](?:\p{Lu}+|\p{Ll}+))*$/u;
/** A short group of hex digits or digits, as a visitor id is cut into when it is printed with blanks; groups may be joined by `-,;|:./`. */
const GROUP = /^[0-9a-f]{1,12}(?:[-,;|:./][0-9a-f]{1,12})*$/i;
/**
 * A token without a letter or a digit is a gap between the groups of a printed id, and any such character at the edge
 * of a word wraps or separates its groups. The tail alternative starts at the beginning of a run, so a long run is
 * scanned once.
 */
const GROUP_EDGE = /^[^\p{L}\p{N}]+|(?<![^\p{L}\p{N}])[^\p{L}\p{N}]+$/gu;
const GROUP_GAP = /^[^\p{L}\p{N}]+$/u;
const FORMAT_CHARS = /\p{Cf}/gu;
const BLANKS = /(\s+)/;

type LabelToken = 'blank' | 'gap' | 'plain' | 'group' | 'id';

function labelTokenKind(token: string): LabelToken {
  if (token === '' || /^\s+$/.test(token)) return 'blank';
  if (GROUP_GAP.test(token)) return 'gap';
  if (!SINGLE_CASE_WORD.test(token) && hasIdLikeRun(token)) return 'id';
  return GROUP.test(token.replace(GROUP_EDGE, '')) ? 'group' : 'plain';
}

/**
 * Masks identifier-shaped words in a CMP control label: a word with an ID-like run, and a row of two or more short
 * hex or digit groups that read as an ID once joined (`4f3a 9c1d 2e7b`, `(4f3a, 9c1d)`, `4f3a | 9c1d`, `4f3a-9c1d
 * 2e7b-4a9f`, `123 456 789`). Punctuation around groups or alone between them does not break the row. A
 * word of letters of one case stays, since a label in capitals (`DATENSCHUTZEINSTELLUNGEN`) is still the word the
 * lexicon classifies by. A row is judged once, from its first group to its last, so the time grows with the label.
 */
export function redactCmpLabel(label: string): string {
  const tokens = label.split(BLANKS);
  const forms = tokens.map((t) => t.normalize('NFKC').replace(FORMAT_CHARS, ''));
  const kinds = forms.map(labelTokenKind);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (kinds[i] !== 'id' && kinds[i] !== 'group') {
      out.push(tokens[i]!);
      i++;
      continue;
    }
    let end = i;
    for (let j = i + 1; j < tokens.length && kinds[j] !== 'plain'; j++) {
      if (kinds[j] === 'id' || kinds[j] === 'group') end = j;
    }
    const members = [];
    for (let j = i; j <= end; j++) {
      if (kinds[j] === 'id' || kinds[j] === 'group') members.push(forms[j]!.replace(GROUP_EDGE, ''));
    }
    const isId =
      members.length > 1 && (kinds.slice(i, end + 1).includes('id') || hasIdLikeRun(members.join('')));
    if (isId || kinds[i] === 'id') out.push(REDACTED);
    else out.push(...tokens.slice(i, end + 1));
    i = end + 1;
  }
  return out.join('');
}

/** What the page code reads of a storage key or a cookie name: the redaction of an address runs on this, then the name is cut. */
export const KEY_READ_LIMIT = 400;
/** Longest storage key, IndexedDB name or cookie name kept. */
const KEY_MAX_LENGTH = 200;

/**
 * A local part of an address and its marker in a name, when a letter or `[` follows it: `alice@intranet`,
 * `alice(at)intranet`, `alice@[192.168.0.1]`. The address mask sees only a name with a domain; a version (`pkg@3.7.1`),
 * a digit, `_` or `-` behind the marker is not read as a domain, so a key keeps such a name (a cookie name with any
 * literal marker is not stored at all). A mask of ours (`[redacted]@`) has no local part left. At most 64 characters
 * before the marker, so the scan stays linear.
 */
const KEY_ADDRESS_MARKER = String.raw`(?:@|[(\[]at[)\]])`;
const KEY_LOCAL = String.raw`[^\s@:;,()<>"[\]\\/?#&=]{1,64}`;
const KEY_LOCAL_ADDRESS = new RegExp(`${KEY_LOCAL}${KEY_ADDRESS_MARKER}(?=\\p{L}|\\[)`, 'giu');
/** The same at the end of a name that the read cut: the domain may be missing or not whole. */
const KEY_CUT_ADDRESS = new RegExp(`${KEY_LOCAL}(?:@|[(\\[]at[)\\]]?)[^\\s@]*$`, 'u');

/** A UUID, also with `_` between its groups or none. */
const KEY_UUID =
  /(?<![0-9a-f])[0-9a-f]{8}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{4}[-_]?[0-9a-f]{12}(?![0-9a-f])/gi;
const KEY_BASE64_CHARS = 'A-Za-z0-9+/';
const KEY_BASE64_MIN = 20;
/** A base64 run of 20 or more with two digits and both cases: an id that was encoded, not words. */
const KEY_BASE64 = new RegExp(
  `(?<![${KEY_BASE64_CHARS}])(?=[${KEY_BASE64_CHARS}]*\\d[${KEY_BASE64_CHARS}]*\\d)(?=[${KEY_BASE64_CHARS}]*[a-z])(?=[${KEY_BASE64_CHARS}]*[A-Z])[${KEY_BASE64_CHARS}]{${KEY_BASE64_MIN},}`,
  'g',
);
/** A word that is glued to its id (`oeu1612345678901`, `hjIncludedInSessionSample4f3a…`) stays when the id goes. */
const KEY_GLUED_WORD = /^\p{L}{3,}(?=\d)/u;
const KEY_LETTERS = /^[A-Za-z]+/;
/** A rest of a base64 run shorter than this behind words is a site id or a year, not an id of its own. */
const KEY_SHORT_REST = 12;
/** What may follow words in such a short rest: numbers of up to four digits, each with words of three letters or more after it (`2024Accept`, `3Live443`, `01Prod443`). */
const KEY_NUMBERS_AND_WORDS = /^(?:\d{1,4}(?:[A-Za-z]{3,})?)+$/;
const KEY_WORD_RUNS = /[A-Za-z]+/g;
const KEY_SEPARATORS = /[-_]/g;
/** A part that reads as a word on its own: letters of one case, or words from a capital (`session`, `SESSION`, `ConsentBanner`). */
const KEY_WORD_PART = /^(?:\p{Ll}{3,}|\p{Lu}{3,}|\p{Lu}\p{Ll}{2,}(?:\p{Lu}\p{Ll}{2,})*)$/u;
const KEY_PART_SPLIT = /([^\p{L}\p{N}]+)/u;
/** What joins the groups of one id; any other separator ends the chain. */
const KEY_JOIN = /^(?:[-_]+|[.:])$/;
const KEY_ENCODED_JOIN = /^[-_]+$/;
const KEY_HEX = /^[0-9a-f]+$/i;
const KEY_DIGITS = /^\d+$/;
const KEY_LONG_DIGITS = /\d{10}/;
const KEY_HEX_LETTER = /[a-f]/i;
/** A hex run of 16 or more with a digit and a letter inside a part, whatever letters stand next to it. */
const KEY_HEX_RUN = /(?<![0-9a-f])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,}/gi;
/** Hex of this length with a digit and a letter, and digits of this count, only a per-visitor id has. */
const KEY_HEX_MIN = 16;
const KEY_DIGITS_MIN = 10;

/** Words of three letters or more, each after the first from a capital: what a glued word must be, since a random run has no such prefix for long. */
const KEY_PLAIN_WORDS = /^[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})*$/;

/**
 * Judges a base64 run (20 or more characters with two digits and both cases) by the letters in front of its first digit
 * and what follows. A site id behind words stays (`_hjIncludedInSessionSample1234567`, `cookieConsentBanner2024Accept`),
 * so does hex that the hex rule judges (`ASPSESSIONID4f3a…`); any other run is an id, and only a prefix of plain words
 * (`cookieConsentBanner`) stays in front of it, a random letter prefix goes with the id.
 */
const maskBase64Run = (run: string): string => {
  const letters = KEY_LETTERS.exec(run)?.[0] ?? '';
  const rest = run.slice(letters.length);
  const hexRest = KEY_HEX.test(rest);
  if (hexRest && rest.length >= KEY_HEX_MIN) return run;
  if (rest.length < KEY_SHORT_REST && readsAsWords(letters)) {
    const numbersAndWords =
      KEY_NUMBERS_AND_WORDS.test(rest) &&
      (rest.match(KEY_WORD_RUNS) ?? []).every((w) => KEY_WORD_PART.test(w));
    if (hexRest || numbersAndWords) return run;
  }
  return KEY_PLAIN_WORDS.test(letters) ? `${letters}${REDACTED}` : REDACTED;
};

interface IdRange {
  start: number;
  end: number;
  /** The whole first part goes, with a word glued to it: the letters in front of a random run are part of it. */
  bare?: true;
}

/** The digit-only groups of `from..to` that follow one another, as ranges of ten digits or more. */
function digitRangesOf(
  chain: readonly number[],
  core: (k: number) => string,
  from: number,
  to: number,
): IdRange[] {
  const ranges: IdRange[] = [];
  for (let k = from; k <= to; k++) {
    if (!KEY_DIGITS.test(core(k))) continue;
    let last = k;
    let digits = core(k).length;
    while (last < to && KEY_DIGITS.test(core(last + 1))) digits += core(++last).length;
    if (digits >= KEY_DIGITS_MIN) ranges.push({ start: chain[k]!, end: chain[last]! });
    k = last;
  }
  return ranges;
}

const KEY_ENCODED_CASES = [/\d.*\d/, /\p{Ll}/u, /\p{Lu}/u];
const KEY_LETTERS_ONLY = /^[A-Za-z]+$/;
const isEncodedPart = (part: string): boolean =>
  part !== '' && !KEY_DIGITS.test(part) && !KEY_WORD_PART.test(part);
const isVendorPrefix = (part: string): boolean =>
  KEY_LETTERS_ONLY.test(part) && (part.length <= 2 || readsAsWords(part));
const isEncodedRun = (joined: string): boolean => {
  if (joined.length < KEY_BASE64_MIN || !KEY_ENCODED_CASES.every((re) => re.test(joined))) return false;
  const compact = joined.replace(KEY_SEPARATORS, '');
  return maskBase64Run(compact) !== compact;
};

function encodedRangesOf(chain: readonly number[], pieces: readonly string[]): IdRange[] {
  const ranges: IdRange[] = [];
  const core = (k: number): string => pieces[chain[k]!] ?? '';
  const firstPart = pieces.findIndex((piece, index) => index % 2 === 0 && piece !== '');
  for (let k = 0; k < chain.length; k++) {
    if (!isEncodedPart(core(k)) || (chain[k] === firstPart && isVendorPrefix(core(k)))) continue;
    let last = k;
    let joined = core(k);
    while (last + 1 < chain.length && isEncodedPart(core(last + 1))) {
      const separator = pieces[chain[last]! + 1] ?? '';
      if (!/^[-_]+$/.test(separator)) break;
      last++;
      joined += `${separator}${core(last)}`;
    }
    if (last > k && isEncodedRun(joined)) ranges.push({ start: chain[k]!, end: chain[last]!, bare: true });
    k = last;
  }
  return ranges;
}

/**
 * The ranges of parts of one chain (parts joined by `-`, `_`, `:` or `.`) that make an id: hex of 16 or more
 * with a digit and a letter, ten digits or more, in one part or in groups, judged as the joined run.
 */
function idRangesOf(chain: readonly number[], cores: ReadonlyMap<number, string>): IdRange[] {
  const ranges: IdRange[] = [];
  const core = (k: number): string => cores.get(chain[k]!) ?? '';
  for (let k = 0; k < chain.length; k++) {
    if (KEY_LONG_DIGITS.test(core(k))) ranges.push({ start: chain[k]!, end: chain[k]! });
  }
  for (let k = 0; k < chain.length; k++) {
    if (!KEY_HEX.test(core(k))) continue;
    let last = k;
    while (last + 1 < chain.length && KEY_HEX.test(core(last + 1))) last++;
    let joined = '';
    for (let n = k; n <= last; n++) joined += core(n);
    if (joined.length >= KEY_HEX_MIN && /\d/.test(joined) && KEY_HEX_LETTER.test(joined)) {
      ranges.push({ start: chain[k]!, end: chain[last]! });
    } else {
      ranges.push(...digitRangesOf(chain, core, k, last));
    }
    k = last;
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

function mergedRanges(sorted: readonly IdRange[]): IdRange[] {
  const merged: IdRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      if (range.bare && range.start === last.start) last.bare = true;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Masks the ids in a name: a UUID, a hex run of 16 or more with a digit and a letter (also in groups joined by `-`, `_`,
 * `:` or `.`), ten digits or more in a row or in a chain of groups, a base64 run of 20 or more. A name is chosen by the
 * site's scripts and the service catalog and the allowlist match by it (`_hjSessionUser_1234567`, `TS01dc4fc6`,
 * `_ga_ABCD1234EF`, `incap_ses_123_456789`), so shorter ids and ids in words stay; a word glued to the id stays too.
 */
function maskIdRuns(text: string): string {
  const pieces = text.replace(KEY_UUID, REDACTED).replace(KEY_BASE64, maskBase64Run).split(KEY_PART_SPLIT);
  const cores = new Map<number, string>();
  const words = new Map<number, string>();
  for (let p = 0; p < pieces.length; p += 2) {
    const part = pieces[p]!;
    KEY_HEX_RUN.lastIndex = 0;
    const hexMatch = KEY_HEX_RUN.exec(part);
    const hexStart = hexMatch?.index;
    const gluedWord = KEY_HEX.test(part) ? '' : (KEY_GLUED_WORD.exec(part)?.[0] ?? '');
    const glued =
      hexStart !== undefined &&
      hexStart < gluedWord.length &&
      hexStart + hexMatch![0].length - gluedWord.length < KEY_HEX_MIN
        ? part.slice(0, hexStart)
        : gluedWord;
    const word = KEY_HEX.test(glued) ? '' : glued;
    words.set(p, word);
    let core = part.slice(word.length);
    if (!KEY_HEX.test(core) && core.length >= KEY_HEX_MIN) {
      const masked = core.replace(KEY_HEX_RUN, REDACTED);
      if (masked !== core) {
        core = masked;
        pieces[p] = `${word}${core}`;
      }
    }
    cores.set(p, core);
  }

  const ranges: IdRange[] = [];
  for (let p = 0; p < pieces.length; ) {
    const chain = [p];
    while (KEY_ENCODED_JOIN.test(pieces[p + 1] ?? '') && pieces[p + 2]) {
      p += 2;
      chain.push(p);
    }
    ranges.push(...encodedRangesOf(chain, pieces));
    p += 2;
  }
  for (let p = 0; p < pieces.length; ) {
    const chain = [p];
    while (KEY_JOIN.test(pieces[p + 1] ?? '') && pieces[p + 2] !== undefined && pieces[p + 2] !== '') {
      p += 2;
      chain.push(p);
    }
    ranges.push(...idRangesOf(chain, cores));
    p += 2;
  }

  const merged = mergedRanges(ranges.sort((a, b) => a.start - b.start || b.end - a.end));
  const out: string[] = [];
  let r = 0;
  for (let p = 0; p < pieces.length; p++) {
    while (merged[r] && merged[r]!.end < p) r++;
    const range = merged[r];
    if (range && range.start <= p) {
      out.push(`${range.bare ? '' : (words.get(range.start) ?? '')}${REDACTED}`);
      p = range.end;
      continue;
    }
    out.push(pieces[p]!);
  }
  return out.join('');
}

export const foldedName = (read: string): string =>
  read.normalize('NFKC').replace(FORMAT_CHARS, '').replace(OTHER_DIGIT_RE, '0');

/**
 * Does a name hold an address: one with a domain, written out, percent-encoded, in fullwidth characters or cut at the
 * limit of the read, or a local part with its `@` or `(at)` and nothing yet that reads as a domain (`alice@intranet`)?
 */
export function nameHoldsAddress(raw: string, readLimit: number = KEY_READ_LIMIT): boolean {
  const read = raw.slice(0, readLimit);
  let form = read;
  for (let round = 0; round < 4; round++) {
    const folded = foldedName(form);
    if (containsAddress(folded) || (round === 0 && folded.search(KEY_LOCAL_ADDRESS) >= 0)) return true;
    form = decodeLenient(form);
  }
  return false;
}

/**
 * A storage key or an IndexedDB name as it is stored. It is free page text: an address is masked, also when it is
 * percent-encoded, in fullwidth characters or cut at the limit of the page's read, a URL query is cut to `?[redacted]`,
 * and the ids of `maskIdRuns` become `[redacted]`. The name is read in NFKC, up to `readLimit` characters, and stored up
 * to 200.
 */
export function storedKey(raw: string, readLimit: number = KEY_READ_LIMIT): string {
  const read = raw.slice(0, readLimit);
  const folded = foldedName(read);
  const cutRead = raw.length >= readLimit;
  let text = folded;
  if (cutRead || nameHoldsAddress(read, readLimit)) {
    for (let round = 0; round < 3; round++) text = foldedName(decodeLenient(text));
  }
  text = maskIdRuns(redactText(text).replace(KEY_LOCAL_ADDRESS, `${REDACTED}@`));
  const query = text.indexOf('?');
  if (query >= 0) text = `${text.slice(0, query)}?${REDACTED}`;
  const cut = cutRead || text.length > KEY_MAX_LENGTH;
  text = text.slice(0, KEY_MAX_LENGTH);
  return cut ? text.replace(KEY_CUT_ADDRESS, `${REDACTED}@`) : text;
}
