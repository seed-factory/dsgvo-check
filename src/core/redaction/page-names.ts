/**
 * Short values a collector takes from a page and keeps outside free text: an id, a class token or an attribute value a
 * click selector is built from, a tag name, a role, the key of a consent category, a cookie or storage name of a
 * detection signal, a script type, an event name, a segment of a cookie path, a language tag. The page chooses them, so
 * a visitor id, a consent id or an address could stand in any of them: only what reads as a name stays. A value with
 * query or address syntax, a URL, whitespace, an invisible or look-alike character, or a run that looks like an ID or a
 * token (a session id, a hash, a UUID, a phone number) is not a name. Pure; code that runs in the page gets the same
 * rules as data (`NAME_RULES`).
 */
import { containsAddress } from '../url/email.ts';

/** A regular expression as data, so that code in the page can compile the same rule. */
export interface PagePattern {
  source: string;
  flags: string;
}

/** Characters of a base64-like token, `+` and `/` of base64 and `-` and `_` of base64url included. */
const TOKEN_CHARS = 'A-Za-z0-9+/_-';

/**
 * Words of three letters or more, every word after the first from a capital (`cookie`, `CybotCookiebotBanner`). Two
 * letters are no word here, since a random token has many such pairs (`Kd8sLq`). As each later word starts at a
 * capital, the test does not try the many ways a long run of letters could be cut into words.
 */
const WORDS = '[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})*';

/** Characters of a base64 run: `+` and `/` of base64 included, `-` and `_`, which vendors put between words, not. */
const BASE64_CHARS = 'A-Za-z0-9+/';

/**
 * Runs that make a value an identifier or a token rather than a name. The value is read in NFKC (a fullwidth digit is
 * the digit then) with the digits of every other script read as `0`. Six digits in a row (a timestamp, a numeric id),
 * eight digits in all (the groups of a phone, card or account number, an IP address), a hex run of eight or more that
 * mixes digits and letters, a base64 run of 16 or more with two digits and a letter, and a UUID are looked for as the
 * value stands. A hex run of 16 or more with a digit is also looked for with every character that is neither letter nor
 * digit removed, so that a dot, a hyphen or an invisible character inside a split hash does not hide it. A base64-like
 * run of 20 or more with a digit, `-` and `_` included, stays a name when its parts between `-` and `_` are words and at
 * most one part is or ends in a short group of letters or digits (`CybotCookiebotBannerCloseButtonE2E`,
 * `ch2-open-settings-btn`, `cookie-consent-banner-v2`), since vendors name their controls so; a token cut into short
 * parts (`x9Kq-Lm3P-zR7t-…`) has many such groups. A long run of letters alone stays a name
 * (`CybotCookiebotDialogBodyButtonDecline`).
 */
export const ID_LIKE = {
  otherDigit: { source: String.raw`(?![0-9])\p{N}`, flags: 'gu' },
  separator: { source: String.raw`[^\p{L}\p{N}]+`, flags: 'gu' },
  compact: [{ source: String.raw`(?<![0-9a-f])(?=[0-9a-f]*\d)[0-9a-f]{16}`, flags: 'i' }],
  plain: [
    { source: String.raw`\d{6}`, flags: '' },
    { source: String.raw`^(?:\D*\d){8}`, flags: '' },
    { source: String.raw`(?<![0-9a-f])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}`, flags: 'i' },
    {
      source: `(?<![${BASE64_CHARS}])(?=[${BASE64_CHARS}]*\\d[${BASE64_CHARS}]*\\d)(?=[${BASE64_CHARS}]*[A-Za-z])[${BASE64_CHARS}]{16}`,
      flags: '',
    },
    { source: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', flags: 'i' },
  ],
  token: { source: `(?<![${TOKEN_CHARS}])(?=[${TOKEN_CHARS}]*\\d)[${TOKEN_CHARS}]{20,}`, flags: 'g' },
  tokenSplit: { source: '[-_]', flags: '' },
  /** A part of a token run that is words, or a prefix of one or two lowercase letters (`uc`, `cc`). */
  word: { source: `^(?:${WORDS}|[a-z]{1,2})$`, flags: '' },
  /**
   * The one part of a token run that may be or end in a short group: words, then at most four letters or digits
   * (`CloseButtonE2E`, `v2`, `ch2`, `2`).
   */
  wordsWithGroup: { source: `^(?:${WORDS})?[A-Za-z0-9]{1,4}$`, flags: '' },
} as const satisfies {
  otherDigit: PagePattern;
  separator: PagePattern;
  compact: readonly PagePattern[];
  plain: readonly PagePattern[];
  token: PagePattern;
  tokenSplit: PagePattern;
  word: PagePattern;
  wordsWithGroup: PagePattern;
};

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
const TAG_NAME: PagePattern = { source: '^[a-z][a-z0-9]*(?:-[a-z0-9._-]*)*$', flags: '' };

/** The rules of `isNameLike` and `isTagName` as data, for the in-page probe. */
export const NAME_RULES = {
  maxLength: NAME_MAX_LENGTH,
  chars: NAME_CHARS,
  notName: [URL_LIKE],
  idLike: ID_LIKE,
  tag: { ...TAG_NAME, maxLength: TAG_NAME_MAX_LENGTH },
} as const;

const compile = (p: PagePattern): RegExp => new RegExp(p.source, p.flags);
const OTHER_DIGIT_RE = compile(ID_LIKE.otherDigit);
const SEPARATOR_RE = compile(ID_LIKE.separator);
const COMPACT_RES = ID_LIKE.compact.map(compile);
const PLAIN_RES = ID_LIKE.plain.map(compile);
const TOKEN_RE = compile(ID_LIKE.token);
const TOKEN_SPLIT_RE = compile(ID_LIKE.tokenSplit);
const WORD_RE = compile(ID_LIKE.word);
const WORDS_WITH_GROUP_RE = compile(ID_LIKE.wordsWithGroup);
const NAME_CHARS_RE = compile(NAME_CHARS);
const NOT_NAME_RES = NAME_RULES.notName.map(compile);
const TAG_NAME_RE = compile(TAG_NAME);

/** A token run is no name unless its parts are words with at most one part that is or ends in a short group. */
function isTokenOfWords(run: string): boolean {
  const rest = run.split(TOKEN_SPLIT_RE).filter((part) => !WORD_RE.test(part));
  return rest.length <= 1 && rest.every((part) => WORDS_WITH_GROUP_RE.test(part));
}

export function hasIdLikeRun(value: string): boolean {
  const n = value.normalize('NFKC').replace(OTHER_DIGIT_RE, '0');
  const compact = n.replace(SEPARATOR_RE, '');
  if (COMPACT_RES.some((re) => re.test(compact)) || PLAIN_RES.some((re) => re.test(n))) return true;
  return (n.match(TOKEN_RE) ?? []).some((run) => !isTokenOfWords(run));
}

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

export function isStoredName(name: string): boolean {
  return name.length <= STORED_NAME_MAX_LENGTH && STORED_NAME.test(name);
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
