/**
 * Short values taken from a page: an id, class token or attribute value a stored selector is built from, a tag name, a
 * role, a consent category key, a cookie or storage name of a detection signal, a language tag. What a vendor or a site
 * names its controls stays a name; query or address syntax, a URL, whitespace, invisible and look-alike characters and
 * runs that look like an ID or a token do not. A language tag keeps its language, script and region.
 */
import { describe, expect, it } from 'vitest';
import { loadDataDir } from '../../../../src/core/data/load.ts';
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
    ...SPLIT_TOKENS.map((t): [string, string] => ['a base64-like token cut into short parts', t]),
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
  ])('counterexample: %s is no ID-like run: %j', (_case, value) => {
    expect(hasIdLikeRun(value)).toBe(false);
  });

  // The legal-text scrubber judges pieces of cookie values up to 512 characters with the same runs.
  it('stays fast on a long run that almost reads as words or as an id', () => {
    const started = Date.now();
    for (const v of [
      'ab-'.repeat(30),
      `${'Ab'.repeat(40)}1+`,
      `${'a-1-'.repeat(20)}+`,
      `${'abcdef'.repeat(85)}1`,
      `${'Ab'.repeat(255)}1-`,
      `${'a1-'.repeat(170)}`,
    ]) {
      isNameLike(v);
      hasIdLikeRun(v);
      isCategoryKey(v);
    }
    expect(Date.now() - started).toBeLessThan(200);
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
        const rest = run.split(re(idLike.tokenSplit)).filter((part) => !re(idLike.word).test(part));
        return rest.length > 1 || !rest.every((part) => re(idLike.wordsWithGroup).test(part));
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
  ])('%s is a stored name', (name) => {
    expect(isStoredName(name)).toBe(true);
  });

  it.each([
    ['a name with its value', 'cmplz_ref=zq7COOKIEVALUE'],
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
