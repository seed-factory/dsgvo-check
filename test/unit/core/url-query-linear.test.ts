/**
 * L0 (P2): `sanitizeUrl` walks the query in one linear pass.
 *
 * Before, the loop `for (const [k, v] of u.searchParams)` was quadratic in the number of parameters (the iterator of
 * `URLSearchParams` costs O(n) per step): `?a=` + `&a` × 32 768 (64 KiB) took 30-40 ms, 128 KiB 130 ms, 256 KiB 480 ms,
 * 512 KiB 1.8 s, 4 MiB about two minutes. The browser collector passes the URL of every request through `sanitizeUrl`,
 * whatever its length. The result must stay byte for byte the same: `REFERENCE` below is the old loop.
 *
 * Synthetic hosts only (`*.test`).
 */
import { describe, expect, it } from 'vitest';
import {
  containsAddress,
  QUERY_ALLOWLIST,
  QUERY_VALUE_RULES,
  REDACTED,
  sanitizeUrl,
} from '../../../src/core/url.ts';

/** mulberry32: the same sequence on every run, no extra dependency. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * The query part of the old `sanitizeUrl` (before P2), for a URL whose path needs no redaction. It iterates
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

const timed = (fn: () => unknown): number => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};

describe('P2: the time of sanitizeUrl grows linearly with the number of query parameters', () => {
  // The shape of the report: one `&a` per parameter, no "=" (the cheapest parameter there is).
  const manyParams = (bytes: number) => `http://h.test/?a=${'&a'.repeat(bytes / 2)}`;

  it('64 KiB of parameters', () => {
    const url = manyParams(64 * 1024);
    expect(timed(() => sanitizeUrl(url))).toBeLessThan(200);
  });

  it('512 KiB of parameters', () => {
    const url = manyParams(512 * 1024);
    expect(timed(() => sanitizeUrl(url))).toBeLessThan(400);
  });

  it('4 MiB of parameters', { timeout: 60_000 }, () => {
    const url = manyParams(4 * 1024 * 1024);
    expect(timed(() => sanitizeUrl(url))).toBeLessThan(1000);
  });

  it('the time of 4x the input is not 16x (quadratic) the time of the input', () => {
    // best of three: a hiccup (GC) of a single run must not decide
    const best = (url: string) => Math.min(...[0, 1, 2].map(() => timed(() => sanitizeUrl(url))));
    const small = best(manyParams(128 * 1024));
    const large = best(manyParams(512 * 1024));
    // linear: about 4; quadratic: about 16. The floor of 5 ms keeps a sub-millisecond `small` from deciding.
    expect(large).toBeLessThan(Math.max(small, 5) * 10);
  });

  describe('other shapes of a long query', () => {
    const MiB = 1024 * 1024;
    const shapes: Array<[string, string]> = [
      ['pairs with a value', `a=1${'&a=1'.repeat(MiB / 4)}`],
      ['keys without a value, long keys', `${'k'.repeat(64)}${`&${'k'.repeat(64)}`.repeat(MiB / 65)}`],
      ['escapes in every pair', `a=%41%2B%20${'&a=%41%2B%20'.repeat(MiB / 12)}`],
      ['plus signs', `a=${'+'.repeat(MiB)}`],
      ['one long invalid escape run', `a=${'%E9'.repeat(MiB / 3)}`],
      ['percent signs only', `a=${'%'.repeat(MiB)}`],
      ['empty sequences', '&'.repeat(MiB)],
      ['equal signs only', '='.repeat(MiB)],
      ['pairs without a key', `=1${'&=1'.repeat(MiB / 3)}`],
      ['allowlisted names with a value', `hl=de${'&hl=de'.repeat(MiB / 6)}`],
      ['addresses in the values', `a=b@c.test${'&a=b@c.test'.repeat(MiB / 11)}`],
      ['encoded addresses in the keys', `b%40c.test${'&b%40c.test'.repeat(MiB / 11)}`],
    ];

    it.each(shapes)('%s: 1 MiB', (_name, query) => {
      const url = `http://h.test/?${query}`;
      expect(timed(() => sanitizeUrl(url))).toBeLessThan(1000);
    });
  });

  it('the result of a very long query is cut at 2048 characters like any other', () => {
    const out = sanitizeUrl(`http://h.test/?a=${'&b=1'.repeat(400_000)}`);
    expect(out).toHaveLength(2048);
    expect(out.startsWith(`http://h.test/?a=${REDACTED}&b=${REDACTED}&b=${REDACTED}`)).toBe(true);
  });
});

describe('P2: the result is the same as before (counterexamples of ordinary queries)', () => {
  it.each([
    // [input, expected]; every expected value is what the quadratic version returned
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

describe('P2: differential test against the old loop', () => {
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
