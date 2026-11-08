/**
 * Short values taken from a page: an id, class token or attribute value a stored selector is built from, a tag name, a
 * role, a consent category key, a cookie or storage name of a detection signal, a language tag. What a vendor or a site
 * names its controls stays a name; query or address syntax, a URL, whitespace, invisible and look-alike characters and
 * runs that look like an ID or a token do not. A language tag keeps its language, script and region.
 */
import { describe, expect, it } from 'vitest';
import { loadLexicon } from '../../../../src/cmp/lexicon-file.ts';
import { loadDataDir } from '../../../../src/core/data/load.ts';
import { storedCookieName, storedHeaderName } from '../../../../src/core/redaction/headers.ts';
import {
  ARIA_ROLES,
  hasIdLikeRun,
  isAriaRole,
  isCategoryKey,
  isNameLike,
  isStoredName,
  isTagName,
  languagePrefix,
  NAME_MAX_LENGTH,
  NAME_RULES,
  type PagePattern,
  redactCmpLabel,
  storedKey,
} from '../../../../src/core/redaction/page-names.ts';

/** Random base64-like tokens cut by `-` or `_` into short parts, as a session id or a licence key is. */
const SPLIT_TOKENS = [
  'x9Kq-Lm3P-zR7t-Wb2N-vC5s-Df8G-hJ1k-Qa4E',
  'Token_aB3d_9Kx2_mQ7z_P4wR_t8Yn',
  'Kd8sLq-Mz3pRt-Wx7vNb-Qa2cEf',
  'IwAR3x-Kq9Lm-Zp2Rt-Wb7N-vC5s',
  'K7QM-2XPA-9RTW-4ZNB-6HJC',
];

describe('isNameLike: values a stored click selector may carry', () => {
  it.each([
    'CybotCookiebotDialogBodyButtonDecline',
    'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection',
    'uc-accept-all-button',
    'brlbs-btn-accept-only-essential',
    'refuse-btn',
    'ch2-allow-all-btn',
    'cmplz-deny',
    'Akzeptieren',
    'accept',
    ':r1:',
    'w-1/2',
    'hover:bg-blue-500',
    'Präferenzen',
    'btn_2024',
    'CybotCookiebotBannerCloseButtonE2E',
    'cookie-consent-banner-v2',
    'ConsentButtonAcceptAllV2',
    'ｃｍｐ-accept',
    'v1.2.3',
    'grid-cols-12',
    'ch2-open-settings-btn',
    'section_2_cookie_consent',
    'uc-accept-all-button-v2',
    'uc-deny-all-button',
    'data-borlabs-cookie-actions',
    'cookie-einstellungen',
    'md:w-1/2',
    'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'cookieconsentacceptall',
    'onetrust-accept-btn-handler',
    'lg:hover:bg-blue-500',
    'cookie-consent.banner-wrapper',
    'sp_choice_type_SAVE_AND_EXIT',
    'sp_choice_type_ACCEPT_ALL',
    'sp_choice_type_REJECT_ALL',
    'sp_choice_type_11',
    'CookiebotOnConsentReady',
    'CookiebotOnDialogDisplay',
    'CookiebotOnDialogInit',
    'COOKIE_CONSENT_ACCEPTED',
    'UC_UI_INITIALIZED_EVENT',
    'CybotCookiebotDialogPoweredByText',
    'cookieConsentOptInButton',
    'cookieNoticeOkButton',
    'GDPRConsentBannerWrapper',
    'CookieConsentOKButton',
    'CybotCookiebotDialogTabContentIABVendors',
    'NECESSARY_AND_PREFERENCES',
    'COOKIE-EINSTELLUNGEN',
    'dark:hover:bg-gray-700/50',
    'real_cookie_banner-v:3_blog:1_path:sim',
    'real_cookie_banner-v:3_blog:100_path:sim',
    'real_cookie_banner-v:3_blog:1_path:en_US',
    'group-hover/item:bg-gray-100',
    'peer-checked/draft:text-sky-500',
    'group-hover/btn:opacity-75',
    'group-focus/link:ring-blue-600',
    'gdpr-cookie-notice-v1.2.3',
    'cookie-law-v3.4.10-accept',
    'GoogleAdSenseConsentBox',
    'cookieConsentAdChoicesLink',
    'reCAPTCHAConsentPlaceholder',
    'consentPurposeIDsList',
    'CookieBannerCloseXButton',
    'cookieBannerJsWrapper',
    'McAfeeSecureTrustmark',
    'GDPRCCPAConsentBanner',
    'IABTCFConsentStringBox',
  ])('%s is a name', (value) => {
    expect(isNameLike(value)).toBe(true);
  });

  it.each([
    ['a query', 'Akzeptieren?sid=zq7abc'],
    ['a parameter pair', 'sid=zq7abc'],
    ['two parameters', 'a&b'],
    ['an address', 'zq7alice@example.test'],
    ['a URL', 'https://x.test/p'],
    ['a scheme-relative URL', 'x://y'],
    ['a protocol-relative URL', '//evil.test/u/alice.mueller'],
    ['a host name with a path', 'evil.test/u/alice.mueller'],
    ['a mailto: URL', 'mailto:alice.mueller'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['percent-encoding', 'zq7%40example.test'],
    ['a blank', 'Alle akzeptieren'],
    ['a no-break space', 'zq7nb\u00a0x'],
    ['a newline', 'a\nb'],
    ['a control character', 'a\u0001b'],
    ['a double quote', 'a"b'],
    ['a single quote', "a'b"],
    ['a backslash', 'a\\b'],
    ['eight digits', 'order-12345678'],
    ['a hex hash', 'cid-9f86d081884c7d659a2feaa0c55ad015'],
    ['a hex id glued to a word', 'uid5f4dcc3b5aa765d6'],
    ['a short hex id that mixes digits and letters', 'uid-4f3a9c1d2e7b'],
    ['a base64-like token', 'tok-QWxhZGRpbjpvcGVuIHNlc2Ft'],
    ['a UUID', 'x-123e4567-e89b-12d3-a456-426614174000'],
    ['nothing', ''],
    ['too long', 'a'.repeat(NAME_MAX_LENGTH + 1)],
    ['a hex hash split by a zero-width space', '9f86d081884c7d6\u200b59a2feaa0c55ad0'],
    ['a right-to-left override', 'zq7\u202egnp.exe'],
    ['a soft hyphen', 'zq7\u00adtoken'],
    ['a left-to-right mark', 'zq7\u200etoken'],
    ['a private-use character', 'zq7\ue000token'],
    ['an unassigned code point', 'zq7\u{e0fff}token'],
    ['a zero-width space inside a word', 'alice\u200bmueller'],
    ['a Hangul filler inside a token', 'Xk2mQ9pL\u3164w8eR1tZ3'],
    ['a Hangul jungseong filler inside a token', 'Xk2mQ9pL\u1160w8eR1tZ3'],
    ['a fullwidth at sign', 'max.mustermann\uff20zq7mail.test'],
    ['a small at sign', 'max.mustermann\ufe6bexample.de'],
    ['a fullwidth query', 'track\uff1fsid\uff1dabc123'],
    ['an address with (at)', 'erika.zq7(at)example.test'],
    ['an address with [at]', 'max.mustermann[at]example.de'],
    ['a phone number', 'tel:+49-151-1234-5678'],
    ['an IP address', 'ip-203.0.113.42'],
    ['a hex hash split by a dot', 'a1b2c3d4e5f6a7b.8c9d0e1f2a3b4c5'],
    ['a date-like digit run split by hyphens', 'zq7-0151-1234-5678'],
    ['fullwidth digits', 'zq7-\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18'],
    ['Arabic-Indic digits', 'zq7-\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668'],
    ['a token that is no words with a suffix', 'ConsentQWxhZGRpbjpvcGVu9'],
    ['a base64-like run with a slash', 'zq7Abc/defGhijkl/mnop1'],
    ['a variation selector inside a token', 'ConsentQWxhZGRp\ufe00bjpvcGVu9'],
    ['an expansion beyond the length', '\u3392'.repeat(30)],
    ['a mixed-case run of letters without a digit', 'uHSRxnPAZmKQVeTWyDBcfGJL'],
    ['a base64 run of letters without a digit', 'dmlzaXRvckFsaWNldmlzaXRvckFsaWNl'],
    ['a token cut into short parts by dots', 'x9Kq.Lm3P.zR7t.Wb2N.vC5s.Df8G.hJ1k'],
    ['24 capitals without a digit', 'ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['a base64 run with capitals in pairs', 'dmlzaXRvckFsaWNldmlzaXRvckFsaWNlXXYY'],
    ['a number split into groups of four and three', 'order-confirmation-1234-567'],
    ['words with three groups', 'page-12-item-345-ab-67'],
    ['words with four small numbers', 'ab-12-cd-34-ef-56-gh-7'],
    ['a number among words', '6428-session-user-consent-68-consent-cookie'],
    ['seven single digits', 'cart-1-2-3-4-5-6-7-x-y-z'],
    ['words and a group joined by slashes', 'abc/def/ghi/jkl/mno/p1'],
    ['a version with the digits of an id', 'x9Kq-Lm3P-v1.2.3-zR7t-Wb2N'],
    ['a region code among short groups', 'ab-US-x9Kq-Lm3P-zR7t-Wb2N'],
    ...SPLIT_TOKENS.map((t): [string, string] => ['a base64-like token cut into short parts', t]),
  ])('%s is no name: %j', (_case, value) => {
    expect(isNameLike(value)).toBe(false);
  });

  it('a value that is no string is no name', () => {
    expect(isNameLike(7)).toBe(false);
    expect(isNameLike(['refuse-btn'])).toBe(false);
  });

  it('the ids and classes of the vendor selectors in adapters.yaml are names', () => {
    const selectors: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') selectors.push(v);
      else if (Array.isArray(v)) for (const x of v) walk(x);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    const adapters = loadDataDir('cmp').adapters as Record<
      string,
      { banner: unknown; settingsLayer?: unknown }
    >;
    for (const a of Object.values(adapters)) walk([a.banner, a.settingsLayer]);
    const names = selectors.flatMap((s) =>
      [...s.matchAll(/[#.](-?[A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? ''),
    );
    expect(names).toContain('CybotCookiebotBannerCloseButtonE2E');
    expect(names.filter((n) => !isNameLike(n))).toEqual([]);
  });

  it('the banner container names of probe.yaml are names', () => {
    const probe = loadDataDir('cmp').probe as { bannerContainerNames: string[] };
    expect(probe.bannerContainerNames).toContain('real-cookie-banner');
    expect(probe.bannerContainerNames.filter((n) => !isNameLike(n))).toEqual([]);
  });

  it.each([
    ['letters alone', 'abcdefabcdefabcdefabcdef', false],
    ['a long run of letters with a digit', 'abcdefabcdefabcdefabcde1', true],
    ['five digits in a row', '12345', false],
    ['six digits in a row', '123456', true],
    ['seven digits in all', '1-23-45-6-7', false],
    ['eight digits in all', '1-23-45-6-78', true],
    ['seven hex characters with a digit', 'abcd012', false],
    ['eight hex characters with a digit', 'abcd0123', true],
    ['hex letters without a digit', 'abcdefab', false],
    ['a base64 run of 15 with two digits', 'ghijklmnopqrs12', false],
    ['a base64 run of 16 with two digits', 'ghijklmnopqrst12', true],
    ['a base64 run of 16 with one digit', 'ghijklmnopqrstu1', false],
  ])('the thresholds of the runs: %s (%j) → %s', (_case, value, id) => {
    expect(hasIdLikeRun(value)).toBe(id);
  });

  it.each([
    ['a timestamp', '1730291234'],
    ['six digits after a word', 'item-123456'],
    ['digits split by separators', '0151 1234-5678'],
    ['a card number', '4111-1111-1111-1111'],
    ['a phone number', '+49-151-123-45-67'],
    ['an IBAN', 'DE89-3704-0044-0532-0130-00'],
    ['a short base64 session key', 'x7k2m9q4w8e1r5t3'],
    ['a base64 run with digit groups', 'aBc12dEf34GhIjKlMn'],
    ['an IP address', '203.0.113.42'],
    ['a hex hash split by a dot', 'a1b2c3d4e5f6a7b.8c9d0e1f2a3b4c5'],
    ['a hex hash split by a zero-width space', '9f86d081884c7d6\u200b59a2feaa0c55ad0'],
    ['fullwidth digits', '\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18'],
    ['Arabic-Indic digits', '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668'],
    ['a hex run with Arabic-Indic digits', 'a\u0661b\u0662c\u0663d\u0664e\u0665f\u0666a\u0667b\u0668'],
    ['a base64 token', 'QWxhZGRpbjpvcGVuIHNlc2Ft1'],
    ['a mixed-case run of letters without a digit', 'uHSRxnPAZmKQVeTWyDBcfGJL'],
    ['a base64 run of letters without a digit', 'dmlzaXRvckFsaWNldmlzaXRvckFsaWNl'],
    ['a token cut into short parts by dots', 'x9Kq.Lm3P.zR7t.Wb2N.vC5s.Df8G.hJ1k'],
    ['a token cut into short parts by colons', 'x9Kq:Lm3P:zR7t:Wb2N:vC5s:Df8G:hJ1k'],
    ...SPLIT_TOKENS.map((t): [string, string] => ['a base64-like token cut into short parts', t]),
    ['24 capitals without a digit', 'ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['a number split into groups of four and three', 'order-confirmation-1234-567'],
    ['words with three groups', 'page-12-item-345-ab-67'],
    ['words with four small numbers', 'ab-12-cd-34-ef-56-gh-7'],
    ['a number among words', '6428-session-user-consent-68-consent-cookie'],
    ['seven single digits', 'cart-1-2-3-4-5-6-7-x-y-z'],
    ['words and a group joined by slashes', 'abc/def/ghi/jkl/mno/p1'],
    ['words with two short groups', 'cookie-x9Kq-banner-Lm3P'],
    ['a word of two letters with a short group', 'Kd8sLq-consent-banner'],
  ])('%s is an ID-like run: %j', (_case, value) => {
    expect(hasIdLikeRun(value)).toBe(true);
  });

  it.each([
    ['CamelCase words with a short suffix', 'CybotCookiebotBannerCloseButtonE2E'],
    ['kebab-case words with a version', 'cookie-consent-banner-v2'],
    ['words with a short digit group', 'section_2_cookie_consent'],
    ['a short version', 'v1.2.3'],
    ['a short number', '15'],
    ['a short group with a digit first, then words', 'ch2-open-settings-btn'],
    ['short lowercase prefixes and a version', 'uc-cc-accept-all-button-v2'],
    ['CamelCase words with a version', 'ConsentButtonAcceptAllV2'],
    ['a long run of CamelCase words', 'CybotCookiebotDialogBodyButtonDecline'],
    ['a grid class', 'col-md-12'],
    ['a word of hex letters', 'deadbeefcafe'],
    ['a word with a digit', 'GA1'],
    ['a year', '2024'],
    ['a vendor prefix with a digit', 'qc-cmp2-ui'],
    [
      'a long run of CamelCase words with Level and Optin',
      'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    ],
    ['lowercase words without separators', 'cookieconsentacceptall'],
    ['a vendor handler name', 'onetrust-accept-btn-handler'],
    ['responsive variants with colons', 'lg:hover:bg-blue-500'],
    ['a fraction class', 'md:w-1/2'],
    ['words joined by a dot', 'cookie-consent.banner-wrapper'],
    ['a version and an index as key:value pairs', 'real_cookie_banner-v:3_blog:1_path:sim'],
    ['a Tailwind opacity', 'dark:hover:bg-gray-700/50'],
    ['capitals with a word of two letters', 'sp_choice_type_SAVE_AND_EXIT'],
    ['an event name with On', 'CookiebotOnConsentReady'],
    ['an event name in capitals', 'UC_UI_INITIALIZED_EVENT'],
    ['a word with an acronym at the start', 'GDPRConsentBannerWrapper'],
    ['a word with an acronym in the middle', 'CookieConsentOKButton'],
    ['a word with an acronym before the last word', 'CybotCookiebotDialogTabContentIABVendors'],
    ['words with In and Ok', 'cookieConsentOptInButton'],
    ['a German compound in capitals with a hyphen', 'COOKIE-EINSTELLUNGEN'],
    ['a category key in capitals', 'NECESSARY_AND_PREFERENCES'],
    ['a Tailwind named variant', 'group-hover/item:bg-gray-100'],
    ['a dotted version among words', 'cookie-law-v3.4.10-accept'],
    ['a region code behind a key:value pair', 'real_cookie_banner-v:3_blog:1_path:en_US'],
    ['an acronym of seven letters', 'reCAPTCHAConsentPlaceholder'],
    ['an acronym with a plural s', 'consentPurposeIDsList'],
    ['a single capital in front of a word', 'CookieBannerCloseXButton'],
    ['a vendor name with a short first word', 'McAfeeSecureTrustmark'],
  ])('counterexample: %s is no ID-like run: %j', (_case, value) => {
    expect(hasIdLikeRun(value)).toBe(false);
  });

  // The legal-text scrubber judges pieces of cookie values up to 512 characters with the same runs. The tag pattern runs
  // in the page and in Node on any tag name the page has, so it gets the adversarial inputs at full size.
  it.each([
    ['64 characters of hyphen groups', 'ab-'.repeat(21)],
    ['a hyphen run before a rejected character', `x${'-'.repeat(62)}!`],
    ['a long run of words and a plus', `${'Ab'.repeat(40)}1+`],
    ['a long run of groups and a plus', `${'a-1-'.repeat(20)}+`],
    ['510 letters and a digit', `${'abcdef'.repeat(85)}1`],
    ['510 letters, a digit and a hyphen', `${'Ab'.repeat(255)}1-`],
    ['hyphen groups with digits', 'a1-'.repeat(170)],
    ['64 KiB of hyphens before a rejected character', `x${'-'.repeat(65_534)}!`],
    ['64 KiB of dots and hyphens', `x-${'.-'.repeat(32_766)}!`],
    ['64 KiB of token separators', `${'aB3.'.repeat(16_384)}!`],
    ['64 KiB of capitals before a rejected character', `${'A'.repeat(65_536)}!`],
    ['a long run of capitals and a lowercase letter', `${'A'.repeat(500)}b`],
    ['a long run of capitalized pairs', `${'Ab'.repeat(255)}c`],
    ['64 KiB of capitalized pairs', 'Ab'.repeat(32_768)],
    ['510 capitals, a hyphen and a mixed-case tail', `${'AB'.repeat(255)}-aBcDeF`],
  ])('stays fast on %s', (_case, value) => {
    const tag = new RegExp(NAME_RULES.tag.source, NAME_RULES.tag.flags);
    const started = performance.now();
    tag.test(value);
    isTagName(value);
    isNameLike(value);
    hasIdLikeRun(value);
    isCategoryKey(value);
    isStoredName(value);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('a random token of 20 to 39 letters of both cases is a name in about one case of a hundred', () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let seed = 7;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    let names = 0;
    for (let k = 0; k < 40_000; k++) {
      const token = Array.from({ length: 20 + next(20) }, () => letters[next(letters.length)]).join('');
      if (!hasIdLikeRun(token)) names++;
    }
    expect(names).toBeLessThan(500);
  });

  it.each([
    ['64 KiB of short groups', 'a1 '.repeat(21_845)],
    ['64 KiB of groups that are no id', 'ab '.repeat(21_845)],
    ['64 KiB of groups between bars', 'a1 | '.repeat(13_107)],
    ['64 KiB of words and groups', 'Alle 2 '.repeat(9_362)],
    ['64 KiB of bracketed groups', '(a1) '.repeat(13_107)],
    ['one word of 64 KiB', 'a1'.repeat(32_768)],
    ['a run of dots', `x${'.'.repeat(65_534)}y`],
    ['a run of brackets', `x${'('.repeat(65_534)}y`],
    ['a run of commas', `x${','.repeat(65_534)}y`],
    ['a run of hyphens', `x${'-'.repeat(65_534)}y`],
    ['a run of bullets', `x${'\u2022'.repeat(65_534)}y`],
    ['a run of plus signs', `x${'+'.repeat(65_534)}y`],
  ])('redactCmpLabel stays fast on %s', (_case, label) => {
    const started = performance.now();
    redactCmpLabel(label);
    expect(performance.now() - started).toBeLessThan(500);
  });

  // The probe applies the rules it gets as data in the same steps (probe.ts); this is those steps over that data.
  it('the rules the in-page probe gets give the same answers', () => {
    const re = (p: PagePattern) => new RegExp(p.source, p.flags);
    const { idLike } = NAME_RULES;
    const idLikeInPage = (v: string): boolean => {
      const n = v.normalize('NFKC').replace(re(idLike.otherDigit), '0');
      const compact = n.replace(re(idLike.separator), '');
      if (idLike.compact.some((p) => re(p).test(compact)) || idLike.plain.some((p) => re(p).test(n)))
        return true;
      return (n.match(re(idLike.token)) ?? []).some((run) => {
        if (!/\d/.test(run))
          return !run
            .split(re(idLike.lettersSplit))
            .every((part) => part === '' || re(idLike.letters).test(part));
        const rest = run
          .replace(re(idLike.version), '-')
          .split(re(idLike.tokenSplit))
          .filter((part) => part !== '' && !re(idLike.word).test(part));
        if (rest.length <= 1) return !rest.every((part) => re(idLike.wordsWithGroup).test(part));
        return !(rest.length === 2 && rest.every((part) => re(idLike.smallNumber).test(part)));
      });
    };
    const inPage = (v: string): boolean => {
      const n = v.normalize('NFKC');
      return (
        [v, n].every(
          (s) =>
            s.length > 0 &&
            s.length <= NAME_RULES.maxLength &&
            re(NAME_RULES.chars).test(s) &&
            NAME_RULES.notName.every((p) => !re(p).test(s)),
        ) && !idLikeInPage(v)
      );
    };
    for (const v of [
      'uc-accept-all-button',
      'CybotCookiebotBannerCloseButtonE2E',
      'a b',
      'x@y',
      'x://y',
      'cid-9f86d081884c7d659a2feaa0c55ad015',
      '9f86d081884c7d6\u200b59a2feaa0c55ad0',
      'max\uff20mail.test',
      'ip-203.0.113.42',
      'zq7-\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668',
      'ConsentQWxhZGRpbjpvcGVu9',
      'a?b',
      '',
      'ch2-open-settings-btn',
      'section_2_cookie_consent',
      'cookie-x9Kq-banner-Lm3P',
      '//evil.test/u/alice.mueller',
      'mailto:alice.mueller',
      'md:w-1/2',
      'Xk2mQ9pLㅤw8eR1tZ3',
      'uid-4f3a9c1d2e7b',
      'x7k2m9q4w8e1r5t3',
      'item-123456',
      'uHSRxnPAZmKQVeTWyDBcfGJL',
      'ABCDEFGHIJKLMNOPQRSTUVWX',
      'sp_choice_type_SAVE_AND_EXIT',
      'CookiebotOnConsentReady',
      'GDPRConsentBannerWrapper',
      'dark:hover:bg-gray-700/50',
      'real_cookie_banner-v:3_blog:1_path:sim',
      'order-confirmation-1234-567',
      'cart-1-2-3-4-5-6-7-x-y-z',
      'abc/def/ghi/jkl/mno/p1',
      'group-hover/item:bg-gray-100',
      'gdpr-cookie-notice-v1.2.3',
      'real_cookie_banner-v:3_blog:100_path:sim',
      'real_cookie_banner-v:3_blog:1_path:en_US',
      'reCAPTCHAConsentPlaceholder',
      'consentPurposeIDsList',
      'CookieBannerCloseXButton',
      'McAfeeSecureTrustmark',
      'ab-v1.2.3-x9Kq-Lm3P',
      'a/b/c/d/e/f/g/h/i/j/k/1',
      'x9Kq.Lm3P.zR7t.Wb2N.vC5s.Df8G.hJ1k',
      ...SPLIT_TOKENS,
    ])
      expect(inPage(v), v).toBe(isNameLike(v));
  });
});

describe('isTagName', () => {
  it.each(['button', 'a', 'input', 'summary', 'uc-button', 'x-a.b', 'my-el_2', 'cookie-consent-banner-v2'])(
    '%s is a tag name',
    (tag) => {
      expect(isTagName(tag)).toBe(true);
    },
  );

  it.each([
    'x-a?token=zq7tok',
    'Button',
    '1a',
    'x-a@b',
    'x-9f86d081884c7d659a2feaa0c55ad015',
    'x-a1b2c3d4e5f6a7b.8c9d0e1f2a3b4c5',
    `x-${'a'.repeat(70)}`,
    'x-ab3d-9kx2-mq7z-p4wr-t8yn',
    `x${'-'.repeat(40)}!`,
    '',
  ])('%s is no tag name', (tag) => {
    expect(isTagName(tag)).toBe(false);
  });
});

describe('isAriaRole', () => {
  it.each(['button', 'link', 'checkbox', 'radio', 'generic', 'dialog', 'switch', 'presentation'])(
    '%s is a role',
    (role) => {
      expect(isAriaRole(role)).toBe(true);
    },
  );

  it.each(['?cid=zq7role', 'Button', 'btn', '', 'button link'])('%j is no role', (role) => {
    expect(isAriaRole(role)).toBe(false);
  });

  it('lists every role once, in lowercase', () => {
    expect(new Set(ARIA_ROLES).size).toBe(ARIA_ROLES.length);
    for (const r of ARIA_ROLES) expect(r).toMatch(/^[a-z]+$/);
  });
});

describe('isCategoryKey', () => {
  it.each([
    'statistics',
    'marketing',
    'external-media',
    'essenziell',
    'Präferenzen',
    'non-essential',
    'Functional Cookies',
    'v1.2',
    '2',
    '15',
  ])('%s is a category key', (key) => {
    expect(isCategoryKey(key)).toBe(true);
  });

  it.each([
    'uid=zq7borlabs@example.test',
    'cid=zq7uc&x=1',
    'zq7rcb?token=abc',
    'zq7cm=alice@example.test',
    'a/b',
    'a:b',
    '__proto__',
    '-x',
    '',
    'customCategory-123e4567-e89b-12d3-a456-426614174000',
    '9f86d081884c7d659a2feaa0c55ad015',
    'a'.repeat(65),
    'a1b2c3d4e5f6a7b.8c9d0e1f2a3b4c5',
    'zq7 0151 1234 5678',
    '\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18',
    '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668',
    'zq7\u200btoken',
    'Ab3d-9Kx2-mQ7z-P4wR-t8Yn',
    'x9Kq_Lm3P_zR7t_Wb2N_vC5s',
  ])('%j is no category key', (key) => {
    expect(isCategoryKey(key)).toBe(false);
  });
});

describe('isStoredName: cookie and storage names of a detection signal', () => {
  it.each([
    'CookieConsent',
    'cmplz_marketing',
    'cmplz_banner-status',
    'borlabs-cookie',
    'ccm_consent',
    'real_cookie_banner-v:3_blog:1_path:sim',
    'ucData',
    'uc_user_interaction',
    'OptanonAlertBoxClosed',
    'cookieconsent_status',
  ])('%s is a stored name', (name) => {
    expect(isStoredName(name)).toBe(true);
  });

  it.each([
    ['a name with its value', 'cmplz_ref=zq7COOKIEVALUE'],
    ['a UUID', 'cmplz_123e4567-e89b-12d3-a456-426614174000'],
    ['two cookies', 'cmplz_a; b'],
    ['a blank', 'cmplz_a b'],
    ['a quote', 'cmplz_"zq7"'],
    ['an address', 'cmplz_zq7@example.test'],
    ['percent-encoding', 'cmplz_zq7%40example.test'],
    ['a comma', 'cmplz_a,b'],
    ['a control character', 'cmplz_a\u0001'],
    ['a zero-width space', 'cmplz_a\u200bb'],
    ['a fullwidth equals sign', 'cmplz_ref\uff1dzq7'],
    ['nothing', ''],
    ['too long', `cmplz_${'a'.repeat(130)}`],
  ])('%s is no stored name: %j', (_case, name) => {
    expect(isStoredName(name)).toBe(false);
  });
});

describe('languagePrefix: the language of a lang attribute', () => {
  it.each([
    ['de', 'de'],
    ['de-DE', 'de-DE'],
    ['en-GB', 'en-GB'],
    ['DE', 'DE'],
    [' de-de ', 'de-de'],
    ['de_DE', 'de_DE'],
    ['zh-Hant-TW', 'zh-Hant-TW'],
    ['es-419', 'es-419'],
    // Variants, extensions and private use are cut off: the start is the language.
    ['de-CH-1996', 'de-CH'],
    ['de-4f3a9c1d-2e7b8a9f-0c1d2e3f', 'de'],
    ['en-x-zq8private', 'en'],
  ])('%j → %j', (value, tag) => {
    expect(languagePrefix(value)).toBe(tag);
  });

  it.each([
    'de https://example.test/?sid=zq8SECRET',
    'x alice@example.com',
    'de?sid=zq8',
    'deutsch',
    '',
    'd',
    'de-DE-x-very-long-private-use-subtags-zq8',
  ])('%j is no language', (value) => {
    expect(languagePrefix(value)).toBeNull();
  });

  it('a value that is no string is no language', () => {
    expect(languagePrefix(null)).toBeNull();
    expect(languagePrefix(42)).toBeNull();
    expect(languagePrefix({ toString: () => 'de' })).toBeNull();
  });
});

describe('redactCmpLabel: identifiers in the label of a CMP control', () => {
  it.each([
    ['a hex word', 'Accept 4f3a9c1d2e7b4a9f', 'Accept [redacted]'],
    ['a base64 word without a digit', 'OK uHSRxnPAZmKQVeTWyDBcfGJL', 'OK [redacted]'],
    ['hex groups joined by blanks', 'Accept 4f3a 9c1d 2e7b 4a9f', 'Accept [redacted]'],
    ['digit groups joined by blanks', 'Einwilligungs-ID 123 456 789', 'Einwilligungs-ID [redacted]'],
    [
      'a UUID cut into groups after a colon',
      'Consent ID: 6a1b2c3d 4e5f 6a7b 8c9d 0e1f2a3b4c5d',
      'Consent ID: [redacted]',
    ],
    ['a word and a digit group after it', 'Fortfahren 4f3a9c1d2e7b4a9f 12', 'Fortfahren [redacted]'],
    ['hex groups in brackets', 'Accept (4f3a 9c1d 2e7b 4a9f)', 'Accept [redacted]'],
    ['hex groups behind commas', 'Accept 4f3a, 9c1d, 2e7b, 4a9f', 'Accept [redacted]'],
    ['hex groups between bars', 'Accept 4f3a | 9c1d | 2e7b | 4a9f', 'Accept [redacted]'],
    ['hex groups with hyphenated pairs', 'ID: 4f3a-9c1d 2e7b-4a9f', 'ID: [redacted]'],
    ['digit groups behind semicolons', 'Einwilligungs-ID 123; 456; 789', 'Einwilligungs-ID [redacted]'],
    ['hex groups joined by commas and semicolons', 'Accept 4f3a,9c1d 2e7b;4a9f', 'Accept [redacted]'],
    ['hex groups joined by spaced hyphens', 'Accept 4f3a - 9c1d - 2e7b - 4a9f', 'Accept [redacted]'],
    ['hex groups joined by colons', 'Accept 4f3a: 9c1d: 2e7b: 4a9f', 'Accept [redacted]'],
    ['hex groups joined by slashes', 'Accept 4f3a / 9c1d / 2e7b / 4a9f', 'Accept [redacted]'],
    ['hex groups joined by bullets', 'Accept 4f3a \u2022 9c1d \u2022 2e7b \u2022 4a9f', 'Accept [redacted]'],
    ['hex groups in curly braces', 'Accept {4f3a 9c1d 2e7b 4a9f}', 'Accept [redacted]'],
    [
      'fullwidth hex groups',
      'Accept \uff14\uff46\uff13\uff41 \uff19\uff43\uff11\uff44 \uff12\uff45\uff17\uff42 \uff14\uff41\uff19\uff46',
      'Accept [redacted]',
    ],
    ['hex groups with zero-width spaces', 'Accept 4f3a\u200b 9c1d\u200b 2e7b 4a9f', 'Accept [redacted]'],
    ['hex groups joined by plus signs', 'Accept 4f3a + 9c1d + 2e7b + 4a9f', 'Accept [redacted]'],
    ['hex groups joined by underscores', 'Accept 4f3a _ 9c1d _ 2e7b _ 4a9f', 'Accept [redacted]'],
    ['hex groups joined by tildes', 'Accept 4f3a ~ 9c1d ~ 2e7b ~ 4a9f', 'Accept [redacted]'],
    [
      'hex groups joined by multiplication signs',
      'Accept 4f3a \u00d7 9c1d \u00d7 2e7b \u00d7 4a9f',
      'Accept [redacted]',
    ],
    ['hex groups joined by asterisks', 'Accept 4f3a * 9c1d * 2e7b * 4a9f', 'Accept [redacted]'],
    ['hex groups joined by equals signs', 'Accept 4f3a = 9c1d = 2e7b', 'Accept [redacted]'],
    [
      'hex groups joined by katakana dots',
      'Accept 4f3a \u30fb 9c1d \u30fb 2e7b \u30fb 4a9f',
      'Accept [redacted]',
    ],
    [
      'hex groups joined by bullet operators',
      'Accept 4f3a \u2219 9c1d \u2219 2e7b \u2219 4a9f',
      'Accept [redacted]',
    ],
    ['hex groups in corner brackets', 'Accept 4f3a \u300c9c1d\u300d 2e7b', 'Accept [redacted]'],
    ['counterexample: an accept label', 'Alle akzeptieren', 'Alle akzeptieren'],
    ['counterexample: a count in brackets', 'Alle akzeptieren (2)', 'Alle akzeptieren (2)'],
    ['counterexample: a step', 'Schritt 1 von 3', 'Schritt 1 von 3'],
    ['counterexample: a bar between words', 'Ablehnen | Einstellungen', 'Ablehnen | Einstellungen'],
    ['counterexample: short numbers between bars', 'Seite 1 | 2', 'Seite 1 | 2'],
    ['counterexample: a vendor name with acronyms', 'Google-AdSense-Werbung', 'Google-AdSense-Werbung'],
    [
      'counterexample: a vendor name with an acronym',
      'Google-reCAPTCHA-zulassen',
      'Google-reCAPTCHA-zulassen',
    ],
    ['counterexample: a reject label', 'Nur notwendige Cookies', 'Nur notwendige Cookies'],
    ['counterexample: a count', 'Partner (12)', 'Partner (12)'],
    ['counterexample: words made of hex letters', 'Add a bed', 'Add a bed'],
    ['counterexample: a short number', 'Alle 2 Cookies', 'Alle 2 Cookies'],
    ['counterexample: a settings word in capitals', 'DATENSCHUTZEINSTELLUNGEN', 'DATENSCHUTZEINSTELLUNGEN'],
    [
      'counterexample: a settings label in capitals',
      'INDIVIDUELLE DATENSCHUTZEINSTELLUNGEN',
      'INDIVIDUELLE DATENSCHUTZEINSTELLUNGEN',
    ],
    ['counterexample: a footer link in capitals', 'DATENSCHUTZERKLAERUNG', 'DATENSCHUTZERKLAERUNG'],
    ['counterexample: an Impressum link in capitals', 'ANBIETERKENNZEICHNUNG', 'ANBIETERKENNZEICHNUNG'],
    ['counterexample: a reject label with hyphens', 'NUR-NOTWENDIGE-COOKIES', 'NUR-NOTWENDIGE-COOKIES'],
    ['counterexample: an accept label with hyphens', 'ALLE-COOKIES-AKZEPTIEREN', 'ALLE-COOKIES-AKZEPTIEREN'],
  ])('%s', (_case, label, expected) => {
    expect(redactCmpLabel(label)).toBe(expected);
  });

  it('keeps every phrase of the lexicon, also in capitals and joined by hyphens or underscores', () => {
    const lexicon = loadLexicon();
    const phrases = [
      ...lexicon.accept,
      ...lexicon.reject,
      ...lexicon.settings,
      ...lexicon.save,
      ...lexicon.close,
      ...lexicon.later,
      ...lexicon.hide,
    ].map((p) => p.replace(/^\*/, ''));
    expect(phrases.length).toBeGreaterThan(200);
    const changed = phrases.flatMap((p) =>
      [p, p.toUpperCase(), p.replaceAll(' ', '-'), p.toUpperCase().replaceAll(' ', '_')].filter(
        (v) => redactCmpLabel(v) !== v,
      ),
    );
    expect(changed).toEqual([]);
  });
});

describe('storedKey: the name of a storage key, an IndexedDB database or a cookie', () => {
  it.each([
    ['a UUID', 'cmplz_123e4567-e89b-12d3-a456-426614174000', 'cmplz_[redacted]'],
    ['a UUID with underscores', 'session_123e4567_e89b_12d3_a456_426614174000', 'session_[redacted]'],
    ['a UUID without separators', 'uid_123e4567e89b12d3a456426614174000', 'uid_[redacted]'],
    [
      'a visitor id inside a key',
      'optimizely_data$$oeu1612345678901r0.12345678901234567$$12345678$$session_state',
      'optimizely_data$$oeu[redacted].[redacted]$$12345678$$session_state',
    ],
    [
      'a visitor id glued to a word',
      'optimizely_data$$oeu1612345678901r0$$session_state',
      'optimizely_data$$oeu[redacted]$$session_state',
    ],
    ['a hex id', 'rc::4f3a9c1d2e7b4a9f4f3a9c1d', 'rc::[redacted]'],
    ['a hex id after a prefix', 'amplitude_unsent_4f3a9c1d2e7b4a9f', 'amplitude_unsent_[redacted]'],
    ['a hex id in groups', 'uid_4f3a-9c1d-2e7b-4a9f', 'uid_[redacted]'],
    ['a hex id in groups joined by dots', 'uid_4f3a.9c1d.2e7b.4a9f', 'uid_[redacted]'],
    ['ten digits', 'user_1234567890', 'user_[redacted]'],
    ['ten digits in the second part of a short hex run', 'a_b1234567890c', 'a_[redacted]'],
    ['digits in groups', 'GA1.2.123456789.1612345678', 'GA1.[redacted]'],
    ['a base64 id', 'token_Xk2mQ9pLw8eR1tZ3aB4cD5', 'token_[redacted]'],
    [
      'a base64 id glued to a word',
      'cookieConsentBanner2mQ9pLw8eR1tZ3aB4cD5',
      'cookieConsentBanner[redacted]',
    ],
    ['a base64 id glued to random letters and a word', 'hjSessionSampleXk2mQ9pLw8eR1tZ3aB4cD5', '[redacted]'],
    ['a base64 id that starts with random letters', 'ab.BrDicpsIkHF19Ag6fikkr3', 'ab.[redacted]'],
    ['a base64 id with a random prefix and a short rest', 'ab.CZqjqLg7yReiYWoqc2bks7', 'ab.[redacted]'],
    [
      'a UUID-length hex id glued to a word',
      '_hjIncludedInSessionSample4f3a9c1d2e7b4a9f4f3a9c1d2e7b4a9f',
      '_hjIncludedInSessionSample[redacted]',
    ],
    [
      'a hex id of 32 glued to capitals',
      'ASPSESSIONID4f3a9c1d2e7b4a9f4f3a9c1d2e7b4a9f',
      'ASPSESSIONID[redacted]',
    ],
    ['a hex run longer than a UUID', `x_${'4f3a9c1d2e7b'.repeat(4).slice(0, 44)}`, 'x_[redacted]'],
    [
      'a nanoid with an underscore and a hyphen',
      'chat_session_V1StGXR8_Z5jdHi6B-myT',
      'chat_session_[redacted]',
    ],
    ['a short letter part inside an encoded run', 'chat_a_V1StGXR8_Z5jdHi6B-myT', 'chat_[redacted]'],
    ['a hex id followed by a letter', 'sess_4f3a9c1d2e7b4a9f4f3a9c1dz', 'sess_[redacted]z'],
    ['a hex id followed by a word', '4f3a9c1d2e7b4a9fsession', '[redacted]session'],
    ['a hex id followed by capitals', 'LogsDatabaseV2:4f3a9c1d2e7b4a9fLL||', 'LogsDatabaseV2:[redacted]LL||'],
    ['a hex id of 40 followed by a letter', `k_${'4f3a9c1d2e'.repeat(4)}g`, 'k_[redacted]g'],
    ['a pool name with numbers and words', 'BIGipServerTypo3Live443', 'BIGipServerTypo3Live443'],
    ['a pool name with a number and a word', 'BIGipServerApp01Prod443', 'BIGipServerApp01Prod443'],
    [
      'a pool name with a year and capitals',
      'BIGipServerExchange2016OWA443',
      'BIGipServerExchange2016OWA443',
    ],
    ['a pool name with capitals', 'BIGipServerWWW2Pool443', 'BIGipServerWWW2Pool443'],
    ['a pool name with a short number', 'BIGipServerIIS10Web443', 'BIGipServerIIS10Web443'],
    ['a pool name with a digit', 'BIGipServerShop1Pool443', 'BIGipServerShop1Pool443'],
    [
      'counterexample: a session cookie of a vendor',
      'ttcsid_C4JBQ7BC77U5S6VOPGOG',
      'ttcsid_C4JBQ7BC77U5S6VOPGOG',
    ],
    ['an address with a zero-width space after the @', 'alice@\u200bexample.test', '[redacted]@example.test'],
    ['an address literal', 'alice@[192.168.0.1]', '[redacted]@[192.168.0.1]'],
    [
      'an address and a query',
      'alice@example.test?sid=4f3a9c1d2e7b4a9f',
      '[redacted]@example.test?[redacted]',
    ],
    ['a percent-encoded address', 'alice%40example.test', '[redacted]@example.test'],
    [
      'an address encoded twice between words',
      'user:alice%2540example.test:cart',
      'user:[redacted]@example.test:cart',
    ],
    ['a fullwidth at sign', 'alice＠example.test', '[redacted]@example.test'],
    ['an obfuscated address', 'alice(at)example.test', '[redacted]@example.test'],
    ['a local part without a domain', 'user:alice@intranet', 'user:[redacted]@intranet'],
    ['an obfuscated local part without a domain', 'alice(at)intranet', '[redacted]@intranet'],
    ['counterexample: a vendor prefix and a short id', 'ucData_hxnJq0hMNeT4UY', 'ucData_hxnJq0hMNeT4UY'],
    [
      'counterexample: a vendor prefix and another short id',
      'ucData_wI7DBn7t2gR3Tx',
      'ucData_wI7DBn7t2gR3Tx',
    ],
    [
      'counterexample: a vendor prefix with a leading underscore',
      '_hjSession_hxnJq0hMNeT4UY',
      '_hjSession_hxnJq0hMNeT4UY',
    ],
    ['a vendor prefix and a long base64 id', 'ucData_Xk2mQ9pLw8eR1tZ3aB4cD5vN', 'ucData_[redacted]'],
    ['ranges that share parts, in underscores', 'Xk9QzTw_QwErTyUiOp4f3a9c1d_2e7b4a9f_12345678', '[redacted]'],
    [
      'ranges that share parts, in hyphens and a dot',
      'Xk9QzTw-AbcdefXyz4f3a9c1d-2e7b4a9f.12345678',
      '[redacted]',
    ],
    ['counterexample: a literal key', '_gcl_ls', '_gcl_ls'],
    ['counterexample: a hyphen between words', 'chat-session-mobile-banner', 'chat-session-mobile-banner'],
    ['counterexample: a key with capitals', 'ytidb::LAST_RESULT_ENTRY_KEY', 'ytidb::LAST_RESULT_ENTRY_KEY'],
    ['counterexample: a version in a key', 'pkg@3.7.1', 'pkg@3.7.1'],
    [
      'counterexample: a host in a key',
      'firebase:host:proj.firebaseio.com',
      'firebase:host:proj.firebaseio.com',
    ],
    ['counterexample: a short number', 'wp-settings-time-1', 'wp-settings-time-1'],
    ['counterexample: a version', 'pkg_v1.2.3', 'pkg_v1.2.3'],
    ['counterexample: five digits', 'ajs_user_id_12345', 'ajs_user_id_12345'],
    ['counterexample: six digits', '_hjSessionUser_123456', '_hjSessionUser_123456'],
    ['counterexample: seven digits', '_hjSessionUser_1234567', '_hjSessionUser_1234567'],
    ['counterexample: a site id of F5', 'TS01dc4fc6', 'TS01dc4fc6'],
    ['counterexample: a site id of F5 in capitals', 'TS0150a1d4', 'TS0150a1d4'],
    ['counterexample: a site id of F5 with a suffix', 'TS01d8a15b_77', 'TS01d8a15b_77'],
    ['counterexample: a consent id of seven digits', '__cmpconsentx47472', '__cmpconsentx47472'],
    [
      'counterexample: a consent id with a domain',
      '__cmpconsentx12345_.example.de',
      '__cmpconsentx12345_.example.de',
    ],
    ['counterexample: a property id of Google', '_ga_ABCD1234EF', '_ga_ABCD1234EF'],
    ['counterexample: ids of Incapsula', 'incap_ses_123_456789', 'incap_ses_123_456789'],
    ['counterexample: a short hex id', 'amplitude_unsent_4f3a9c1d', 'amplitude_unsent_4f3a9c1d'],
    ['counterexample: a key with a colon', 'rc::a', 'rc::a'],
    [
      'counterexample: a key with colons and a locale',
      'real_cookie_banner-v:3_blog:1_path:en_US',
      'real_cookie_banner-v:3_blog:1_path:en_US',
    ],
    [
      'counterexample: a camelCase key with a year',
      'cookieConsentBanner2024Accept',
      'cookieConsentBanner2024Accept',
    ],
    ['counterexample: words made of hex letters', 'add-bad-face-dead-beef', 'add-bad-face-dead-beef'],
  ])('%s', (_case, key, expected) => {
    expect(storedKey(key)).toBe(expected);
  });

  it.each([
    'ucData_hxnJq0hMNeT4UY',
    'Xk9QzTw_QwErTyUiOp4f3a9c1d_2e7b4a9f_12345678',
    'Xk9QzTw-AbcdefXyz4f3a9c1d-2e7b4a9f.12345678',
  ])('a cookie name is stored by the same rule: %s', (name) => {
    expect(storedCookieName(name)).toBe(storedKey(name));
  });

  it('a hex run longer than 32 loses its tail with the rest of the run', () => {
    expect(storedKey(`sha1_${'4f3a9c1d2e'.repeat(4)}`)).not.toContain('9c1d');
  });

  it('random base64 ids of the masked shape are never kept whole and rarely in part', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let seed = 20260101;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const whole: string[] = [];
    let ids = 0;
    let partly = 0;
    for (const length of [20, 22, 27, 32]) {
      for (let k = 0; k < 400; k++) {
        const id = Array.from({ length }, () => alphabet[next(alphabet.length)]!).join('');
        if ((id.match(/\d/g) ?? []).length < 2 || !/[a-z]/.test(id) || !/[A-Z]/.test(id)) continue;
        const stored = storedKey(`ab.${id}`);
        ids++;
        if (stored.includes(id.slice(3))) whole.push(`${id} -> ${stored}`);
        else if (stored.includes(id.slice(0, 9))) partly++;
      }
    }
    expect(whole).toEqual([]);
    expect(partly / ids).toBeLessThan(0.05);
  });

  it('random nanoids with hyphens and underscores are rarely kept whole', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let seed = 20261108;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    let ids = 0;
    const whole: string[] = [];
    let doubledKept = 0;
    let collapsedKept = 0;
    for (const length of [21, 24, 32]) {
      for (let k = 0; k < 1500; k++) {
        const id = Array.from({ length }, () => alphabet[next(alphabet.length)]!).join('');
        if ((id.match(/\d/g) ?? []).length < 2 || !/[a-z]/.test(id) || !/[A-Z]/.test(id)) continue;
        ids++;
        const stored = storedKey(`chat_${id}`);
        if (stored.includes(id.slice(3, 15))) whole.push(`${id} -> ${stored}`);
        const collapsed = id.replace(/[-_]{2,}/g, (run) => run[0]!);
        if (collapsed !== id) {
          if (stored.includes(id)) doubledKept++;
          if (storedKey(`chat_${collapsed}`).includes(collapsed)) collapsedKept++;
        }
      }
    }
    expect(doubledKept).toBeLessThanOrEqual(collapsedKept);
    expect(ids).toBeGreaterThan(2000);
    expect(whole.length / ids).toBeLessThan(0.04);
  });

  it('random hex ids of 16 to 40 characters are masked when a letter follows them', () => {
    const hex = '0123456789abcdef';
    let seed = 99;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const kept: string[] = [];
    for (let k = 0; k < 1000; k++) {
      const id = Array.from({ length: 16 + next(25) }, () => hex[next(16)]!).join('');
      if (!/\d/.test(id) || !/[a-f]/.test(id)) continue;
      const tail = 'ghijklmnopqrstuvwxyz'[next(20)]!;
      for (const key of [`sess_${id}${tail}`, `${id}${tail}x`])
        if (storedKey(key).includes(id.slice(0, 12))) kept.push(key);
    }
    expect(kept).toEqual([]);
  });

  it('keeps an encoded @ in a name that has no domain after it', () => {
    expect(storedKey('AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg')).toBe(
      'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
    );
    expect(storedKey('AMCV_4f3a9c1d2e7b4a9f4f3a9c1d%40AdobeOrg')).toBe('AMCV_[redacted]%40AdobeOrg');
  });

  it('a query is cut and the stored form does not change when it is stored again', () => {
    const once = storedKey('cart?sid=4f3a9c1d2e7b4a9f&x=1');
    expect(once).toBe('cart?[redacted]');
    expect(storedKey(once)).toBe(once);
    const address = storedKey('user:alice@intranet:4f3a-9c1d-2e7b-4a9f');
    expect(storedKey(address)).toBe(address);
  });

  it('an address that the page cut in the middle loses its local part', () => {
    expect(storedKey(`${'x'.repeat(390)}alice@exa`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(380)}alice@example.test`.slice(0, 400))).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(395)}alice@`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(390)}alice%40exa`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(390)}alice(at)ex`)).not.toContain('alice');
  });

  it('an address that starts before the limit of 200 characters is masked whole', () => {
    expect(storedKey(`${'x'.repeat(190)}alice@example.test`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(190)}alice%40example.test`)).not.toContain('alice');
  });

  it('a name that holds no address keeps its text up to the limit of 200 characters', () => {
    expect(storedKey('k'.repeat(300))).toBe('k'.repeat(200));
  });

  it('stays fast on names made to be slow', () => {
    const started = performance.now();
    for (const name of [
      'a-'.repeat(200),
      `${'ab1'.repeat(133)}!`,
      'a@'.repeat(200),
      'a(at)'.repeat(80),
      '1.'.repeat(200),
      `${'Aa1'.repeat(133)}+`,
    ])
      storedKey(name);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('stored names protect encoded identifiers and addresses', () => {
  it.each([
    ['glued hex', 'sessiona1b2c3d4e5f60718', 'session[redacted]'],
    ['double underscore', 'V1StGXR8__Z5jdHi6B-myT', '[redacted]'],
    ['double underscore in hex', '4f3a__9c1d_2e7b_4a9f', '[redacted]'],
    ['double hyphen', 'V1StGXR8--Z5jdHi6B-myT', '[redacted]'],
    ['mixed separators', 'V1StGXR8-_Z5jdHi6B-myT', '[redacted]'],
    ['short F5 name', 'TS01dc4fc6', 'TS01dc4fc6'],
    ['short vendor id', 'amplitude_unsent_4f3a9c1d', 'amplitude_unsent_4f3a9c1d'],
  ])('%s', (_label, input, expected) => {
    expect(storedKey(input)).toBe(expected);
  });
  it.each([
    ['fullwidth at', 'alice%EF%BC%A0example.test'],
    ['compatibility at', 'alice%EF%B9%ABexample.test'],
  ])('%s', (_label, input) => {
    expect(storedKey(input)).not.toContain('alice');
    expect(storedCookieName(input)).toBe('[redacted]');
    expect(storedHeaderName(input)).toBe('[redacted]');
  });
});

describe('stored name boundary cases', () => {
  it.each([
    ['1234567890:V1StGXR8_Z5jdHi6B-myT', '[redacted]:[redacted]'],
    ['V1StGXR8_Z5jdHi6B-myT:1234567890', '[redacted]:[redacted]'],
    ['sessiona1b2c3d4e5f60718x', 'session[redacted]x'],
    ['sessiona1b2c3d4e5f60718_x', 'session[redacted]_x'],
  ])('masks %s', (input, expected) => {
    expect(storedKey(input)).toBe(expected);
    expect(storedCookieName(input)).toBe(expected);
  });
  it.each(['__', '--', '-_'])('counts the full separator %s', (separator) => {
    for (const suffix of ['', 'a', 'ab']) {
      const input = `V1StGXR8${separator}Z5jdHi6B-${suffix}`;
      expect(storedKey(input), input).toBe(input.length < 20 ? input : '[redacted]');
    }
  });
  it.each(['x-alice%40mail.test', 'alice%40intranet'])('masks encoded header marker %s', (input) => {
    expect(storedHeaderName(input)).toBe('[redacted]');
  });
});
