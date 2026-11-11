/**
 * `sanitizeUrl` keeps what a check needs and removes what identifies a person: query values outside the allowlist,
 * `mailto:` recipients, credentials and the fragment. Paths, opaque URLs and unparsable URLs: redaction-*.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { QUERY_ALLOWLIST, sanitizeUrl } from '../../../../src/core/url/url.ts';
import { expectLinearGrowth } from '../../../utils/scaling.ts';
import { expectStable, M, MARK } from './redaction-helpers.ts';

const SHOP = 'https://shop.example.test';

describe('the family value of a font URL keeps font numbers only', () => {
  const FONTS = 'https://fonts.googleapis.com/css2';
  it.each([
    ['axes with ranges', 'Roboto+Flex:opsz,wght@8..144,100..1000'],
    ['tuples', 'Open+Sans:ital,wght@0,400;1,700'],
    ['one family with an axis and a weight', 'Roboto:wght@400'],
    ['a file name with a scale', 'Roboto@2x.png'],
  ])('keeps %s', (_case, family) => {
    const out = sanitizeUrl(`${FONTS}?family=${family}`);
    expect(decodeURIComponent(out)).toBe(`${FONTS}?family=${family}`);
  });

  it.each([
    ['a card-like number', '1234,5678,9012,3456'],
    ['a phone-like number', '49.30.1234.5678'],
    ['numbers above 1000 after a colon', 'Roboto:1234,5678,9012,3456'],
  ])('removes %s', (_case, family) => {
    expect(sanitizeUrl(`${FONTS}?family=${family}`)).toBe(`${FONTS}?family=${REDACTED}`);
  });
});

describe('the family value of a font URL is read in linear time', () => {
  it.each([
    ['letters of two cases', 'aB'],
    ['letters and commas', 'a,'],
    ['axis tags without a tuple', 'wght,ital'],
    ['tuples', 'ital,wght@0,400;'],
  ])('%s', (_case, unit) => {
    const url = (size: number) =>
      `https://fonts.googleapis.com/css2?family=${unit.repeat(Math.ceil(size / unit.length))}`;
    expectLinearGrowth(
      () => sanitizeUrl(url(8 * 1024)),
      () => sanitizeUrl(url(64 * 1024)),
    );
  });
});

describe('allowlisted query values keep no address marker', () => {
  it.each([
    ['https://www.google.com/recaptcha/api.js?hl=alice@intranet', 'hl'],
    ['https://x.test/p?hl=alice(at)intranet', 'hl'],
    ['https://x.test/p?display=alice@corp', 'display'],
    ['https://maps.googleapis.com/maps/api/js?libraries=alice(at)intranet', 'libraries'],
    ['https://fonts.googleapis.com/css2?family=Roboto@alice', 'family'],
    ['https://fonts.googleapis.com/css2?family=alice@intranet', 'family'],
    ['https://fonts.googleapis.com/css2?family=Roboto:alice@intranet', 'family'],
  ])('%s', (url, key) => {
    expect(sanitizeUrl(url)).toContain(`${key}=${REDACTED}`);
    expect(sanitizeUrl(url)).not.toContain('alice');
  });
});

describe('ordinary URLs keep their meaning', () => {
  it.each([
    [
      'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
      'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
    ],
    [
      'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap',
      'https://fonts.googleapis.com/css2?family=Open+Sans%3Awght%40400%3B700&display=swap',
    ],
    [
      'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
      'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
    ],
    [
      'https://cdn.jsdelivr.example/npm/jquery@3.7.1/dist/jquery.min.js',
      'https://cdn.jsdelivr.example/npm/jquery@3.7.1/dist/jquery.min.js',
    ],
    ['https://unpkg.com/@scope/pkg@1.2.3/dist/x.js', 'https://unpkg.com/@scope/pkg@1.2.3/dist/x.js'],
    ['https://cdn.example.test/img/logo@2x.png', 'https://cdn.example.test/img/logo@2x.png'],
    ['https://www.example.test/img/logo@2x.png', 'https://www.example.test/img/logo@2x.png'],
    ['https://www.example.test/', 'https://www.example.test/'],
    ['https://www.example.test/a/b/c.html', 'https://www.example.test/a/b/c.html'],
    [
      'https://de.wikipedia.example/wiki/Kategorie:Datenschutz',
      'https://de.wikipedia.example/wiki/Kategorie:Datenschutz',
    ],
    ['https://www.example.test/a;b/c', 'https://www.example.test/a;b/c'],
    ['https://www.example.test/%C3%BCber-uns/', 'https://www.example.test/%C3%BCber-uns/'],
    ['https://medium.example.test/@autor/beitrag-123', 'https://medium.example.test/@autor/beitrag-123'],
    [`${SHOP}/de/produkt/%C3%9Cbersicht%20Preise`, `${SHOP}/de/produkt/%C3%9Cbersicht%20Preise`],
    [`${SHOP}/search?q=m%C3%BCller&page=2`, `${SHOP}/search?q=${REDACTED}&page=${REDACTED}`],
    [`${SHOP}/a/b/c.html#section`, `${SHOP}/a/b/c.html`],
    ['https://social.example.test/@username/post/42', 'https://social.example.test/@username/post/42'],
    [`${SHOP}/p%C3%A4ge/100%25`, `${SHOP}/p%C3%A4ge/100%25`],
    [`${SHOP}/%7Euser/`, `${SHOP}/%7Euser/`],
    [`${SHOP}/files/%E4%F6%FC`, `${SHOP}/files/%E4%F6%FC`],
    [`${SHOP}/de%2Fen/seite`, `${SHOP}/de%2Fen/seite`],
    [`${SHOP}/news/2026%2F10%2F31`, `${SHOP}/news/2026%2F10%2F31`],
    [`${SHOP}/c/a%2540b`, `${SHOP}/c/a%2540b`],
    [`${SHOP}/kontakt@2x`, `${SHOP}/kontakt@2x`],
    [`${SHOP}/path;jsessionid=ABC?x=1`, `${SHOP}/path;jsessionid=${REDACTED}?x=${REDACTED}`],
    [`${SHOP}/share?u=https%3A%2F%2Fshop.example.test%2Fa&hl=de`, `${SHOP}/share?u=${REDACTED}&hl=de`],
    [
      'https://ad.example.test/activity;dc_pre=abc;ord=123',
      `https://ad.example.test/activity;dc_pre=${REDACTED};ord=${REDACTED}`,
    ],
    ['tel:+4930123456', 'tel:+4930123456'],
    ['tel:+4930123456;ext=1', 'tel:+4930123456;ext=1'],
    ['sms:+4915112345678?body=Hallo', `sms:+4915112345678?body=${REDACTED}`],
    ['geo:52.5,13.4', 'geo:52.5,13.4'],
    ['javascript:void(0)', 'javascript:void(0)'],
    ['javascript:history.back()', 'javascript:history.back()'],
    ['about:blank', 'about:blank'],
    ['data:image/png;base64,AAAA', `data:${REDACTED}`],
    ['blob:https://x.test/0f4a', `blob:${REDACTED}`],
    ['urn:isbn:978-3-16-148410-0', 'urn:isbn:978-3-16-148410-0'],
    ['file:///c/readme.txt', 'file:///c/readme.txt'],
    [`view-source:${SHOP}/p`, `view-source:${SHOP}/p`],
    ['ws://h.test/socket', 'ws://h.test/socket'],
    ['wss://h.test/socket?hl=de', 'wss://h.test/socket?hl=de'],
    ['ftp://ftp.example.test/pub/file.txt', 'ftp://ftp.example.test/pub/file.txt'],
    ['git+ssh://git@git.example.test/org/repo.git', 'git+ssh://git.example.test/org/repo.git'],
    ['foo:bar', 'foo:bar'],
    ['foo:version@3.7.1', 'foo:version@3.7.1'],
    ['foo:a/b/c', 'foo:a/b/c'],
    ['foo://h.test/a/b?hl=de', 'foo://h.test/a/b?hl=de'],
  ])('%s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
    expect(sanitizeUrl(expected)).toBe(expected);
  });
});

describe('the query', () => {
  it.each([
    [
      'https://u:p@www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=123.456&en=page_view#x',
      `https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=${REDACTED}&en=page_view`,
    ],
    [
      'https://fonts.googleapis.com/css2?family=Roboto&display=swap',
      'https://fonts.googleapis.com/css2?family=Roboto&display=swap',
    ],
    // the Meta Pixel event name (`ev`) stays, so core and the browser collector sanitize alike
    [
      'https://www.facebook.com/tr?id=123&ev=PageView&fbp=fb.1.2.3',
      `https://www.facebook.com/tr?id=123&ev=PageView&fbp=${REDACTED}`,
    ],
    ['http://h.test/p?hl=de&x=1', `http://h.test/p?hl=de&x=${REDACTED}`],
    ['http://h.test/p?a=1&a=2&a=3', `http://h.test/p?a=${REDACTED}&a=${REDACTED}&a=${REDACTED}`],
    ['http://h.test/p?a&b&c', `http://h.test/p?a=${REDACTED}&b=${REDACTED}&c=${REDACTED}`],
    // empty sequences, an empty key, only an empty value
    ['http://h.test/p?&&a=1&&', `http://h.test/p?a=${REDACTED}`],
    ['http://h.test/p?=1', `http://h.test/p?=${REDACTED}`],
    ['http://h.test/p?a=', `http://h.test/p?a=${REDACTED}`],
    ['http://h.test/p?a=b=c', `http://h.test/p?a=${REDACTED}`],
    ['http://h.test/p?&&&', 'http://h.test/p'],
    ['http://h.test/p?', 'http://h.test/p?'],
    // "+" is a blank, "%20" too; an allowlisted name keeps the decoded value in the form-urlencoded form
    ['http://h.test/p?family=Open+Sans:400', 'http://h.test/p?family=Open+Sans%3A400'],
    ['http://h.test/p?family=Open%20Sans', 'http://h.test/p?family=Open+Sans'],
    ['http://h.test/p?family=a%2Bb', 'http://h.test/p?family=a%2Bb'],
    ['http://h.test/p?hl=%C3%BCber', 'http://h.test/p?hl=%C3%BCber'],
    // an escape that is no valid UTF-8 turns into U+FFFD; a stray "%" stays
    ['http://h.test/p?hl=%E9', 'http://h.test/p?hl=%EF%BF%BD'],
    ['http://h.test/p?hl=100%', 'http://h.test/p?hl=100%25'],
    ['http://h.test/p?hl=%ZZ', 'http://h.test/p?hl=%25ZZ'],
    ['http://h.test/p?hl=%4', 'http://h.test/p?hl=%254'],
    ['http://h.test/p?hl=%EF%BB%BFde', 'http://h.test/p?hl=%EF%BB%BFde'],
    ['http://h.test/p?hl=%F0%9F%98%80', 'http://h.test/p?hl=%F0%9F%98%80'],
    // the name is compared in lower case; the key keeps its case
    ['http://h.test/p?HL=de&Family=Roboto', 'http://h.test/p?HL=de&Family=Roboto'],
    // addresses in a key and in a kept value, written out and encoded
    ['http://h.test/p?alice@mail.test', `http://h.test/p?${REDACTED}=${REDACTED}`],
    ['http://h.test/p?alice%40mail.test=1', `http://h.test/p?${REDACTED}=${REDACTED}`],
    ['http://h.test/p?hl=de%2Calice%40mail.test', `http://h.test/p?hl=${REDACTED}`],
    ['http://h.test/p?hl=de%2Calice%2540mail.test', `http://h.test/p?hl=${REDACTED}`],
    // a value that already is the mask, in a kept parameter
    ['http://h.test/p?hl=[redacted]', `http://h.test/p?hl=${REDACTED}`],
    ['http://h.test/p?hl=%5Bredacted%5D', `http://h.test/p?hl=${REDACTED}`],
    // non-ASCII characters in the query
    ['http://h.test/p?hl=ü&x=😀', `http://h.test/p?hl=%C3%BC&x=${REDACTED}`],
    // the fragment is no part of the query
    ['http://h.test/p?hl=de#a=1&b=2', 'http://h.test/p?hl=de'],
  ])('%s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
    expect(sanitizeUrl(expected)).toBe(expected);
  });

  // generic names keep only site-level values of the expected form (QUERY_VALUE_RULES)
  it.each([
    ['https://shop.example.de/konto/bestellung?id=4711&token=abc', `?id=${REDACTED}&token=${REDACTED}`],
    ['https://shop.example.de/x?id=visitor-secret', `?id=${REDACTED}`],
    ['https://www.googletagmanager.com/gtm.js?id=GTM-K7X9', '?id=GTM-K7X9'],
    ['https://www.googletagmanager.com/gtag/js?id=AW-123456789', '?id=AW-123456789'],
    ['https://www.googletagmanager.com/gtag/js?id=DC-9876543', '?id=DC-9876543'],
    ['https://www.googletagmanager.com/gtag/js?id=GT-PZXQ', '?id=GT-PZXQ'],
    ['https://www.googletagmanager.test/gtag/js?id=G-ABC123', '?id=G-ABC123'],
    ['https://www.google-analytics.com/g/collect?tid=G-T', '?tid=G-T'],
    ['https://www.example.de/x?id=G-', `?id=${REDACTED}`],
    ['http://h.test/p?id=12345&v=2.1.0&t=pageview', `?id=${REDACTED}&v=2.1.0&t=pageview`],
    ['https://www.example.de/app.js?t=1730291234567&v=8a1f2c', `?t=${REDACTED}&v=${REDACTED}`],
    ['https://cdn.example.de/a.js?v=1793373555053', `?v=${REDACTED}`],
    ['https://www.google.com/x?v=NhfdZHabcdefghijklmnopqr', `?v=${REDACTED}`],
    ['https://www.example.de/wp.js?ver=6.4.2&v=2.1.0', '?ver=6.4.2&v=2.1.0'],
    [
      'https://www.google-analytics.com/collect?v=1&t=pageview&tid=UA-1234-1',
      '?v=1&t=pageview&tid=UA-1234-1',
    ],
    ['https://metrics.example.de/b/ss?t=30%2F9%2F2026+16%3A21%3A3+5+-60', `?t=${REDACTED}`],
    ['https://www.google-analytics.com/g/collect?tid=customer-4711', `?tid=${REDACTED}`],
  ])('value rule: %s', (input, query) => {
    const expected = `${input.split('?')[0]}${query}`;
    expect(sanitizeUrl(input)).toBe(expected);
    expect(sanitizeUrl(expected)).toBe(expected);
  });

  // an allowed name keeps a setting; a value with an ID-like run is a visitor's
  it.each([
    ['a UUID', 'http://h.test/p?hl=123e4567-e89b-12d3-a456-426614174000', `http://h.test/p?hl=${REDACTED}`],
    ['a base64 token', 'http://h.test/p?render=Xk2mQ9pLw8eR1tZ3aB4cD5', `http://h.test/p?render=${REDACTED}`],
    ['a timestamp', 'http://h.test/p?en=1730291234567', `http://h.test/p?en=${REDACTED}`],
    ['a hex id', 'http://h.test/p?ver=4f3a9c1d2e7b4a9f', `http://h.test/p?ver=${REDACTED}`],
    [
      'a hex id in a font family',
      'http://h.test/css?family=4f3a9c1d2e7b4a9f',
      `http://h.test/css?family=${REDACTED}`,
    ],
    [
      'a number in a font family',
      'http://h.test/css?family=Roboto:4711234567',
      `http://h.test/css?family=${REDACTED}`,
    ],
    [
      'a UUID in a matrix parameter',
      'http://h.test/a;hl=123e4567-e89b-12d3-a456-426614174000/b',
      `http://h.test/a;hl=${REDACTED}/b`,
    ],
    ['counterexample: a language', 'http://h.test/p?hl=de-DE', 'http://h.test/p?hl=de-DE'],
    [
      'counterexample: fonts with axes',
      'http://h.test/css2?family=Roboto:ital,wght@0,400;1,700&display=swap',
      'http://h.test/css2?family=Roboto%3Aital%2Cwght%400%2C400%3B1%2C700&display=swap',
    ],
    [
      'counterexample: fonts of the first version',
      'http://h.test/css?family=Open+Sans:400,700i|Lato',
      'http://h.test/css?family=Open+Sans%3A400%2C700i%7CLato',
    ],
    [
      'counterexample: a tag id',
      'http://h.test/gtag/js?id=G-ABCDEF1234',
      'http://h.test/gtag/js?id=G-ABCDEF1234',
    ],
    [
      'counterexample: a container id',
      'http://h.test/gtm.js?id=GTM-K7X9ABC',
      'http://h.test/gtm.js?id=GTM-K7X9ABC',
    ],
    [
      'counterexample: a version',
      'http://h.test/a.js?ver=6.4.2&v=2.1.0',
      'http://h.test/a.js?ver=6.4.2&v=2.1.0',
    ],
  ])('an allowed name keeps no id: %s', (_case, input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
    expect(sanitizeUrl(expected)).toBe(expected);
  });

  it('the allowlist it is given decides, for query and matrix names alike', () => {
    const allow = new Set(['ev', 'hl']);
    expect(sanitizeUrl('http://h.test/p?ev=PageView&hl=de&x=1', allow)).toBe(
      `http://h.test/p?ev=PageView&hl=de&x=${REDACTED}`,
    );
    const url = `https://ad.example.test/activity;ev=Purchase;ord=${MARK}`;
    expect(sanitizeUrl(url, QUERY_ALLOWLIST)).toBe(
      `https://ad.example.test/activity;ev=Purchase;ord=${REDACTED}`,
    );
    expect(sanitizeUrl(url, new Set())).toBe(
      `https://ad.example.test/activity;ev=${REDACTED};ord=${REDACTED}`,
    );
  });
});

describe('mailto: recipients are masked, headers dropped', () => {
  it.each([
    ['mailto:alice@example.de', `mailto:${REDACTED}@example.de`],
    ['MAILTO:Alice.Smith@Example.de?subject=Hi&cc=bob@other.de', `mailto:${REDACTED}@example.de`],
    ['mailto:a@x.de,b@y.de', `mailto:${REDACTED}@x.de,${REDACTED}@y.de`],
    ['mailto:%61lice%40example.de', `mailto:${REDACTED}@example.de`],
    ['mailto:?subject=x&body=alice@example.de', `mailto:${REDACTED}`],
    ['mailto:info@example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:info@example.test?subject=Hallo', `mailto:${REDACTED}@example.test`],
    [`mailto:alice@${M}?subject=x`, `mailto:${REDACTED}@${M}`],
  ])('%s', (input, expected) => {
    expect(expectStable(input)).toBe(expected);
  });
});

it.each(['?', '=', '&', '#', '://'])('redacts a nested query delimiter %s', (delimiter) => {
  const value = `prefix${delimiter}suffix`;
  const url = new URL('https://a.test/');
  url.searchParams.set('hl', value);
  expect(decodeURIComponent(sanitizeUrl(url.href))).toBe('https://a.test/?hl=[redacted]');
});

describe('nested queries in allowed values', () => {
  it.each(['family', 'hl', 'id'])('redacts %s', (key) => {
    expect(sanitizeUrl(`https://fonts.googleapis.com/css2?${key}=Roboto%3Fuid%3Dsecret`)).toBe(
      `https://fonts.googleapis.com/css2?${key}=[redacted]`,
    );
  });
});
