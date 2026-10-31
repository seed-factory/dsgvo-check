/**
 * L0 (review R10, G01): `redactText` stays linear when a URL or `mailto:` token is followed by a long run of closing
 * brackets. The balance of brackets used to be recounted over the whole prefix for every bracket cut off the tail
 * (quadratic): 40 000 brackets held the thread for 12 s, and the code is synchronous, so no timeout of the scan
 * could interrupt it. A part of a legal document is up to 400 000 characters long.
 */
import { describe, expect, it } from 'vitest';
import { redactText } from '../../../src/core/redact.ts';
import { REDACTED } from '../../../src/core/url.ts';

describe('redactText: long runs of closing brackets after a token', () => {
  it('is linear after an http(s) URL and after a mailto: value', () => {
    const n = 20_000;
    const started = performance.now();
    const outputs = [
      redactText(`https://x.test/${')'.repeat(n)}`),
      redactText(`https://x.test/${']'.repeat(n)}`),
      redactText(`mailto:info@example.test${')'.repeat(n)}`),
      redactText(`mailto:info@example.test${'}'.repeat(n)}`),
    ];
    const took = performance.now() - started;
    expect(outputs).toEqual([
      `https://x.test/${')'.repeat(n)}`,
      `https://x.test/${']'.repeat(n)}`,
      `mailto:${REDACTED}@example.test${')'.repeat(n)}`,
      `mailto:${REDACTED}@example.test${'}'.repeat(n)}`,
    ]);
    expect(took).toBeLessThan(1_000);
  });

  it('keeps a closing bracket that belongs to an opener inside the token', () => {
    expect(redactText('https://de.wikipedia.example/wiki/Datenschutz_(Begriff)')).toBe(
      'https://de.wikipedia.example/wiki/Datenschutz_(Begriff)',
    );
    expect(redactText('(siehe https://shop.example.test/p)')).toBe('(siehe https://shop.example.test/p)');
    expect(redactText('https://shop.example.test/a_(b)).')).toBe('https://shop.example.test/a_(b)).');
    expect(redactText('[https://shop.example.test/p?sid=abc123]')).toBe(
      `[https://shop.example.test/p?sid=${REDACTED}]`,
    );
  });

  it('cuts only the surplus brackets when the token has fewer openers than closers', () => {
    const url = 'https://shop.example.test/a_(b)';
    expect(redactText(`${url}))))`)).toBe(`${url}))))`);
    expect(redactText(`mailto:info@example.test)).`)).toBe(`mailto:${REDACTED}@example.test)).`);
    // the brackets of the three kinds are balanced independently of each other
    expect(redactText('https://x.test/a_[b](c){d}]})')).toBe('https://x.test/a_[b](c){d}]})');
  });
});
