/**
 * L1 (review S-*, follow-up of N-REV-4): the header normalizer reads values of untrusted origin. Since N-REV-4 the
 * `<meta http-equiv>` values of the start document (up to `HEURISTIC_BYTES` = 64 KiB) pass `storedHeaderRecord` too,
 * and a lazy `(.*?)` followed by `\s*$` in the `Refresh` parser (and `[^>]*` in the `Link` parser) backtracks
 * quadratically: one page blocked the event loop for seconds, past every deadline timer. The parsers are linear now;
 * what they read did not change, which the tables and the differential runs against the old regular expressions
 * (kept here as oracles, small inputs only) pin down.
 */
import { describe, expect, it } from 'vitest';
import { MAX_HEADER_VALUE, storedHeaderRecord } from '../../../src/core/headers.ts';
import { REDACTED, sanitizeUrl } from '../../../src/core/url.ts';

/** The size of the biggest untrusted text that reaches the normalizer (`HEURISTIC_BYTES` of the start document). */
const SIZE = 64 * 1024;
/** A linear pass over 64 KiB takes well under a millisecond; the quadratic one took 7 s. */
const LIMIT_MS = 200;
const BASE = 'https://www.example.test/dir/page';
const identity = (u: string) => u;

function elapsedMs(run: () => unknown): number {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
}

const stored = (name: string, value: string, sanitize = sanitizeUrl) =>
  storedHeaderRecord(name, value, BASE, sanitize);

describe('Refresh: 64 KiB values are read in linear time', () => {
  const spaces = ' '.repeat(SIZE - 8);
  it.each([
    ['a delay, a path, a long run of spaces, a last character', `0;x${spaces}y`],
    ['the same behind url=', `0;url=x${spaces}y`],
    ['an unclosed quote', `0;'x${spaces}y`],
    ['an unclosed double quote behind url=', `0; URL = "x${spaces}y`],
    ['a no-break space series (it is whitespace of JavaScript)', `0;x${'\u00a0'.repeat(SIZE - 8)}y`],
    ['a tab series', `0;x${'\t'.repeat(SIZE - 8)}y`],
    ['spaces in front of the delay, junk behind it', `${spaces}0${spaces}x`],
    ['a comma as the separator', `0,x${spaces}y`],
    ['words, not one run', `0;${'x '.repeat(SIZE / 2 - 4)}y`],
    ['a closed quote with a space series inside', `0;'x${spaces}y'`],
    ['a line terminator behind the series', `0;x${spaces}\ny`],
  ])('%s', (_what, value) => {
    expect(value.length).toBeGreaterThan(SIZE - 16);
    let record: ReturnType<typeof stored> | undefined;
    expect(elapsedMs(() => (record = stored('refresh', value)))).toBeLessThan(LIMIT_MS);
    // the value is still stored cut at the limit, never longer
    expect(record?.value.length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
  });

  it('the same value with the identity sanitizer (the browser collector path)', () => {
    expect(elapsedMs(() => stored('refresh', `0;x${spaces}y`, identity))).toBeLessThan(LIMIT_MS);
  });

  it('keeps what it read: the delay and the resolved address, cut at the limit', () => {
    const rec = stored('refresh', `0;x${spaces}y`);
    expect(rec.value.startsWith('0; url=https://www.example.test/dir/x%20%20')).toBe(true);
    expect(rec.truncated).toBe(true);
    expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
  });

  it('a header of the size a server may send (16 KB) is fast as well', () => {
    expect(elapsedMs(() => stored('refresh', `0;x${' '.repeat(16 * 1024 - 8)}y`))).toBeLessThan(LIMIT_MS);
  });
});

describe('Link: 64 KiB values are read in linear time', () => {
  it.each([
    ['only opening brackets', '<'.repeat(SIZE)],
    ['opening brackets with a letter', '<a'.repeat(SIZE / 2)],
    ['an unclosed target behind a closed one', `<https://a.test/x>;rel=next${'<'.repeat(SIZE - 40)}`],
    ['a closed target behind many opening brackets', `${'<'.repeat(SIZE - 30)}http://a.test/x>`],
  ])('%s', (_what, value) => {
    let record: ReturnType<typeof stored> | undefined;
    expect(elapsedMs(() => (record = stored('link', value)))).toBeLessThan(LIMIT_MS);
    expect(record?.value.length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
  });

  it('a 16 KB header of opening brackets is fast as well', () => {
    expect(elapsedMs(() => stored('link', '<'.repeat(16 * 1024)))).toBeLessThan(LIMIT_MS);
  });

  it('keeps what it read: closed targets are resolved, an unclosed one stays as sent', () => {
    expect(stored('link', '<a.html>; rel=next, <b.html').value).toBe(
      '<https://www.example.test/dir/a.html>; rel=next, <b.html',
    );
    expect(stored('link', '<'.repeat(40)).value).toBe('<'.repeat(40));
  });
});

describe('the other value parsers stay linear on 64 KiB (no regression)', () => {
  it.each([
    ['content-security-policy', `frame-ancestors ${'a.'.repeat(SIZE / 2)}!`],
    ['content-security-policy', 'a@'.repeat(SIZE / 2)],
    ['content-security-policy', 'a:'.repeat(SIZE / 2)],
    ['content-security-policy', 'a://'.repeat(SIZE / 4)],
    ['content-security-policy', `[${'a:'.repeat(SIZE / 2)}`],
    ['content-security-policy', 'x '.repeat(SIZE / 2)],
    ['content-security-policy', `frame-ancestors${' a'.repeat(SIZE / 2)}`],
    ['content-security-policy', `${';'.repeat(SIZE)}`],
    ['content-security-policy', `${','.repeat(SIZE)}`],
    ['permissions-policy', 'http://'.repeat(SIZE / 7)],
    ['permissions-policy', `http://${'a'.repeat(SIZE)}`],
    ['location', 'a'.repeat(SIZE)],
    ['x-trace', 'a'.repeat(SIZE)],
  ])('%s: %#', (name, value) => {
    expect(elapsedMs(() => stored(name, value))).toBeLessThan(LIMIT_MS);
  });
});

/** The parsers as they were before the fix: oracles for small inputs (they are quadratic on big ones). */
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

describe('Refresh: what the parser reads did not change', () => {
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
    expect(stored('refresh', value, identity).value).toBe(legacyRefresh(value));
  });

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
    const next = seeded(20261031);
    for (let i = 0; i < 30_000; i++) {
      const value = Array.from({ length: 1 + (next() % 9) }, () => pieces[next() % pieces.length]).join('');
      const got = stored('refresh', value, identity).value;
      if (got !== legacyRefresh(value))
        expect.fail(`${JSON.stringify(value)}: ${got} instead of ${legacyRefresh(value)}`);
    }
  });
});

describe('Link: what the parser reads did not change', () => {
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
    expect(stored('link', value, identity).value).toBe(legacyLink(value));
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
    const next = seeded(31102026);
    for (let i = 0; i < 20_000; i++) {
      const value = Array.from({ length: 1 + (next() % 10) }, () => pieces[next() % pieces.length]).join('');
      const got = stored('link', value, identity).value;
      if (got !== legacyLink(value))
        expect.fail(`${JSON.stringify(value)}: ${got} instead of ${legacyLink(value)}`);
    }
  });
});

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
