/** A URL that does not parse is masked like one that does; decoded pieces are written back without raw control characters. */
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { redactTarget, sanitizeUrl } from '../../../../src/core/url/url.ts';
import { expectStable, M, MARK } from './redaction-helpers.ts';

describe('a URL that does not parse is masked the same way', () => {
  it.each([
    [
      'https://exa mple.test/info@example.test?x=1',
      `https://exa mple.test/${REDACTED}@example.test?${REDACTED}`,
    ],
    [`https://exa mple.test/alice%40${M}`, `https://exa mple.test/${REDACTED}@${M}`],
    [`https://exa mple.test/alice%2540${M}`, `https://exa mple.test/${REDACTED}@${M}`],
    [`https://exa mple.test/a/alice%252540${M}/b`, `https://exa mple.test/a/${REDACTED}@${M}/b`],
    [`https://exa mple.test/alice@${M}?x=1#f`, `https://exa mple.test/${REDACTED}@${M}?${REDACTED}`],
    [`https://exa mple.test/alice%40${M}?x=1#f`, `https://exa mple.test/${REDACTED}@${M}?${REDACTED}`],
    // an encoded address in the host part has no place to go: the URL is reduced to its scheme
    [`http://alice%40${M}/`, `http:${REDACTED}`],
    [`http://alice%2540${M}/p`, `http:${REDACTED}`],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(sanitizeUrl(out)).toBe(out);
    expect(redactTarget(input)).toBe(expected);
  });

  // Decoded pieces must not become a query, fragment or userinfo on the next pass, or adjoin an escape that the
  // bare-address mask could mistake for a local part.
  it.each([
    `https://exa mple.test/%5C%5Ck=vzq7%40${M}_%3F%25`,
    `https://exa mple.test/%23%3F%3Fv=2-%ZZzq7%40${M}#`,
    `https://exa mple.test/%20😀id=G-ABCzq7%252540${M}%2F%40${M}`,
    `https://exa mple.test/zq7%40${M}'\\@${M}mailto:zq7@${M}%3B😀`,
    `https://exa mple.test/%5C%40bmail.testv=2:zq7%40${M}`,
    `http:///zq7%252540${M}`,
    `foo://%3B%20[redacted]\\[redacted]k=v%40x.test`,
    `http://%2540"\\%2Fzq7%2540${M}id=G-ABC`,
  ])('stays stable on the second pass: %s', (input) => {
    const out = sanitizeUrl(input);
    expect(sanitizeUrl(out)).toBe(out);
    expect(out).not.toContain(MARK);
  });

  it.each([
    [`\thttp://[alice%40${M}/p`, `http:${REDACTED}`],
    [` ssh://[x=alice%40${M}/p`, `ssh:${REDACTED}`],
    [`ht\ttp://[alice%40${M}/p`, `http:${REDACTED}`],
    [`http://[alice%40${M}/p\n`, `http:${REDACTED}`],
    [`\u0001\u0002 http://[alice%40${M}/p`, `http:${REDACTED}`],
    [`\n/alice%40${M}/p`, `/${REDACTED}@${M}/p`],
  ])('the characters the parser removes: %j', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(redactTarget(input)).not.toMatch(/alice/);
  });

  it('a URL reduced to its scheme is one the next pass reads the same way (file: has a path of its own)', () => {
    for (const url of [`file://%C3%BC~%2540x.test?%252540v=2`, `file://alice%40${M}/p`]) {
      expect(expectStable(url), url).toBe(`file:///${REDACTED}`);
    }
  });

  it('a blank in front of the fragment: what is left is read as a URL, now and on the next pass', () => {
    expect(expectStable('https://x.test #_')).toBe('https://x.test/');
    expect(expectStable('https://x.test/p?x=1 #f')).toBe(`https://x.test/p?x=${REDACTED}`);
  });

  it.each([
    'https://exa mple.test/p',
    'https://exa mple.test/100%25/%C3%BCber',
    `https://exa mple.test/${REDACTED}@${M}`,
    'https://exa mple.test/a%20b',
    '/relative/path',
  ])('counterexample: without an address the string is kept as it was: %s', (input) => {
    expect(sanitizeUrl(input)).toBe(input);
  });
});

describe('a decoded piece is written back without raw control characters', () => {
  const RAW = /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

  it.each([
    [`/alice%40${M}%0AX%1B%5B31m`, `/${REDACTED}@${M}%0AX%1B[31m`],
    [
      `http://exa mple.test/alice%40${M}%0D%0AX%E2%80%A8Y%00Z`,
      `http://exa mple.test/${REDACTED}@${M}%0D%0AX%E2%80%A8Y%00Z`,
    ],
    [`/alice%40${M}%E2%80%AEevil`, `/${REDACTED}@${M}%E2%80%AEevil`],
    [`/alice%2540${M}%250AX`, `/${REDACTED}@${M}%0AX`],
  ])('%s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(RAW);
    expect(out).not.toMatch(/alice/);
  });

  it('the opaque path and the parsed path keep their own escaping', () => {
    for (const url of [
      `foo:alice%40${M}%0AX`,
      `https://x.test/alice%40${M}%0AX`,
      `https://x.test/alice%2540${M}%250AX`,
    ]) {
      const out = expectStable(url);
      expect(out, url).not.toMatch(RAW);
      expect(out, url).not.toMatch(/alice/);
    }
  });
});
