/**
 * An e-mail address in a path segment is masked, also percent-encoded up to three rounds and next to invalid escapes or
 * another address; the path structure stays, repeated application changes nothing, the scan stays linear.
 */
import { describe, expect, it } from 'vitest';
import { redactText } from '../../../../src/core/redaction/redact.ts';
import { containsAddress, REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import { D, expectStable, MARK, random } from './redaction-helpers.ts';

function expectStableText(input: string): string {
  const once = redactText(input);
  expect(redactText(once), `redactText(redactText(${JSON.stringify(input)}))`).toBe(once);
  return once;
}

describe('e-mail addresses in a path segment', () => {
  it.each([
    [
      'https://www.lidl.example/c/impressum/shop@example.test',
      `https://www.lidl.example/c/impressum/${REDACTED}@example.test`,
    ],
    [
      'https://www.example.test/datenschutz/Kundenservice@Example.test',
      `https://www.example.test/datenschutz/${REDACTED}@example.test`,
    ],
    [
      'https://www.example.test/crawl-request@example.test',
      `https://www.example.test/${REDACTED}@example.test`,
    ],
    [
      // percent-encoded "@"
      'https://www.example.test/kontakt/info%40example.test',
      `https://www.example.test/kontakt/${REDACTED}@example.test`,
    ],
    [
      // a whole mailto: link of a web archive
      'https://web.archive.example/web/20240329064148/mailto:info@example.test',
      `https://web.archive.example/web/20240329064148/mailto:${REDACTED}@example.test`,
    ],
    [
      'https://web.archive.example/web/20240329064148/mailto%3Ainfo%40example.test',
      `https://web.archive.example/web/20240329064148/mailto:${REDACTED}@example.test`,
    ],
  ])('%s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/\b(?:shop|kundenservice|info|crawl-request)@/i);
  });

  it.each([
    [`https://${D}/first!last@${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/first%21last%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/r&d@${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%22alice.smith%22%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%22alice.smith%22@${D}`, `https://${D}/${REDACTED}@${D}`],
  ])('the whole local part goes, whatever characters it has: %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/first|alice|r&d/);
    // the same URL inside text
    expect(expectStableText(`Siehe ${input}.`)).toBe(`Siehe ${expected}.`);
  });

  // An address encoded once, twice or three times is masked; an invalid escape or a stray "%" next to it does not
  // hide it, and the other escapes of the segment stay as they were.
  it.each([
    [`https://${D}/alice%40${D}%ZZ`, `https://${D}/${REDACTED}@${D}%25ZZ`],
    [`https://${D}/alice%40${D}%E9`, `https://${D}/${REDACTED}@${D}%25E9`],
    [`https://${D}/alice%40${D}%`, `https://${D}/${REDACTED}@${D}%25`],
    [`https://${D}/alice%40${D}%4`, `https://${D}/${REDACTED}@${D}%254`],
    [`https://${D}/%ZZalice%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%E9alice%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/m%C3%BCller%ZZ%40${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/kontakt/alice%40${D}%ZZ/mehr`, `https://${D}/kontakt/${REDACTED}@${D}%25ZZ/mehr`],
    [`https://${D}/alice%40${D}%ZZ%E9%C3`, `https://${D}/${REDACTED}@${D}%25ZZ%25E9%25C3`],
    [`https://${D}/alice%40${D}%2520x`, `https://${D}/${REDACTED}@${D}%2520x`],
    [`https://${D}/%C3%BCber/m%C3%BCller%40${D}/100%25`, `https://${D}/%C3%BCber/${REDACTED}@${D}/100%25`],
    [
      'https://x.test/%C3%BCber/m%C3%BCller@example.test/100%25',
      `https://x.test/%C3%BCber/${REDACTED}@example.test/100%25`,
    ],
    [`https://${D}/alice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%2540${D}%ZZ`, `https://${D}/${REDACTED}@${D}%25ZZ`],
    [`https://${D}/alice%252540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%252540${D}%ZZ`, `https://${D}/${REDACTED}@${D}%25ZZ`],
    [`https://${D}/a/alice%2540${D}/b`, `https://${D}/a/${REDACTED}@${D}/b`],
    [`https://${D}/m%C3%BCller%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%2561lice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%2540${D.toUpperCase()}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/alice%2540${D}%2520x`, `https://${D}/${REDACTED}@${D}%20x`],
    [`https://${D}/%ZZalice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
    [`https://${D}/%E9alice%2540${D}`, `https://${D}/${REDACTED}@${D}`],
  ])('an encoded address: %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|%40|%2540|%61|[^\]]@/i);
    // the same URL inside text, and as part of a longer sentence
    expect(expectStableText(`Siehe ${input}.`)).toBe(`Siehe ${expected}.`);
  });

  it('the same URLs in text: in angle brackets and bare', () => {
    expect(redactText(`<https://${D}/alice%2540${D}%ZZ>`)).toBe(`<https://${D}/${REDACTED}@${D}%25ZZ>`);
    expect(redactText(`https://${D}/alice%252540${D}`)).toBe(`https://${D}/${REDACTED}@${D}`);
  });

  it('an address at the first level and another one after it at the second level', () => {
    const out = sanitizeUrl(`https://${D}/alice%40${D}%2540bob.invalid`);
    expect(out).not.toMatch(/alice/);
    expect(out).toBe(`https://${D}/${REDACTED}@${REDACTED}@bob.invalid`);
    expect(sanitizeUrl(out)).toBe(out);
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

  // A "/" is a border of the segment, also next to an address; %2F and %5C stay escaped and no segment is added.
  it.each([
    [`https://${D}/kontakt/first!last@${D}/mehr`, `https://${D}/kontakt/${REDACTED}@${D}/mehr`],
    ['https://x.test/a%2Fb@example.test/c', `https://x.test/a%2F${REDACTED}@example.test/c`],
    ['https://x.test/a%2fb@example.test', `https://x.test/a%2F${REDACTED}@example.test`],
    ['https://x.test/a%5Cb@example.test/c', `https://x.test/a%5C${REDACTED}@example.test/c`],
    ['https://x.test/a%2Fb%40example.test/c', `https://x.test/a%2F${REDACTED}@example.test/c`],
    [`https://${D}/a%2Fb%40${D}/c`, `https://${D}/a%2F${REDACTED}@${D}/c`],
    [`https://${D}/a%2Fb%40${D}%ZZ/c`, `https://${D}/a%2F${REDACTED}@${D}%25ZZ/c`],
    [`https://${D}/a%252Fb%2540${D}/c`, `https://${D}/a%2F${REDACTED}@${D}/c`],
    [`https://${D}/a%255Cb%2540${D}/c`, `https://${D}/a%5C${REDACTED}@${D}/c`],
    [`https://${D}/a%2Fb%2540${D}/c`, `https://${D}/a%2F${REDACTED}@${D}/c`],
    [`https://${D}/a%5Cb%2540${D}/c`, `https://${D}/a%5C${REDACTED}@${D}/c`],
    [`https://${D}/x%252F%252Fy%252540${D}`, `https://${D}/x%2F%2F${REDACTED}@${D}`],
  ])('keeps the structure of the path: %s', (input, expected) => {
    const out = expectStable(input);
    expect(out).toBe(expected);
    expect(out.split('/').length).toBe(input.split('/').length);
  });

  it.each([
    'https://de.wikipedia.example/wiki/Kategorie%3ADatenschutz',
    'https://x.test/a%3Bb/c%26d',
    'https://x.test/%C3%BCber%2Funs/',
    'https://x.test/a%2Fb/info%40',
    `https://${D}/100%ZZ`,
    `https://${D}/kontakt%E9/info`,
    `https://${D}/a%2Fb/info%40`,
    `https://${D}/%C3%BCber/uns`,
    `https://${D}/prozent%25ZZ`,
    `https://${D}/alice%2540`,
    `https://${D}/a%2540b`,
    `https://${D}/pkg%2540latest`,
    `https://${D}/logo%25402x.png`,
    `https://${D}/100%2525`,
    `https://${D}/prozent%2525ZZ`,
    `https://${D}/%25C3%25BCber/uns`,
    `https://${D}/%252F`,
    `https://${D}/%2540`,
    // the fourth round of encoding is text
    `https://${D}/alice%25252540${D}`,
    `https://${D}/a%2540b/c%2540d`,
    // double-encoded `;` and `=` are text where nothing reads them as syntax and no address is near
    'https://x.test/a%253Bb%253Dc',
    'https://x.test/activity%253Bdc_pre%253Dabc',
    'https://x.test/p%2526q',
  ])('counterexample: no address and no parameter, no change: %s', (url) => {
    expect(sanitizeUrl(url)).toBe(url);
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

  it('randomized: any mix of valid and invalid escapes around %40 is masked and stable', () => {
    const rnd = random(20261032);
    const pieces = ['a', 'b', '%ZZ', '%E9', '%C3', '%C3%BC', '%', '%4', '%25', '%2D', '%7E', '.', '_', '%21'];
    const pick = () => pieces[Math.floor(rnd() * pieces.length)];
    for (let i = 0; i < 4000; i++) {
      const before = Array.from({ length: Math.floor(rnd() * 4) }, pick).join('');
      const after = Array.from({ length: Math.floor(rnd() * 4) }, pick).join('');
      const url = `https://${D}/${MARK}${before}%40${D}${after}`;
      const out = expectStable(url);
      expect(out, url).not.toContain(MARK);
      expect(out, url).toContain(`${REDACTED}@${D}`);
    }
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

  it('randomized: idempotent over encoded separators in one path segment and in two', () => {
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
