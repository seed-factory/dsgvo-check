import { describe, expect, it } from 'vitest';
import { loadLexicon } from '../../../../src/cmp/lexicon-file.ts';
import {
  isAriaRole,
  isCategoryKey,
  isStoredName,
  isTagName,
  languagePrefix,
  redactCmpLabel,
} from '../../../../src/core/redaction/page-names.ts';

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
