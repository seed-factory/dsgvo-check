/**
 * L0 (review R11, G03/G01): `sanitizeUrl` treats a percent-encoded `=` and `;` in a path segment like the literal
 * ones, and the address mask does not change the structure of the path. Before, the parameter rule looked at the raw
 * segment only: `max@example.test%3Bord%3D12345` kept `ord=12345` in the clear (the mask decoded the segment and wrote
 * it back with literal `;` and `=`), and a second pass over the result redacted what the first had left. `%2F` in a
 * segment with an address turned into a real `/` and added a segment.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeUrl } from '../../../src/core/url.ts';

const MARK = 'zq7marker';

describe('sanitizeUrl: encoded "=" and ";" in a path segment', () => {
  it.each([
    [
      // matrix parameter next to an address, both separators encoded
      `https://x.test/r/max@example.test%3Bord%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      // only "=" encoded
      `https://x.test/r/max@example.test;ord%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      // an encoded "=" and an encoded "?" after the address
      `https://x.test/r/max@example.test%3Fq%3D${MARK}`,
      `https://x.test/r/${REDACTED}@example.test%3Fq=${REDACTED}`,
    ],
    [
      // lower-case hex digits
      `https://x.test/r/max@example.test%3bord%3d${MARK}`,
      `https://x.test/r/${REDACTED}@example.test;ord=${REDACTED}`,
    ],
    [
      // no address: the parameter rule alone
      `https://ad.example.test/activity%3Bdc_pre%3D${MARK}%3Bord%3D${MARK}`,
      `https://ad.example.test/activity;dc_pre=${REDACTED};ord=${REDACTED}`,
    ],
    [`https://x.test/session%3Bjsessionid%3D${MARK}`, `https://x.test/session;jsessionid=${REDACTED}`],
    [
      // a segment that starts with a parameter
      `https://x.test/k%3D${MARK}`,
      `https://x.test/k=${REDACTED}`,
    ],
    [
      // an allowlisted name keeps a value of the expected form, also when the separators are encoded
      `https://cdn.example.test/lib%3Bv%3D2.1.0%3Bcid%3D${MARK}`,
      `https://cdn.example.test/lib;v=2.1.0;cid=${REDACTED}`,
    ],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('12345');
    expect(sanitizeUrl(out)).toBe(out);
  });

  it('does not leak the value of an encoded matrix parameter next to an address', () => {
    const out = sanitizeUrl('https://x.test/r/max@example.test%3Bord%3D12345');
    expect(out).not.toContain('12345');
    expect(out).not.toContain('max@');
  });
});

describe('sanitizeUrl: encoded separators without a parameter stay as written', () => {
  it.each([
    'https://de.wikipedia.example/wiki/Kategorie%3ADatenschutz',
    'https://x.test/a%3Bb/c%26d',
    'https://x.test/%C3%BCber%2Funs/',
    'https://x.test/a%2Fb/info%40',
  ])('%s', (url) => {
    expect(sanitizeUrl(url)).toBe(url);
  });
});

describe('sanitizeUrl: an address in a segment does not change the structure of the path', () => {
  const segments = (url: string) => new URL(url).pathname.split('/').length;

  it.each([
    ['https://x.test/a%2Fb@example.test/c', `https://x.test/a%2F${REDACTED}@example.test/c`],
    ['https://x.test/a%2fb@example.test', `https://x.test/a%2F${REDACTED}@example.test`],
    ['https://x.test/a%5Cb@example.test/c', `https://x.test/a%5C${REDACTED}@example.test/c`],
    ['https://x.test/a%2Fb%40example.test/c', `https://x.test/a%2F${REDACTED}@example.test/c`],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(segments(out)).toBe(segments(input));
    expect(sanitizeUrl(out)).toBe(out);
  });

  it('keeps the other escapes of the segment readable and stable', () => {
    const out = sanitizeUrl('https://x.test/%C3%BCber/m%C3%BCller@example.test/100%25');
    expect(out).toBe(`https://x.test/%C3%BCber/${REDACTED}@example.test/100%25`);
    expect(sanitizeUrl(out)).toBe(out);
  });
});

describe('sanitizeUrl: idempotent on encoded separators', () => {
  const pieces = [
    'a',
    'max',
    '@',
    'example.test',
    'k',
    'v',
    '1',
    '/',
    '=',
    ';',
    '&',
    ':',
    '\\',
    '%3D',
    '%3d',
    '%3B',
    '%3b',
    '%26',
    '%3A',
    '%3F',
    '%2F',
    '%5C',
    '%40',
    '%25',
    '%23',
    '%0A',
    '%C3%BC',
  ];

  // mulberry32: the same sequence on every run, no extra dependency
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('over combinations of the pieces in one path segment and in two', () => {
    const rnd = random(20261030);
    const pick = () => pieces[Math.floor(rnd() * pieces.length)];
    for (let i = 0; i < 20_000; i++) {
      const segment = () => Array.from({ length: 1 + Math.floor(rnd() * 8) }, pick).join('');
      const url = `https://x.test/${segment()}${rnd() < 0.3 ? `/${segment()}` : ''}`;
      const once = sanitizeUrl(url);
      expect(sanitizeUrl(once), `${url} -> ${once}`).toBe(once);
    }
  });
});
