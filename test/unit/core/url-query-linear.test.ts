import { describe, expect, it } from 'vitest';
import {
  containsAddress,
  QUERY_ALLOWLIST,
  QUERY_VALUE_RULES,
  REDACTED,
  sanitizeUrl,
} from '../../../src/core/url.ts';

const KiB = 1024;
const manyParams = (bytes: number) => `http://h.test/?a=${'&a'.repeat(bytes / 2)}`;

/** Compare fourfold input growth, with warmed best samples to reduce scheduler and GC noise. */
function expectLinear(build: (n: number) => string): void {
  const small = build(128 * KiB);
  const large = build(512 * KiB);
  sanitizeUrl(small);
  sanitizeUrl(large);
  const best = (url: string) =>
    Math.min(
      ...Array.from({ length: 5 }, () => {
        const started = performance.now();
        sanitizeUrl(url);
        return performance.now() - started;
      }),
    );
  expect(best(large) / Math.max(best(small), 0.05)).toBeLessThan(12);
}

describe('query processing scales with parameter count and value size', () => {
  it('four times as many parameters stays below quadratic growth', () => expectLinear(manyParams));

  it.each([64 * KiB, 512 * KiB, 4 * 1024 * KiB])('bounds the output for %i input bytes', (bytes) => {
    const out = sanitizeUrl(manyParams(bytes));
    expect(out).toHaveLength(2048);
    expect(out.startsWith(`http://h.test/?a=${REDACTED}&a=${REDACTED}`)).toBe(true);
  });

  it.each<[string, (n: number) => string]>([
    ['pairs with a value', (n) => `a=1${'&a=1'.repeat(n / 4)}`],
    ['long keys without a value', (n) => `${'k'.repeat(64)}${`&${'k'.repeat(64)}`.repeat(n / 65)}`],
    ['escapes in every pair', (n) => `a=%41%2B%20${'&a=%41%2B%20'.repeat(n / 12)}`],
    ['plus signs', (n) => `a=${'+'.repeat(n)}`],
    ['one invalid escape run', (n) => `a=${'%E9'.repeat(n / 3)}`],
    ['percent signs', (n) => `a=${'%'.repeat(n)}`],
    ['empty sequences', (n) => '&'.repeat(n)],
    ['equal signs', (n) => '='.repeat(n)],
    ['pairs without a key', (n) => `=1${'&=1'.repeat(n / 3)}`],
    ['allowlisted names', (n) => `hl=de${'&hl=de'.repeat(n / 6)}`],
    ['addresses in values', (n) => `a=b@c.test${'&a=b@c.test'.repeat(n / 11)}`],
    ['encoded addresses in keys', (n) => `b%40c.test${'&b%40c.test'.repeat(n / 11)}`],
  ])('%s', (_name, query) => {
    expectLinear((n) => `http://h.test/?${query(n)}`);
    const out = sanitizeUrl(`http://h.test/?${query(1024 * KiB)}`);
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out).not.toMatch(/b(?:%40|@)c\.test/);
  });

  it('cuts a long mixed query at the public URL limit', () => {
    const out = sanitizeUrl(`http://h.test/?a=${'&b=1'.repeat(400_000)}`);
    expect(out).toHaveLength(2048);
    expect(out.startsWith(`http://h.test/?a=${REDACTED}&b=${REDACTED}&b=${REDACTED}`)).toBe(true);
  });

  it.each([200, 340, 341, 342, 500, 1023, 1024, 1025, 2000])(
    'cuts a query of %i short parameters at the same character boundary',
    (n) => {
      const expected = `http://h.test/?${Array.from({ length: n }, () => `a=${REDACTED}`).join('&')}`;
      expect(sanitizeUrl(`http://h.test/?${'a&'.repeat(n)}`)).toBe(expected.slice(0, 2048));
    },
  );
});

describe('query normalization and privacy', () => {
  it.each([
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
    // value rules of generic names
    [
      'https://www.googletagmanager.test/gtag/js?id=G-ABC123',
      'https://www.googletagmanager.test/gtag/js?id=G-ABC123',
    ],
    ['http://h.test/p?id=12345&v=2.1.0&t=pageview', `http://h.test/p?id=${REDACTED}&v=2.1.0&t=pageview`],
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

  it('a custom allowlist is honoured', () => {
    const allow = new Set(['ev', 'hl']);
    expect(sanitizeUrl('http://h.test/p?ev=PageView&hl=de&x=1', allow)).toBe(
      `http://h.test/p?ev=PageView&hl=de&x=${REDACTED}`,
    );
  });
});

/** mulberry32: the same sequence on every run, no extra dependency. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * The query part of the old `sanitizeUrl`, for a URL whose path needs no redaction. It iterates
 * `u.searchParams`, which is quadratic, so it is used on short inputs only.
 */
function REFERENCE(raw: string, allowlist: ReadonlySet<string> = QUERY_ALLOWLIST): string {
  const u = new URL(raw);
  u.username = '';
  u.password = '';
  u.hash = '';
  if (u.search) {
    const out = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      const name = k.toLowerCase();
      const rule = QUERY_VALUE_RULES[name];
      const keep = allowlist.has(name) && !containsAddress(v) && (rule ? rule(v, u) : true);
      out.append(containsAddress(k) ? REDACTED : k, keep ? v : REDACTED);
    }
    u.search = out.toString().replaceAll('%5Bredacted%5D', REDACTED);
  }
  return u.toString().slice(0, 2048);
}

describe('query output matches the previous implementation', () => {
  const pieces = [
    'a',
    'b',
    'hl',
    'HL',
    'id',
    'tid',
    'v',
    't',
    'ev',
    'family',
    'G-ABC123',
    'pageview',
    '2.1.0',
    '=',
    '=',
    '&',
    '&',
    '&&',
    '+',
    ' ',
    '%20',
    '%2B',
    '%25',
    '%',
    '%4',
    '%ZZ',
    '%E9',
    '%C3',
    '%C3%BC',
    '%EF%BB%BF',
    '%F0%9F%98%80',
    '%F0%9F',
    '%00',
    '%7F',
    '%80',
    '%40',
    '%2540',
    '%3D',
    '%26',
    '@',
    'x.test',
    'alice@mail.test',
    'alice%40mail.test',
    '[redacted]',
    '%5Bredacted%5D',
    '%5bredacted%5d',
    '😀',
    'ü',
    '™',
    ' ',
    "'",
    '"',
    '<',
    '>',
    '`',
    '{',
    '}',
    '|',
    '\\',
    '^',
    ';',
    ':',
    ',',
    '/',
    '?',
    '*',
    '-',
    '.',
    '_',
    '~',
    '!',
    '(',
    ')',
  ];

  it('random queries, 60 000 inputs', () => {
    const rnd = random(20261101);
    const pick = () => pieces[Math.floor(rnd() * pieces.length)] as string;
    for (let i = 0; i < 60_000; i++) {
      const query = Array.from({ length: 1 + Math.floor(rnd() * 14) }, pick).join('');
      const url = `http://h.test/p?${query}`;
      let expected: string;
      try {
        expected = REFERENCE(url);
      } catch {
        continue;
      }
      expect(sanitizeUrl(url), JSON.stringify(url)).toBe(expected);
    }
  });

  it('long random queries: the cut at 2048 characters is the same', () => {
    const rnd = random(20261102);
    const pick = () => pieces[Math.floor(rnd() * pieces.length)] as string;
    for (let i = 0; i < 300; i++) {
      const query = Array.from({ length: 600 + Math.floor(rnd() * 800) }, pick).join('');
      const url = `http://h.test/p?${query}`;
      const expected = REFERENCE(url);
      expect(expected.length, 'the input is long enough to be cut').toBeLessThanOrEqual(2048);
      expect(sanitizeUrl(url), JSON.stringify(url.slice(0, 120))).toBe(expected);
    }
  });

  it('a query of short parameters that fills the cut exactly', () => {
    for (const n of [200, 340, 341, 342, 500, 1023, 1024, 1025, 2000]) {
      const url = `http://h.test/?${'a&'.repeat(n)}`;
      expect(sanitizeUrl(url), `n=${n}`).toBe(REFERENCE(url));
    }
  });
});
