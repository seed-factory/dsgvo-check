/**
 * The HTTP collector stores only the Referrer-Policy keywords of `<meta name="referrer">`, at most the last eight.
 * HDR-01 needs the last recognized keyword. Keeping unrelated tokens from an arbitrarily long, untrusted tag
 * would enlarge the snapshot without adding a policy fact.
 */
import { describe, expect, it } from 'vitest';
import { effectiveReferrerPolicy } from '../../../../src/checks/http/hdr-01.ts';
import { storedMetaReferrer } from '../../../../src/collectors/http/index.ts';

/** Referrer Policy §3 (W3C); the empty string is the "no policy" value and no keyword. */
const KEYWORDS = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
] as const;
/** Values of the old `<meta name="referrer">` syntax: HDR-01 does not read them, so they are not stored. */
const LEGACY = ['never', 'default', 'always', 'origin-when-crossorigin'] as const;

describe('only Referrer-Policy keywords are stored, and few of them', () => {
  it('64 KiB of tokens that are no keyword store nothing', () => {
    const content = 'a,'.repeat(32 * 1024);
    expect(content.length).toBe(64 * 1024);
    expect(storedMetaReferrer(content)).toBeNull();
  });

  it('64 KiB of one long token that is no keyword store nothing', () => {
    expect(storedMetaReferrer('x'.repeat(64 * 1024))).toBeNull();
    expect(storedMetaReferrer(`${'x-'.repeat(32 * 1024)}`)).toBeNull();
  });

  it('64 KiB of a keyword repeated keeps the last eight at most', () => {
    const stored = storedMetaReferrer('no-referrer,'.repeat(5461));
    expect(stored).toBe(Array(8).fill('no-referrer').join(', '));
  });

  it('the policy in force survives the cut: the last recognised keyword is kept', () => {
    const noise = KEYWORDS.map((k) => `${k},`).join('');
    const content = `${noise.repeat(1000)}unsafe-url, junk, origin`;
    const stored = storedMetaReferrer(content);
    expect(stored?.split(', ').length).toBe(8);
    expect(effectiveReferrerPolicy([stored as string])).toBe('origin');
    expect(effectiveReferrerPolicy([stored as string])).toBe(effectiveReferrerPolicy([content]));
  });

  it('unknown tokens are dropped, the keywords around them stay in order', () => {
    expect(storedMetaReferrer('foo, no-referrer, bar, unsafe-url, zq7bob@mail.invalid')).toBe(
      'no-referrer, unsafe-url',
    );
    expect(storedMetaReferrer('a, b, c')).toBeNull();
  });

  it.each(LEGACY)('the legacy value %s is no stored keyword (HDR-01 does not read it either)', (legacy) => {
    expect(storedMetaReferrer(legacy)).toBeNull();
    expect(storedMetaReferrer(`${legacy}, origin`)).toBe('origin');
    expect(effectiveReferrerPolicy([legacy])).toBeNull();
  });

  it('the stored size is bounded whatever the tag says', () => {
    const longest = 'strict-origin-when-cross-origin';
    const worst = storedMetaReferrer(`${longest},`.repeat(10_000)) as string;
    expect(worst.length).toBe(8 * longest.length + 7 * ', '.length);
    expect(worst.length).toBeLessThan(300);
  });

  it('the keyword list is the one HDR-01 recognises (drift guard)', () => {
    for (const keyword of [...KEYWORDS, ...LEGACY, '', 'a', 'unsafe_url', 'no-referrer ', 'origin;']) {
      const recognised = effectiveReferrerPolicy([keyword]) !== null;
      expect(storedMetaReferrer(keyword) !== null, JSON.stringify(keyword)).toBe(recognised);
    }
  });

  it('what HDR-01 takes from the stored value is what it took from the tag, for every mix of tokens', () => {
    const pool = [...KEYWORDS, ...LEGACY, 'junk', 'ORIGIN', 'Same-Origin', '', ' ', 'x@y.invalid', 'a-b-c'];
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 20_000; i++) {
      const count = 1 + Math.floor(next() * 14);
      const content = Array.from({ length: count }, () => pool[Math.floor(next() * pool.length)]).join(',');
      const stored = storedMetaReferrer(content);
      const policy = effectiveReferrerPolicy([content]);
      expect(stored === null ? null : effectiveReferrerPolicy([stored]), content).toBe(policy);
      if (stored !== null) expect(stored.split(', ').length).toBeLessThanOrEqual(8);
    }
  });
});

describe('counterexamples: ordinary tags are stored as before', () => {
  it.each<[string | null, string | null]>([
    ['origin', 'origin'],
    ['no-referrer', 'no-referrer'],
    ['strict-origin-when-cross-origin', 'strict-origin-when-cross-origin'],
    ['unsafe-url', 'unsafe-url'],
    ['no-referrer-when-downgrade', 'no-referrer-when-downgrade'],
    ['no-referrer, strict-origin-when-cross-origin', 'no-referrer, strict-origin-when-cross-origin'],
    ['no-referrer,strict-origin', 'no-referrer, strict-origin'],
    ['  same-origin  ', 'same-origin'],
    ['Origin', 'Origin'],
    ['STRICT-ORIGIN', 'STRICT-ORIGIN'],
    ['origin,,same-origin', 'origin, same-origin'],
    ['no-referrer, zq7bob@mail.invalid', 'no-referrer'],
    ['origin, origin', 'origin, origin'],
    ['', null],
    [',', null],
    [null, null],
  ])('%j → %j', (content, expected) => {
    expect(storedMetaReferrer(content)).toBe(expected);
  });
});
