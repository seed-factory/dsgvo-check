/**
 * What makes a short value from a page an identifier rather than a name: the runs of `ID_LIKE` and `hasIdLikeRun`, which
 * read them. The patterns are data, so that code that runs in the page compiles the same rules (src/cmp/page/probe.ts).
 */
/** A regular expression as data, so that code in the page can compile the same rule. */
export interface PagePattern {
  source: string;
  flags: string;
}

export interface IdLikePatterns {
  otherDigit: PagePattern;
  separator: PagePattern;
  compact: readonly PagePattern[];
  plain: readonly PagePattern[];
  token: PagePattern;
  tokenSplit: PagePattern;
  word: PagePattern;
  version: PagePattern;
  smallNumber: PagePattern;
  wordsWithGroup: PagePattern;
  lettersSplit: PagePattern;
  letters: PagePattern;
}

/** Characters of a token run: base64 with `+` and `/`, `-` and `_` of base64url, and `.` and `:` as vendors join words. */
const TOKEN_CHARS = 'A-Za-z0-9+/_.:-';

/**
 * Words of three letters or more, every word after the first from a capital (`cookie`, `CybotCookiebotBanner`). Two
 * letters are no word here, since a random token has many such pairs (`Kd8sLq`). As each later word starts at a
 * capital, the test does not try the many ways a long run of letters could be cut into words.
 */
const WORDS = '[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})*';

/** Characters of a base64 run: `+` and `/` of base64 included, `-` and `_`, which vendors put between words, not. */
const BASE64_CHARS = 'A-Za-z0-9+/';

/** A part of a token run that is no group: words, one or two lowercase letters, or a region code in capitals. */
const WORD_PART = `${WORDS}|[a-z]{1,2}|[A-Z]{2}`;

/**
 * Letters of a run without a digit as camelCase: a lowercase word or a capitalized one, then capitalized words, short
 * words (`By`, `In`, `Ok`, `Ad`, `Js`, `Mc`), acronyms of up to eight capitals with an optional plural `s`
 * (`GDPRCCPA`, `IDs`) and a single capital between a lowercase word and a longer capitalized one (`CloseXButton`), then maybe one capital as a suffix
 * (`GDPRConsentBannerWrapper`, `cookieNoticeOkButton`, `reCAPTCHAConsent`, `PhaseB`). A part in capitals alone may be
 * up to 16 letters (`EINSTELLUNGEN`), a single letter is a part too (`X-Content-Type-Options`). An acronym ends at the
 * next capitalized word or at the end, so every text has one way to be cut and the test stays linear. A random base64
 * run has capitals alone, pairs and words of one or two letters that no list names.
 */
const CAPITALIZED = '[A-Z][a-z]{2,}';
const SHORT_WORD = '(?:By|In|On|Ok|Of|To|No|Is|As|At|Or|If|Up|Id|Ui|Do|Go|Ad|Js|Mc)(?![a-z])';
const ACRONYM = '[A-Z]{2,8}s?(?:(?![A-Za-z])|(?=[A-Z][a-z]))';
const SINGLE_CAPITAL = '(?<=[a-z]{3})[A-Z](?=[A-Z][a-z]{4,})';
const CAMEL_WORD = `(?:${CAPITALIZED}|${SHORT_WORD}|${ACRONYM}|${SINGLE_CAPITAL})`;
const LETTERS = `^(?:[A-Za-z]|[A-Z]{2,16}|(?:[a-z]+|${CAMEL_WORD})${CAMEL_WORD}*[A-Z]?)$`;

/**
 * Runs that make a value an identifier or a token rather than a name. The value is read in NFKC (a fullwidth digit is
 * the digit then) with the digits of every other script read as `0`. Six digits in a row (a timestamp, a numeric id),
 * eight digits in all (the groups of a phone, card or account number, an IP address), a hex run of eight or more that
 * mixes digits and letters, a base64 run of 16 or more with two digits and a letter, and a UUID are looked for as the
 * value stands. A hex run of 16 or more with a digit is also looked for with every character that is neither letter nor
 * digit removed, so that a dot, a hyphen or an invisible character inside a split hash does not hide it.
 *
 * A run of 20 or more token characters (`-`, `_`, `.`, `:`, `/` and `+` among them) is judged by its parts, since
 * vendors name their controls from words. With a digit, the parts between `-`, `_`, `.` and `:` must be words, with at
 * most one part that is or ends in a short group (`CybotCookiebotBannerCloseButtonE2E`, `ch2-open-settings-btn`,
 * `dark:hover:bg-gray-700/50`) or two parts that are numbers of up to three digits (`v:3_blog:100`); a token cut into
 * short parts (`x9Kq-Lm3P-zR7t-…`) or a number split into groups (`order-confirmation-1234-567`) has more. A dotted
 * version (`v1.2.3`) is no part, and a part that joins words with `/` (`group-hover/item`) is words. Without a digit
 * (`uHSRxnPAZmKQVeTWyDBcfGJL`) every part between those separators and `/` and `+` must read as camelCase words, short
 * words and acronyms, or as one word in capitals (`CookiebotOnConsentReady`, `sp_choice_type_SAVE_AND_EXIT`).
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
  token: { source: `(?<![${TOKEN_CHARS}])[${TOKEN_CHARS}]{20,}`, flags: 'g' },
  tokenSplit: { source: '[-_.:]', flags: '' },
  /**
   * A part of a token run with a digit that is words, a prefix of one or two lowercase letters (`uc`, `cc`) or a region
   * code (`US`), or several of them joined by `/` (`hover/item` of a Tailwind named variant).
   */
  word: { source: `^(?:${WORD_PART})(?:/(?:${WORD_PART}))*$`, flags: '' },
  /** A dotted version of up to four numbers, with its `v`: cut out of a token run before its parts are judged. */
  version: {
    source: String.raw`(?<![\p{L}\p{N}])v?[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}(?![\p{L}\p{N}])`,
    flags: 'giu',
  },
  /** A part of such a run that is a number of up to three digits; two of them may stand in place of a short group. */
  smallNumber: { source: '^[0-9]{1,3}$', flags: '' },
  /**
   * The one part of a token run that may be or end in a short group: words, then at most four letters or digits, and a
   * fraction of digits for a Tailwind opacity (`CloseButtonE2E`, `v2`, `ch2`, `2`, `700/50`).
   */
  wordsWithGroup: { source: `^(?:${WORDS})?[A-Za-z0-9]{1,4}(?:/[0-9]{1,3})?$`, flags: '' },
  /** Where a run without a digit is cut into parts. */
  lettersSplit: { source: '[-_.:/+]', flags: '' },
  /** A part of a run without a digit: camelCase words, short words and acronyms, or capitals alone. */
  letters: { source: LETTERS, flags: '' },
} as const satisfies IdLikePatterns;

const compile = (p: PagePattern): RegExp => new RegExp(p.source, p.flags);
export const OTHER_DIGIT_RE = compile(ID_LIKE.otherDigit);
const SEPARATOR_RE = compile(ID_LIKE.separator);
const COMPACT_RES = ID_LIKE.compact.map(compile);
const PLAIN_RES = ID_LIKE.plain.map(compile);
const TOKEN_RE = compile(ID_LIKE.token);
const TOKEN_SPLIT_RE = compile(ID_LIKE.tokenSplit);
const WORD_RE = compile(ID_LIKE.word);
const VERSION_RE = compile(ID_LIKE.version);
const SMALL_NUMBER_RE = compile(ID_LIKE.smallNumber);
const WORDS_WITH_GROUP_RE = compile(ID_LIKE.wordsWithGroup);
const LETTERS_SPLIT_RE = compile(ID_LIKE.lettersSplit);
const LETTERS_RE = compile(ID_LIKE.letters);

/** Do these letters read as words (camelCase, short words, acronyms, capitals alone) and not as a random run? */
export const readsAsWords = (letters: string): boolean => LETTERS_RE.test(letters);

/** A token run is no name unless its parts are words (see `ID_LIKE`); one with a digit may keep a short group. */
function isTokenOfWords(run: string): boolean {
  if (!/\d/.test(run))
    return run.split(LETTERS_SPLIT_RE).every((part) => part === '' || LETTERS_RE.test(part));
  const rest = run
    .replace(VERSION_RE, '-')
    .split(TOKEN_SPLIT_RE)
    .filter((part) => part !== '' && !WORD_RE.test(part));
  if (rest.length <= 1) return rest.every((part) => WORDS_WITH_GROUP_RE.test(part));
  return rest.length === 2 && rest.every((part) => SMALL_NUMBER_RE.test(part));
}

export function hasIdLikeRun(value: string): boolean {
  const n = value.normalize('NFKC').replace(OTHER_DIGIT_RE, '0');
  const compact = n.replace(SEPARATOR_RE, '');
  if (COMPACT_RES.some((re) => re.test(compact)) || PLAIN_RES.some((re) => re.test(n))) return true;
  return (n.match(TOKEN_RE) ?? []).some((run) => !isTokenOfWords(run));
}
