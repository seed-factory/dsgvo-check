/**
 * Every browser request URL passes through sanitization, so a large query must take one linear pass (repeated
 * URLSearchParams iteration is quadratic); a reference loop checks byte-for-byte redaction semantics.
 */
import { describe, expect, it } from 'vitest';
import { hasIdLikeRun } from '../../../../src/core/redaction/page-names.ts';
import { containsAddress, hasAddressMarker, REDACTED } from '../../../../src/core/url/email.ts';
import { QUERY_ALLOWLIST, QUERY_VALUE_RULES, sanitizeUrl } from '../../../../src/core/url/url.ts';
import { expectLinearGrowth } from '../../../utils/scaling.ts';
import { random } from './redaction-helpers.ts';

const KiB = 1024;
const manyParams = (bytes: number) => `http://h.test/?a=${'&a'.repeat(bytes / 2)}`;

/** Compare fourfold input growth, with warmed best samples to reduce scheduler and GC noise. */
function expectLinear(build: (n: number) => string): void {
  const small = build(128 * KiB);
  const large = build(512 * KiB);
  expectLinearGrowth(
    () => sanitizeUrl(small),
    () => sanitizeUrl(large),
  );
}

describe('query processing scales with parameter count and value size', () => {
  it('four times as many parameters stays below quadratic growth', () => expectLinear(manyParams));

  it('bounds the output for a 4 MiB query', () => {
    const out = sanitizeUrl(manyParams(4 * 1024 * KiB));
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

  it.each([155, 156, 157, 158, 2000])(
    'cuts a query of %i short parameters at the same character boundary',
    (n) => {
      const expected = `http://h.test/?${Array.from({ length: n }, () => `a=${REDACTED}`).join('&')}`;

      expect(sanitizeUrl(`http://h.test/?${'a&'.repeat(n)}`)).toBe(expected.slice(0, 2048));
    },
  );
});

/** The query part of the old `sanitizeUrl` (quadratic via `u.searchParams`), for short inputs only. */
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
      const keep =
        allowlist.has(name) &&
        !containsAddress(v) &&
        !hasAddressMarker(v) &&
        !/[?=&#]/.test(v) &&
        !v.includes('://') &&
        (rule ? rule(v, u) : !hasIdLikeRun(v));
      out.append(containsAddress(k) ? REDACTED : k, keep ? v : REDACTED);
    }
    u.search = out.toString().replaceAll('%5Bredacted%5D', REDACTED);
  }

  return u.toString().slice(0, 2048);
}

describe('query output matches the reference implementation', () => {
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

  it('short queries with mixed escapes and separators', () => {
    const rnd = random(20261101);
    const pick = () => pieces[Math.floor(rnd() * pieces.length)] as string;
    for (let i = 0; i < 6_000; i++) {
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
    for (let i = 0; i < 60; i++) {
      const query = Array.from({ length: 600 + Math.floor(rnd() * 800) }, pick).join('');
      const url = `http://h.test/p?${query}`;
      const expected = REFERENCE(url);
      expect(expected.length, 'the input is long enough to be cut').toBeLessThanOrEqual(2048);
      expect(sanitizeUrl(url), JSON.stringify(url.slice(0, 120))).toBe(expected);
    }
  });
});
