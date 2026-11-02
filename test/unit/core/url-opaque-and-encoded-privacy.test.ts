/** URL sanitization redacts addresses in opaque schemes and in repeatedly encoded path segments.
 * Scheme authority, path structure, controls and idempotence are checked with synthetic inputs. */
import { describe, expect, it } from 'vitest';
import { storedHeaderRecord } from '../../../src/core/headers.ts';
import { redactText } from '../../../src/core/redact.ts';
import { containsAddress, REDACTED, redactTarget, sanitizeUrl } from '../../../src/core/url.ts';

const M = 'mail.invalid';
const D = 'example.invalid';
const MARK = 'zq7marker';

/** mulberry32: the same sequence on every run, no extra dependency. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The output of the first pass is a fixed point. */
function expectStable(input: string): string {
  const once = sanitizeUrl(input);
  expect(sanitizeUrl(once), `sanitizeUrl(sanitizeUrl(${JSON.stringify(input)}))`).toBe(once);
  return once;
}

/**
 * Ordinary forms that carry no address at any level. `expected` is what `sanitizeUrl` returned before (recorded
 * from the old function): the three changes must not touch them.
 */
describe('ordinary URLs without addresses retain their meaning', () => {
  const SHOP = 'https://shop.example.test';
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
    ['https://unpkg.com/@scope/pkg@1.2.3/dist/x.js', 'https://unpkg.com/@scope/pkg@1.2.3/dist/x.js'],
    ['https://cdn.example.test/img/logo@2x.png', 'https://cdn.example.test/img/logo@2x.png'],
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
    ['mailto:info@example.test', `mailto:${REDACTED}@example.test`],
    ['mailto:info@example.test?subject=Hallo', `mailto:${REDACTED}@example.test`],
    ['foo:bar', 'foo:bar'],
    ['foo:version@3.7.1', 'foo:version@3.7.1'],
    ['foo:a/b/c', 'foo:a/b/c'],
    ['foo://h.test/a/b?hl=de', 'foo://h.test/a/b?hl=de'],
  ])('%s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
    expect(sanitizeUrl(expected)).toBe(expected);
  });
});

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
      ['blob:https://x.test/0f4a', `blob:${REDACTED}`],
      [`mailto:alice@${M}?subject=x`, `mailto:${REDACTED}@${M}`],
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

  describe('counterexamples: no address, no change', () => {
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
    ])('%s', (input) => {
      expect(sanitizeUrl(input)).toBe(input);
    });
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

describe('an address encoded two or three times in a path segment is masked', () => {
  it.each([
    [`https://${D}/alice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%2540${D}%ZZ`, `https://${D}/${REDACTED}@${D}%25ZZ`],
    [`https://${D}/alice%252540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%252540${D}%ZZ`, `https://${D}/${REDACTED}@${D}%25ZZ`],
    [`https://${D}/a/alice%2540${D}/b`, `https://${D}/a/${REDACTED}@${D}/b`],
    [`https://${D}/m%C3%BCller%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%2561lice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%2540${D.toUpperCase()}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%2540${D}%2520x`, `https://${D}/${REDACTED}@${D}%20x`],
    // an invalid escape or a stray percent sign next to the encoded address does not hide it
    [`https://${D}/%ZZalice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%E9alice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
  ])('%s', (input, expected) => {
    const out = sanitizeUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|%40|%2540|%61/i);
    expect(sanitizeUrl(out)).toBe(out);
  });

  it('an address at the first level and another one after it at the second level', () => {
    const out = sanitizeUrl(`https://${D}/alice%40${D}%2540bob.invalid`);
    expect(out).not.toMatch(/alice/);
    expect(out).toBe(`https://${D}/${REDACTED}@${REDACTED}@bob.invalid`);
    expect(sanitizeUrl(out)).toBe(out);
  });

  it('the same URLs in text (a link text, a Location header in a log)', () => {
    expect(redactText(`Siehe https://${D}/alice%2540${D}.`)).toBe(`Siehe https://${D}/${REDACTED}@${D}.`);
    expect(redactText(`<https://${D}/alice%2540${D}%ZZ>`)).toBe(`<https://${D}/${REDACTED}@${D}%25ZZ>`);
    expect(redactText(`https://${D}/alice%252540${D}`)).toBe(`https://${D}/${REDACTED}@${D}`);
  });

  it('sees what containsAddress sees: an address after at most three rounds of decoding', () => {
    for (const encoded of [`alice%40${D}`, `alice%2540${D}`, `alice%252540${D}`, `alice%25252540${D}`]) {
      const url = `https://x.test/${encoded}`;
      expect(sanitizeUrl(url) !== url, encoded).toBe(containsAddress(encoded));
    }
    // the fourth round is text, as in containsAddress and in hasAddress of mailto:
    expect(containsAddress(`alice%25252540${D}`)).toBe(false);
    // the query is decoded once by the URL parser before containsAddress looks: one level more is masked there
    expect(sanitizeUrl(`https://x.test/p?hl=alice%25252540${D}`)).toBe(`https://x.test/p?hl=${REDACTED}`);
    // mailto: masks every recipient, whatever it looks like
    expect(redactText(`mailto:alice%252540${D}`)).toBe('mailto:[redacted]');
  });

  it('keeps the structure of the path: %2F and %5C stay escaped, no segment is added', () => {
    for (const input of [
      `https://${D}/a%252Fb%2540${D}/c`,
      `https://${D}/a%255Cb%2540${D}/c`,
      `https://${D}/a%2Fb%2540${D}/c`,
      `https://${D}/a%5Cb%2540${D}/c`,
      `https://${D}/x%252F%252Fy%252540${D}`,
    ]) {
      const out = sanitizeUrl(input);
      expect(out.split('/').length, input).toBe(input.split('/').length);
      expect(out, input).not.toMatch(/alice|%40|%2540/);
      expect(out, input).toContain(`${REDACTED}@${D}`);
      expect(sanitizeUrl(out), input).toBe(out);
    }
    expect(sanitizeUrl(`https://${D}/a%252Fb%2540${D}/c`)).toBe(`https://${D}/a%2F${REDACTED}@${D}/c`);
    expect(sanitizeUrl(`https://${D}/a%255Cb%2540${D}/c`)).toBe(`https://${D}/a%5C${REDACTED}@${D}/c`);
  });

  describe('counterexamples: no address visible after three rounds, no change', () => {
    it.each([
      `https://${D}/alice%2540`,
      `https://${D}/a%2540b`,
      `https://${D}/pkg%2540latest`,
      `https://${D}/logo%25402x.png`,
      `https://${D}/100%2525`,
      `https://${D}/prozent%2525ZZ`,
      `https://${D}/%25C3%25BCber/uns`,
      `https://${D}/%252F`,
      `https://${D}/%2540`,
      `https://${D}/alice%25252540${D}`,
      `https://${D}/a%2540b/c%2540d`,
      `https://${D}/%C3%BCber/uns`,
      `https://${D}/a%2Fb/info%40`,
    ])('%s', (url) => {
      expect(sanitizeUrl(url)).toBe(url);
    });
  });

  it('a single-encoded address with an encoded rest behaves as before', () => {
    expect(sanitizeUrl(`https://${D}/alice%40${D}%2520x`)).toBe(`https://${D}/${REDACTED}@${D}%2520x`);
    expect(sanitizeUrl(`https://${D}/%C3%BCber/m%C3%BCller%40${D}/100%25`)).toBe(
      `https://${D}/%C3%BCber/${REDACTED}@${D}/100%25`,
    );
  });

  describe('nested levels: an address at every level of encoding', () => {
    // level 0: %40; level k: % followed by k times 25 and 40
    const level = (k: number) => (k === 0 ? '%40' : `%${'25'.repeat(k)}40`);
    const nested = (n: number) => Array.from({ length: n }, (_, k) => `u${k}${level(k)}d${k}.test`).join('');

    it.each([1, 2, 3, 4])('%i levels: every address is masked, the second pass changes nothing', (n) => {
      const out = sanitizeUrl(`https://${D}/${nested(n)}`);
      expect(out).not.toMatch(/u\d/);
      expect(out).toContain(`${REDACTED}@`);
      expect(sanitizeUrl(out)).toBe(out);
    });

    it.each([5, 6, 9])('%i levels: deeper than the passes follow, the segment is replaced', (n) => {
      const out = sanitizeUrl(`https://${D}/a/${nested(n)}/b`);
      expect(out).toBe(`https://${D}/a/${REDACTED}/b`);
      expect(sanitizeUrl(out)).toBe(out);
    });

    it('in an opaque path as well', () => {
      expect(sanitizeUrl(`foo:${nested(6)}`)).toBe(`foo:${REDACTED}`);
    });
  });

  it('the path of a scheme without a special host is a path too', () => {
    expect(sanitizeUrl(`foo://h.test/alice%2540${M}/f`)).toBe(`foo://h.test/${REDACTED}@${M}/f`);
    expect(sanitizeUrl(`wss://h.test/a/alice%252540${M}`)).toBe(`wss://h.test/a/${REDACTED}@${M}`);
  });

  it('masks an address visible after repeated decoding: %2540 is %40 is "@"', () => {
    expect(sanitizeUrl(`https://${D}/alice%2540${D}`)).toBe(`https://${D}/${REDACTED}@${D}`);
  });

  describe('a URL that does not parse is masked the same way (path pieces and host)', () => {
    it.each([
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
      'https://exa mple.test/p',
      'https://exa mple.test/100%25/%C3%BCber',
      `https://exa mple.test/${REDACTED}@${M}`,
    ])('without an address: %s', (input) => {
      expect(sanitizeUrl(input)).toBe(input);
    });
  });

  it('randomized: sanitizeUrl is stable, and what containsAddress sees in a segment is masked', () => {
    const rnd = random(20261104);
    const pieces = [
      'a',
      'b',
      'x.test',
      '.',
      '-',
      '_',
      '%',
      '%ZZ',
      '%E9',
      '%C3%BC',
      '%25',
      '%2F',
      '%5C',
      '%3D',
      '%3B',
      '%253D',
      '%253B',
      '%2526',
      '%253A',
      '%40',
      '%2540',
      '%252540',
      '@',
      ';',
      '=',
      '[redacted]',
      `${MARK}@x.test`,
      `${MARK}%40x.test`,
      `${MARK}%2540x.test`,
      `${MARK}%252540x.test`,
    ];
    const pick = () => pieces[Math.floor(rnd() * pieces.length)] as string;
    for (let i = 0; i < 60_000; i++) {
      const segment = Array.from({ length: 1 + Math.floor(rnd() * 8) }, pick).join('');
      const url = `https://x.test/${segment}`;
      const out = expectStable(url);
      // a run of more than 64 local-part characters is masked in its last 64 only (as in free text)
      if (segment.length <= 60) expect(out, JSON.stringify(url)).not.toContain(MARK);
    }
  });

  describe('the scan stays linear', () => {
    const n = 100_000;
    const budgetMs = 1500;
    const inputs: Array<[string, string]> = [
      ['a long segment of doubly encoded addresses', `https://${D}/${'a%2540b.test'.repeat(n / 12)}`],
      ['a long chain of nested levels', `https://${D}/${'a@b.test%25'.repeat(n / 10)}`],
      ['percent signs and "@"', `https://${D}/${'%25@'.repeat(n / 3)}`],
      ['many segments with an encoded address', `https://${D}/${'a%2540b.test/'.repeat(n / 13)}`],
      ['one address, then a long rest', `https://${D}/alice%2540${D}${'%2520'.repeat(n / 5)}`],
      ['nested escapes', `https://${D}/${'%25'.repeat(n / 3)}40${D}`],
      ['an opaque path', `foo:${'a%2540b.test'.repeat(n / 12)}`],
      ['an opaque path with slashes', `foo:${'a%2540b.test/'.repeat(n / 13)}`],
    ];

    it.each(inputs)('%s', (_name, input) => {
      const started = performance.now();
      const once = sanitizeUrl(input);
      sanitizeUrl(once);
      expect(performance.now() - started).toBeLessThan(budgetMs);
    });
  });
});

describe('what the rewrite writes back is a fixed point and keeps no part of an address', () => {
  describe('path-parameter syntax that comes out of a deeper round of decoding', () => {
    it.each([
      [`https://x.test/alice%2540${D}%253Bord%253D123`, `https://x.test/${REDACTED}@${D};ord=${REDACTED}`],
      [`https://x.test/u/user%253Dalice%2540${D}`, `https://x.test/u/user=${REDACTED}`],
      [
        `https://x.test/activity%253Bdc_pre%253Dabc%253Balice%2540${D}`,
        `https://x.test/activity;dc_pre=${REDACTED};${REDACTED}@${D}`,
      ],
      [`https://x.test/a%2526b%253Dc%2540${D}`, `https://x.test/a&b=${REDACTED}`],
      [`https://x.test/p%253Ak%253Dv%2540${D}`, `https://x.test/p:k=${REDACTED}`],
    ])('%s', (input, expected) => {
      const out = expectStable(input);
      expect(out).toBe(expected);
      expect(out).not.toMatch(/alice|ord=123|=abc|=c|=v/);
    });

    it('counterexamples: the same syntax without an address is as before', () => {
      // double-encoded `;` and `=` are text where nothing reads them as syntax and no address is near
      for (const url of [
        'https://x.test/a%253Bb%253Dc',
        'https://x.test/activity%253Bdc_pre%253Dabc',
        'https://x.test/p%2526q',
      ]) {
        expect(sanitizeUrl(url), url).toBe(url);
      }
    });
  });

  describe('two addresses in one segment, the later one encoded deeper than the dot of the first', () => {
    it.each([
      `https://x.test/${MARK}alice%40a%25252Einvalid-${MARK}bob%2540b.invalid`,
      `https://x.test/${MARK}alice%40a%252Einvalid-${MARK}bob%2540b.invalid`,
      `https://x.test/${MARK}alice@a%2Einvalid-${MARK}bob%40b.invalid`,
      `https://x.test/${MARK}alice%40a%25252Einvalid.${MARK}bob%2540b.invalid`,
    ])('%s', (input) => {
      const out = expectStable(input);
      expect(out).not.toContain(MARK);
      expect(out).toContain(`${REDACTED}@`);
    });

    it('three addresses of different depth: no local part survives, the masks stand in a row', () => {
      const out = expectStable(`sms:${MARK}0@a%25252Etest.${MARK}1@a%252Etest.${MARK}2@mail.test`);
      expect(out).toBe(`sms:${REDACTED}@${REDACTED}@${REDACTED}@mail.test`);
      expect(sanitizeUrl(`https://x.test/alice%40a%25252Einvalid-bob%2540b.invalid`)).toBe(
        `https://x.test/${REDACTED}@${REDACTED}@b.invalid`,
      );
    });

    it('counterexample: a mask with nothing behind it is no orphan marker, the text stays', () => {
      const url = 'https://x.test/a%252540[redacted]%2540';
      expect(sanitizeUrl(url)).toBe(url);
    });

    it('counterexample: one address next to a handle is as before', () => {
      expect(sanitizeUrl('https://social.example.test/@user@mastodon.invalid/post')).toBe(
        `https://social.example.test/@${REDACTED}@mastodon.invalid/post`,
      );
    });

    it('randomized: of two addresses in a segment, neither local part survives', () => {
      const rnd = random(20261105);
      // the `@` and the dot of an address, written at a level of encoding from 0 to 3
      const at = ['@', '%40', '%2540', '%252540'];
      const dot = ['.', '%2E', '%252E', '%25252E'];
      const glue = ['-', '.', '', '_', '%2D', '%252D'];
      const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)] as T;
      const address = (name: string) =>
        `${MARK}${name}${pick(at)}${pick(['a', 'b', 'ab'])}${pick(dot)}${pick(['invalid', 'test'])}`;
      for (let i = 0; i < 40_000; i++) {
        const x = address('x');
        const y = address('y');
        const segment = `${x}${pick(glue)}${y}`;
        const out = expectStable(`https://x.test/${segment}`);
        // an address that is not visible in at most three rounds of decoding is text and may stay
        if (containsAddress(x) && containsAddress(y)) {
          expect(out, `${segment} -> ${out}`).not.toContain(MARK);
        }
      }
    });
  });

  describe('a URL that does not parse, and the characters the parser removes', () => {
    it.each([
      [`\thttp://[alice%40${M}/p`, `http:${REDACTED}`],
      [` ssh://[x=alice%40${M}/p`, `ssh:${REDACTED}`],
      [`ht\ttp://[alice%40${M}/p`, `http:${REDACTED}`],
      [`http://[alice%40${M}/p\n`, `http:${REDACTED}`],
      [`\u0001\u0002 http://[alice%40${M}/p`, `http:${REDACTED}`],
      [`\n/alice%40${M}/p`, `/${REDACTED}@${M}/p`],
    ])('%j', (input, expected) => {
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

    it('counterexample: without an address the string is kept as it was', () => {
      for (const url of ['https://exa mple.test/p', '/relative/path', 'https://exa mple.test/a%20b']) {
        expect(sanitizeUrl(url), url).toBe(url);
      }
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

  describe('redactText: a path segment in front of a dot segment is an address too', () => {
    it.each([
      [`https://x.test/alice%40${D}/../p`, 'https://x.test/p'],
      [`https://x.test/alice%2540${D}/../p`, 'https://x.test/p'],
      [`https://x.test/alice%252540${D}/%2e%2e/p`, 'https://x.test/p'],
      [`https://x.test/alice%40${D}/./p`, `https://x.test/${REDACTED}@${D}/p`],
      ['https://x.test/a;ord=1234567/../p', 'https://x.test/p'],
      [`https://x.test/x/alice%40${D}\\..\\p`, 'https://x.test/x/p'],
    ])('%s', (url, expected) => {
      expect(redactText(`Siehe ${url} Ende`)).toBe(`Siehe ${expected} Ende`);
      expect(redactText(expected)).toBe(expected);
    });

    it('with trailing punctuation and in brackets', () => {
      expect(redactText(`(https://x.test/alice%2540${D}/../p).`)).toBe('(https://x.test/p).');
    });

    it.each([
      'https://x.test/.well-known/security.txt',
      'https://x.test/a/.hidden/b',
      'https://x.test/a/..b/c',
      'https://x.test/a/b.../c',
      'https://x.test/a/b/c.html',
      'https://x.test/',
    ])('counterexample: no dot segment, the text stays as written: %s', (url) => {
      expect(redactText(`Siehe ${url}`)).toBe(`Siehe ${url}`);
    });
  });
});
