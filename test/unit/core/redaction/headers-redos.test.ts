/**
 * Headers and meta values contain untrusted text: long whitespace tails and incomplete Link fields must not cause
 * quadratic backtracking that blocks the event loop past the scan's deadline.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HEADER_VALUE, storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { expectLinearGrowth } from '../../../utils/scaling.ts';

/** The size of the biggest untrusted text that reaches the normalizer (`HEURISTIC_BYTES` of the start document). */
const SIZE = 64 * 1024;
const BASE = 'https://www.example.test/dir/page';
const identity = (u: string) => u;

/** Scale the same hostile shape fourfold; absolute latency depends on the worker load. */
function expectLinear(run: (size: number) => unknown): void {
  expectLinearGrowth(
    () => run(SIZE / 4),
    () => run(SIZE),
  );
}

const stored = (name: string, value: string, sanitize = sanitizeUrl) =>
  storedHeaderRecord(name, value, BASE, sanitize);

/** mulberry32: a small seeded generator of unsigned 32-bit integers, so a failing input is reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

describe('Refresh: 64 KiB values are read in linear time', () => {
  const spaces = ' '.repeat(SIZE - 8);
  it.each<[string, (n: number) => string]>([
    ['a delay, a path, spaces and a last character', (n) => `0;x${' '.repeat(n - 8)}y`],
    ['the same behind url=', (n) => `0;url=x${' '.repeat(n - 8)}y`],
    ['an unclosed quote', (n) => `0;'x${' '.repeat(n - 8)}y`],
    ['an unclosed double quote behind url=', (n) => `0; URL = "x${' '.repeat(n - 8)}y`],
    ['no-break spaces', (n) => `0;x${'\u00a0'.repeat(n - 8)}y`],
    ['tabs', (n) => `0;x${'\t'.repeat(n - 8)}y`],
    ['spaces before the delay and junk after it', (n) => `${' '.repeat(n - 8)}0${' '.repeat(n - 8)}x`],
    ['a comma separator', (n) => `0,x${' '.repeat(n - 8)}y`],
    ['words rather than one run', (n) => `0;${'x '.repeat(n / 2 - 4)}y`],
    ['a closed quote containing spaces', (n) => `0;'x${' '.repeat(n - 8)}y'`],
    ['a line terminator after the series', (n) => `0;x${' '.repeat(n - 8)}\ny`],
  ])('%s', (_what, build) => {
    expectLinear((n) => stored('refresh', build(n)));

    const record = stored('refresh', build(SIZE));

    expect(record.value.length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
  });

  it('the same value with the identity sanitizer (the browser collector path)', () => {
    expectLinear((n) => stored('refresh', `0;x${' '.repeat(n)}y`, identity));
  });

  it('keeps what it read: the delay and the resolved address, cut at the limit', () => {
    const rec = stored('refresh', `0;x${spaces}y`);

    expect(rec.value).toMatch(/^0; url=https:\/\/www\.example\.test\/dir\/x%20%20/);
    expect(rec.truncated).toBe(true);
    expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
  });

  it('a server-sized Refresh value is bounded', () => {
    expect(stored('refresh', `0;x${' '.repeat(16 * 1024 - 8)}y`).truncated).toBe(true);
  });
});

describe('Link: 64 KiB values are read in linear time', () => {
  it.each<[string, (n: number) => string]>([
    ['only opening brackets', (n) => '<'.repeat(n)],
    ['opening brackets with a letter', (n) => '<a'.repeat(n / 2)],
    ['an unclosed target after a closed one', (n) => `<https://a.test/x>;rel=next${'<'.repeat(n - 40)}`],
    ['a closed target after many opening brackets', (n) => `${'<'.repeat(n - 30)}http://a.test/x>`],
  ])('%s', (_what, build) => {
    expectLinear((n) => stored('link', build(n)));
    expect(stored('link', build(SIZE)).value.length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
  });

  it('a server-sized Link value is bounded', () => {
    expect(stored('link', '<'.repeat(16 * 1024)).value).toBe('<'.repeat(MAX_HEADER_VALUE));
  });

  it('keeps what it read: closed targets are resolved, an unclosed one stays as sent', () => {
    expect(stored('link', '<a.html>; rel=next, <b.html').value).toBe(
      '<https://www.example.test/dir/a.html>; rel=next, <b.html',
    );
    expect(stored('link', '<'.repeat(40)).value).toBe('<'.repeat(40));
  });
});

describe('other header parsers scale with untrusted values', () => {
  it.each<[string, (n: number) => string]>([
    ['content-security-policy', (n) => `frame-ancestors ${'a.'.repeat(n / 2)}!`],
    ['content-security-policy', (n) => 'a@'.repeat(n / 2)],
    ['content-security-policy', (n) => 'a:'.repeat(n / 2)],
    ['content-security-policy', (n) => 'a://'.repeat(n / 4)],
    ['content-security-policy', (n) => `[${'a:'.repeat(n / 2)}`],
    ['content-security-policy', (n) => 'x '.repeat(n / 2)],
    ['content-security-policy', (n) => `frame-ancestors${' a'.repeat(n / 2)}`],
    ['content-security-policy', (n) => ';'.repeat(n)],
    ['content-security-policy', (n) => ','.repeat(n)],
    ['permissions-policy', (n) => 'http://'.repeat(n / 7)],
    ['permissions-policy', (n) => `http://${'a'.repeat(n)}`],
    ['location', (n) => 'a'.repeat(n)],
    ['x-trace', (n) => 'a'.repeat(n)],
  ])('%s: %#', (name, build) => {
    expectLinear((n) => stored(name, build(n)));
  });
});

describe('Refresh delay and target parsing', () => {
  it.each([
    ['5', '5'],
    [' 5 ', '5'],
    ['0;url=https://a.test/p?x=1', '0; url=https://a.test/p?x=1'],
    ["0; URL='https://a.test/'", '0; url=https://a.test/'],
    ['0, url="/rel"', '0; url=https://www.example.test/rel'],
    ['0;https://a.test/', '0; url=https://a.test/'],
    ['1.5; url=/x', '1.5; url=https://www.example.test/x'],
    ['5 ; url = "/a b"', '5; url=https://www.example.test/a%20b'],
    ['\ufeff5;url=/x\u00a0', '5; url=https://www.example.test/x'],
    // no address: the delay alone
    ['0;url=', '0'],
    ['0; url =   ', '0'],
    ['0;', '0'],
    ['0 ;', '0'],
    ['0;""', '0'],
    ["0;url=''", '0'],
    // a quoted address of spaces is an address (the page itself)
    ['0;"  "', '0; url=https://www.example.test/dir/page'],
    // unclosed or lonely quotes belong to the address
    ["0;url='/x", "0; url=https://www.example.test/dir/'/x"],
    ['0;url="/x', '0; url=https://www.example.test/dir/%22/x'],
    ["0;url=/x'", "0; url=https://www.example.test/x'"],
    ["0;'", "0; url=https://www.example.test/dir/'"],
    ["0;'a'b'", "0; url=https://www.example.test/dir/a'b"],
    // `url` without `=`, other words, a second separator: the address is the rest
    ['5;url', '5; url=https://www.example.test/dir/url'],
    ['5;urlx=1', '5; url=https://www.example.test/dir/urlx=1'],
    ['5;url=url=x', '5; url=https://www.example.test/dir/url=x'],
    ['5,6;url=/x', '5; url=https://www.example.test/dir/6;url=/x'],
    ['5;;url=/x', '5; url=https://www.example.test/dir/;url=/x'],
    ['...;url=/x', '...; url=https://www.example.test/x'],
    // line terminators: around the address they are whitespace, inside it the value is not a refresh
    ['0;url\n=x', '0; url=https://www.example.test/dir/x'],
    ['0;\nurl=x', '0; url=https://www.example.test/dir/x'],
    ['0;url=x\n', '0; url=https://www.example.test/dir/x'],
    ['0;url=x\ny', REDACTED],
    ['0;"x\ny"', REDACTED],
    // an address that is no URL
    ['5;url=http://[bad', `5; url=${REDACTED}`],
    // no delay (or none that a refresh has): nothing is kept
    ['', REDACTED],
    ['   ', REDACTED],
    ['abc', REDACTED],
    ['url=/x', REDACTED],
    ['x;url=/x', REDACTED],
    ['; url=/x', REDACTED],
    ['5 x', REDACTED],
    ['-1;url=/x', REDACTED],
    ['+1;/x', REDACTED],
    ['５;url=/x', REDACTED],
  ])('%j', (value, expected) => {
    expect(stored('refresh', value, identity).value).toBe(expected);
  });
});

describe('Link target parsing', () => {
  it.each([
    ['<a.html>', '<https://www.example.test/dir/a.html>'],
    ['</x>; rel="preload"; as=style', '<https://www.example.test/x>; rel="preload"; as=style'],
    ['<a>, <b>', '<https://www.example.test/dir/a>, <https://www.example.test/dir/b>'],
    ['<>', '<https://www.example.test/dir/page>'],
    ['<a<b>', '<https://www.example.test/dir/a%3Cb>'],
    ['<a>>', '<https://www.example.test/dir/a>>'],
    ['<a', '<a'],
    ['a>', 'a>'],
    ['', ''],
  ])('%j', (value, expected) => {
    expect(stored('link', value, identity).value).toBe(expected);
  });
});

function legacyResolve(raw: string): string {
  try {
    return new URL(raw.trim(), BASE).toString();
  } catch {
    return REDACTED;
  }
}

function legacyRefresh(value: string): string {
  const m = /^(\s*[\d.]+\s*)(?:[;,]\s*(?:url\s*=\s*)?(['"]?)(.*?)\2\s*)?$/i.exec(value);
  if (!m) return REDACTED;
  return m[3] ? `${(m[1] as string).trim()}; url=${legacyResolve(m[3])}` : (m[1] as string).trim();
}

const legacyLink = (value: string): string =>
  value.replace(/<([^>]*)>/g, (_m, u: string) => `<${legacyResolve(u)}>`);

/** Random short values built from `pieces` must give the same stored value as the old regular expression. */
function expectSameAsLegacy(
  header: 'refresh' | 'link',
  legacy: (value: string) => string,
  { pieces, seed, runs, maxParts }: { pieces: string[]; seed: number; runs: number; maxParts: number },
) {
  const next = seeded(seed);
  const randomPiece = () => pieces[next() % pieces.length];

  for (let i = 0; i < runs; i++) {
    const value = Array.from({ length: 1 + (next() % maxParts) }, randomPiece).join('');
    const got = stored(header, value, identity).value;
    const want = legacy(value);

    if (got !== want) expect.fail(`${JSON.stringify(value)}: ${got} instead of ${want}`);
  }
}

describe('header parser equivalence', () => {
  it('differential: 30 000 random small values give the same record as the old expression', () => {
    const pieces = [
      '0',
      '5',
      '1.5',
      '.',
      ' ',
      '\t',
      '\n',
      '\u00a0',
      ';',
      ',',
      'url',
      'URL',
      'Url',
      '=',
      '"',
      "'",
      'x',
      '/a',
      '?q=1',
      'http://a.test/',
      'y z',
      '%',
      '\u2028',
    ];

    expectSameAsLegacy('refresh', legacyRefresh, { pieces, seed: 20261031, runs: 30_000, maxParts: 9 });
  });

  it('differential: 20 000 random small values give the same record as the old expression', () => {
    const pieces = [
      '<',
      '>',
      'a',
      '/',
      ' ',
      'http://x.test/p',
      '<http://x.test/>',
      '"',
      ',',
      ';',
      'rel=next',
      '\n',
    ];

    expectSameAsLegacy('link', legacyLink, { pieces, seed: 31102026, runs: 20_000, maxParts: 10 });
  });
});
