import { describe, expect, it } from 'vitest';
import { valueScrubber } from '../../../../src/collectors/browser/legal/scrub.ts';
import { sanitizeRequestUrl } from '../../../../src/collectors/browser/recording/features.ts';
import { storedCookieName, storedHeaderName } from '../../../../src/core/redaction/headers.ts';
import { isNameLike, redactCmpLabel, storedKey } from '../../../../src/core/redaction/page-names.ts';
import { QUERY_ALLOWLIST, sanitizeUrl } from '../../../../src/core/url/url.ts';

const SIZE = 64 * 1024;

type Shape = (n: number) => string;
const repeated =
  (unit: string): Shape =>
  (n) =>
    unit.repeat(Math.ceil(n / unit.length));

const shapes: Array<[string, Shape]> = [
  ['a word run between separators', (n) => `_${'a'.repeat(n - 2)}_`],
  ['a word run before a non-axis marker', (n) => `${'a'.repeat(n - 2)}@x`],
  ...['.:/', '-_', '()[]{}<>', ',;|', '+=*~'].map((group): [string, Shape] => [
    `${JSON.stringify(group)} punctuation run`,
    (n) => `a${repeated(group)(n - 2)}b`,
  ]),
  ...['aB', 'a,', '%40', '(at)', '@', '＠', '4f3a-', 'a\u200bb'].map((unit): [string, Shape] => [
    `${JSON.stringify(unit)} repeated`,
    repeated(unit),
  ]),
];

interface Entry {
  name: string;
  run: (text: string) => unknown;
}

const secrets = ['sessionid=4f3a9c1d2e7b4a9f', '1234567', 'uid:7654321'];
const scrubber = valueScrubber(secrets, ['example.test']);

const entries: Entry[] = [
  { name: 'storedKey', run: (t) => storedKey(t, t.length) },
  { name: 'storedHeaderName', run: (t) => storedHeaderName(t) },
  { name: 'storedCookieName', run: (t) => storedCookieName(t, t.length) },
  { name: 'redactCmpLabel', run: (t) => redactCmpLabel(t) },
  { name: 'isNameLike', run: (t) => isNameLike(t, t.length) },
  ...[...QUERY_ALLOWLIST].map(
    (key): Entry => ({
      name: `sanitizeUrl ?${key}=`,
      run: (t) => sanitizeUrl(`https://www.example.test/p?${key}=${t}`),
    }),
  ),
  { name: 'sanitizeUrl path segment', run: (t) => sanitizeUrl(`https://www.example.test/${t}/x`) },
  ...[...QUERY_ALLOWLIST].map(
    (key): Entry => ({
      name: `sanitizeRequestUrl ?${key}=`,
      run: (t) => sanitizeRequestUrl(`https://fonts.example.test/css?${key}=${t}`),
    }),
  ),
  {
    name: 'sanitizeRequestUrl path segment',
    run: (t) => sanitizeRequestUrl(`https://www.example.test/${t}/x`),
  },
  { name: 'legal scrubber text', run: (t) => scrubber(t) },
  { name: 'legal scrubber text outside addresses', run: (t) => scrubber.outsideAddresses(t) },
  { name: 'legal scrubber built from a value', run: (t) => valueScrubber([t, `uid=${t}`], ['example.test']) },
];

describe('stored-value entry points finish within the budget on hostile shapes', () => {
  it.each(
    entries.flatMap((entry) => shapes.map(([name, shape]) => [entry.name, name, entry.run, shape] as const)),
  )('%s: %s', (_entryName, _name, run, shape) => {
    const input = shape(SIZE);
    const times = Array.from({ length: 2 }, () => {
      const started = performance.now();
      run(input);
      return performance.now() - started;
    });
    expect(Math.min(...times)).toBeLessThan(500);
  });
});
