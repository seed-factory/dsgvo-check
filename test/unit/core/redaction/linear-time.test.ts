import { expect, it } from 'vitest';
import { valueScrubber } from '../../../../src/collectors/browser/legal/scrub.ts';
import { sanitizeRequestUrl } from '../../../../src/collectors/browser/recording/features.ts';
import { storedCookieName, storedHeaderName } from '../../../../src/core/redaction/headers.ts';
import { isNameLike, redactCmpLabel, storedKey } from '../../../../src/core/redaction/page-names.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';

const SIZE = 64 * 1024;
const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));
const word = repeat('a');
const encodedAt = repeat('%40');
const tokenGroups = repeat('4f3a-');
const formattedWords = repeat('a\u200bb');
const secret = '4f3a9c1d2e7b4a9f';
const scrubber = valueScrubber([`sessionid=${secret}`, '1234567', 'uid:7654321'], ['example.test']);

const cases: Array<[string, string, (input: string) => unknown]> = [
  ['storage key with joined ID groups', tokenGroups, (s) => storedKey(s, s.length)],
  ['storage key with encoded address markers', encodedAt, (s) => storedKey(s, s.length)],
  ['storage key with format characters', formattedWords, (s) => storedKey(s, s.length)],
  ['storage key with an obfuscated address marker', `${word}(at)x`, (s) => storedKey(s, s.length)],
  ['storage key with punctuation between words', `a${repeat('.:/')}b`, (s) => storedKey(s, s.length)],
  ['header name with an encoded address marker', encodedAt, storedHeaderName],
  ['header name with fullwidth address markers', repeat('＠'), storedHeaderName],
  ['header name with a long candidate local part', `${word}@x`, storedHeaderName],
  ['header name with a long mixed-case token', repeat('aB'), storedHeaderName],
  ['cookie name with a delimiter after a long word', `${word};`, (s) => storedCookieName(s, s.length)],
  ['cookie name with a long candidate local part', `${word}@x`, (s) => storedCookieName(s, s.length)],
  ['cookie name with joined ID groups', tokenGroups, (s) => storedCookieName(s, s.length)],
  ['CMP label with format characters', formattedWords, redactCmpLabel],
  ['CMP label with punctuation between ID groups', repeat('(4f3a) | '), redactCmpLabel],
  ['page name with a long run of separators', `a${repeat('-_')}b`, (s) => isNameLike(s, s.length)],
  ['page name with a long mixed-case token', repeat('aB'), (s) => isNameLike(s, s.length)],
  [
    'allowlisted query value with a long mixed-case token',
    repeat('aB'),
    (s) => sanitizeUrl(`https://www.example.test/p?hl=${s}`),
  ],
  [
    'allowlisted query value with encoded address markers',
    encodedAt,
    (s) => sanitizeUrl(`https://www.example.test/p?hl=${s}`),
  ],
  [
    'request URL with a long allowlisted value',
    tokenGroups,
    (s) => sanitizeRequestUrl(`https://www.example.test/p?hl=${s}`),
  ],
  [
    'URL path with a long candidate local part',
    `${word}@x`,
    (s) => sanitizeUrl(`https://www.example.test/${s}/x`),
  ],
  ['URL path with encoded address markers', encodedAt, (s) => sanitizeUrl(`https://www.example.test/${s}/x`)],
  ['legal scrubber reading repeated matches', repeat(`${secret} `), scrubber],
  [
    'legal scrubber reading protected address spans',
    repeat(`${secret}@example.test `),
    scrubber.outsideAddresses,
  ],
  ['legal scrubber reading a long address candidate', `${word}@x`, scrubber.outsideAddresses],
  [
    'legal scrubber preparing a long value',
    tokenGroups,
    (s) => valueScrubber([s, `uid=${s}`], ['example.test']),
  ],
];

it.each(cases)('%s finishes within the budget', (_name, input, run) => {
  const times = Array.from({ length: 2 }, () => {
    const started = performance.now();
    run(input);
    return performance.now() - started;
  });
  expect(Math.min(...times)).toBeLessThan(500);
});
