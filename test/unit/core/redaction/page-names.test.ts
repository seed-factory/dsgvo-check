import { describe, expect, it } from 'vitest';
import { loadDataDir } from '../../../../src/core/data/load.ts';
import {
  hasIdLikeRun,
  isNameLike,
  NAME_MAX_LENGTH,
  redactCmpLabel,
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
    'uc-accept-all-button',
    'refuse-btn',
    'Akzeptieren',
    'accept',
    ':r1:',
    'w-1/2',
    'hover:bg-blue-500',
    'Präferenzen',
    'btn_2024',
    'cookie-consent-banner-v2',
    'ConsentButtonAcceptAllV2',
    'ｃｍｐ-accept',
    'v1.2.3',
    'grid-cols-12',
    'section_2_cookie_consent',
    'uc-accept-all-button-v2',
    'uc-deny-all-button',
    'data-borlabs-cookie-actions',
    'cookie-einstellungen',
    'md:w-1/2',
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
    ['a hex hash split by a zero-width space', '9f86d081884c7d6\u200b59a2feaa0c55ad0'],
    ['fullwidth digits', '\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18'],
    ['Arabic-Indic digits', '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668'],
    ['a hex run with Arabic-Indic digits', 'a\u0661b\u0662c\u0663d\u0664e\u0665f\u0666a\u0667b\u0668'],
    ['a base64 token', 'QWxhZGRpbjpvcGVuIHNlc2Ft1'],
    ['a token cut into short parts by colons', 'x9Kq:Lm3P:zR7t:Wb2N:vC5s:Df8G:hJ1k'],
    ['words with two short groups', 'cookie-x9Kq-banner-Lm3P'],
    ['a word of two letters with a short group', 'Kd8sLq-consent-banner'],
  ])('%s is an ID-like run: %j', (_case, value) => {
    expect(hasIdLikeRun(value)).toBe(true);
  });

  it.each([
    ['a short number', '15'],
    ['short lowercase prefixes and a version', 'uc-cc-accept-all-button-v2'],
    ['a grid class', 'col-md-12'],
    ['a word of hex letters', 'deadbeefcafe'],
    ['a word with a digit', 'GA1'],
    ['a year', '2024'],
    ['a vendor prefix with a digit', 'qc-cmp2-ui'],
  ])('counterexample: %s is no ID-like run: %j', (_case, value) => {
    expect(hasIdLikeRun(value)).toBe(false);
  });

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
  ])('detects ID-like runs within the budget: %s', (_case, value) => {
    const started = performance.now();
    hasIdLikeRun(value);
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
});
