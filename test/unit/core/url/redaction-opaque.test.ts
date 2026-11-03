/**
 * An e-mail address in the opaque part of a URL with another scheme (`foo:`, `sms:`, `javascript:` …) or in an opaque
 * host is masked; URLs of such schemes without an address stay as they were.
 */
import { describe, expect, it } from 'vitest';
import { storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import { redactText } from '../../../../src/core/redaction/redact.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { expectStable, M, MARK, random } from './redaction-helpers.ts';

describe('an address in the opaque part of a URL with another scheme is masked', () => {
  it.each([
    [`foo:alice@${M}`, `foo:${REDACTED}@${M}`],
    [`javascript:alert(1)alice@${M}`, `javascript:alert(1)${REDACTED}@${M}`],
    [`javascript:alert('alice@${M}')`, `javascript:alert(${REDACTED}@${M}')`],
    [`sms:alice@${M}`, `sms:${REDACTED}@${M}`],
    [`webcal:alice@${M}`, `webcal:${REDACTED}@${M}`],
    [`xmpp:alice@${M}`, `xmpp:${REDACTED}@${M}`],
    [`sip:alice@${M}`, `sip:${REDACTED}@${M}`],
    [`skype:alice@${M}?call`, `skype:${REDACTED}@${M}?call=${REDACTED}`],
    [`sms:alice@${M}?body=hi`, `sms:${REDACTED}@${M}?body=${REDACTED}`],
    // the scheme is lower-cased by the URL parser, the fragment is dropped
    [`FOO:alice@${M}`, `foo:${REDACTED}@${M}`],
    [`foo:alice@${M}#frag`, `foo:${REDACTED}@${M}`],
    [`foo:Alice.Smith+tag@${M.toUpperCase()}`, `foo:${REDACTED}@${M}`],
    [`foo:"alice smith"@${M}`, `foo:${REDACTED}@${M}`],
    [`foo:a/alice@${M}`, `foo:a/${REDACTED}@${M}`],
    // the opaque path of view-source: is a URL of its own
    [`view-source:https://x.test/alice@${M}`, `view-source:https://x.test/${REDACTED}@${M}`],
    // percent-encoded, up to three rounds (as in a path, a query and mailto)
    [`foo:alice%40${M}`, `foo:${REDACTED}@${M}`],
    [`foo:alice%2540${M}`, `foo:${REDACTED}@${M}`],
    [`foo:alice%252540${M}`, `foo:${REDACTED}@${M}`],
    [`sms:alice%40${M}`, `sms:${REDACTED}@${M}`],
    [`foo:m%C3%BCller%40${M}`, `foo:${REDACTED}@${M}`],
    [`foo:%61lice%40${M}%ZZ`, `foo:${REDACTED}@${M}%25ZZ`],
    // the structure of the URL does not change: no query, no fragment, no new segment appears
    [`foo:alice%40${M}%3Fx%3D1`, `foo:${REDACTED}@${M}%3Fx=1`],
    [`foo:alice%40${M}%23x`, `foo:${REDACTED}@${M}%23x`],
    [`foo:%2Falice@${M}`, `foo:%2F${REDACTED}@${M}`],
    [`foo:alice%40${M}%20`, `foo:${REDACTED}@${M}%20`],
    [`foo:a b@${M}`, `foo:a%20${REDACTED}@${M}`],
  ])('%s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|smith|müller/i);
  });

  it('the query of an opaque URL stays under the rules of the query', () => {
    expect(sanitizeUrl(`foo:alice@${M}?hl=de&x=1`)).toBe(`foo:${REDACTED}@${M}?hl=de&x=${REDACTED}`);
    expect(sanitizeUrl(`foo:p?hl=de%2Calice%40${M}`)).toBe(`foo:p?hl=${REDACTED}`);
  });

  describe('schemes with an authority: userinfo, query and path were already handled, and stay so', () => {
    it.each([
      ['ftp://user@host.test/f', 'ftp://host.test/f'],
      ['ftp://user:pw@host.test/dir/', 'ftp://host.test/dir/'],
      [`ftp://alice:secret@${M}/dir/`, `ftp://${M}/dir/`],
      ['git+ssh://git@host.test/org/repo.git', 'git+ssh://host.test/org/repo.git'],
      ['ssh://alice@host.test', 'ssh://host.test'],
      [`ssh://alice%40${M}@host.test/r`, 'ssh://host.test/r'],
      [`git+ssh://alice@${M}@host.test/r`, 'git+ssh://host.test/r'],
      ['ws://h.test/s?token=abc', `ws://h.test/s?token=${REDACTED}`],
      ['wss://h.test/x?hl=de&token=abc', `wss://h.test/x?hl=de&token=${REDACTED}`],
      [`wss://h.test/x?email=alice%40${M}`, `wss://h.test/x?email=${REDACTED}`],
      [`wss://h.test/x?hl=de%2Calice%40${M}`, `wss://h.test/x?hl=${REDACTED}`],
      [`ftp://h.test/alice@${M}/f`, `ftp://h.test/${REDACTED}@${M}/f`],
      [`ftp://h.test/alice%40${M}/f`, `ftp://h.test/${REDACTED}@${M}/f`],
      [`foo://h.test/p?alice@${M}`, `foo://h.test/p?${REDACTED}=${REDACTED}`],
      [`foo://h.test/p?a=b#alice@${M}`, `foo://h.test/p?a=${REDACTED}`],
      [`intent://x.test/#Intent;scheme=https;S.email=alice@${M};end`, 'intent://x.test/'],
      [`data:text/plain,alice@${M}`, `data:${REDACTED}`],
    ])('%s', (input, expected) => {
      expect(expectStable(input)).toBe(expected);
    });
  });

  describe('the host of a scheme without a special host is opaque and may hold an encoded address', () => {
    // there is no place for an address in the host: the URL is reduced to its scheme, like data: and blob:
    it.each([
      `foo://alice%40${M}/p`,
      `foo://alice%40${M}:80/p`,
      `foo://alice%2540${M}/p?hl=de`,
      `foo://alice%252540${M}`,
      `foo://alice%40${M}`,
    ])('%s', (input) => {
      const out = expectStable(input);
      expect(out).toBe(`foo:${REDACTED}`);
    });

    it.each([
      'foo://h.test/p',
      'foo://h%2Dtest/p',
      'foo://100%25/p',
      'foo://h.test:8080/p',
      'foo://%C3%BCber.test/p',
    ])('without an address: %s is unchanged', (input) => {
      expect(sanitizeUrl(input)).toBe(input);
    });
  });

  it('the path of a scheme without a special host is a path too', () => {
    expect(sanitizeUrl(`foo://h.test/alice%2540${M}/f`)).toBe(`foo://h.test/${REDACTED}@${M}/f`);
    expect(sanitizeUrl(`wss://h.test/a/alice%252540${M}`)).toBe(`wss://h.test/a/${REDACTED}@${M}`);
  });

  it.each([
    'tel:+4930123456',
    'tel:+4930123456;ext=1',
    'about:blank',
    'javascript:void(0)',
    'javascript:window.open(this.href)',
    'urn:isbn:1234',
    'urn:uuid:123e4567-e89b-12d3-a456-426614174000',
    'geo:48.1,11.5',
    'foo:bar',
    'foo:100%25',
    'foo:a%ZZb',
    'foo:%C3%BCber',
    'foo:version@3.7.1',
    'foo:logo@2x.png',
    'foo:a/b/c',
    'foo:a%2Fb',
    'view-source:https://x.test/p',
    'file:///c/readme.txt',
    'foo:%2540',
    'foo:alice%25252540example.invalid',
  ])('counterexample: no address, no change: %s', (input) => {
    expect(sanitizeUrl(input)).toBe(input);
  });

  it('the way into the snapshot: Location, Refresh and Link carry such a value through sanitizeUrl', () => {
    const base = 'https://shop.example.test/';
    const stored = (name: string, value: string) => storedHeaderRecord(name, value, base, sanitizeUrl).value;
    expect(stored('location', `foo:alice@${M}`)).toBe(`foo:${REDACTED}@${M}`);
    expect(stored('location', `javascript:alert(1)alice@${M}`)).toBe(`javascript:alert(1)${REDACTED}@${M}`);
    expect(stored('refresh', `0; url=sms:alice%40${M}`)).toBe(`0; url=sms:${REDACTED}@${M}`);
    expect(stored('refresh', `5;URL='webcal:alice@${M}'`)).toBe(`5; url=webcal:${REDACTED}@${M}`);
    expect(stored('link', `<xmpp:alice@${M}>; rel="alternate"`)).toBe(
      `<xmpp:${REDACTED}@${M}>; rel="alternate"`,
    );
    // a relative target resolves to a path of the page: the path is masked, also when the address is encoded twice
    expect(stored('location', `/alice%2540${M}`)).toBe(`https://shop.example.test/${REDACTED}@${M}`);
  });

  it('redactText: an address in a URL with another scheme is masked in text, as before', () => {
    expect(redactText(`Siehe foo:alice@${M}.`)).toBe(`Siehe foo:${REDACTED}@${M}.`);
    expect(redactText(`Link: javascript:alert(1)alice@${M}`)).toBe(
      `Link: javascript:alert(1)${REDACTED}@${M}`,
    );
    expect(redactText(`ftp://h.test/alice@${M}/f`)).not.toContain('alice');
    expect(redactText('Hotline: tel:+4930123456')).toBe('Hotline: tel:+4930123456');
  });

  it('randomized: any mix of pieces after a scheme is stable and keeps no address', () => {
    const rnd = random(20261103);
    const pieces = [
      'a',
      'b',
      'x.test',
      '.',
      '-',
      '/',
      '\\',
      '?',
      '#',
      '=',
      '&',
      ';',
      ':',
      ' ',
      '(',
      ')',
      "'",
      '"',
      '%',
      '%ZZ',
      '%E9',
      '%C3%BC',
      '%25',
      '%2F',
      '%3F',
      '%23',
      '%20',
      '%40',
      '%2540',
      '[redacted]',
      '😀',
      '@',
      `${MARK}@x.test`,
      `${MARK}%40x.test`,
      `${MARK}%2540x.test`,
      `${MARK}%252540x.test`,
      `"${MARK}"@x.test`,
    ];
    const pick = () => pieces[Math.floor(rnd() * pieces.length)] as string;
    // not `foo://` + pieces: a host made of pieces is often no host, and an unparsable URL that ends in a blank is
    // not stable because the next parse removes the trailing blank
    const schemes = ['foo:', 'javascript:', 'sms:', 'x-y+z.w:', 'foo://h.test/', 'ws://h.test/'];
    for (let i = 0; i < 40_000; i++) {
      const scheme = schemes[Math.floor(rnd() * schemes.length)] as string;
      const body = Array.from({ length: 1 + Math.floor(rnd() * 8) }, pick).join('');
      const url = scheme + body;
      const out = expectStable(url);
      // The local part of a mask is at most 64 characters (RFC 5321): a longer run of local-part characters in front of
      // an "@" is masked in its last 64 only, in a path as in free text. A body of up to 60 characters has no such run.
      if (body.length <= 60) expect(out, JSON.stringify(url)).not.toContain(MARK);
    }
  });
});
