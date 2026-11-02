import { describe, expect, it } from 'vitest';
import { redactText } from '../../../src/core/redact.ts';
import { REDACTED } from '../../../src/core/url.ts';

describe('redactText: long runs of closing brackets after a token', () => {
  it.each([
    [
      'HTTP URL with parentheses',
      (n: number) => `https://x.test/${')'.repeat(n)}`,
      (n: number) => `https://x.test/${')'.repeat(n)}`,
    ],
    [
      'HTTP URL with square brackets',
      (n: number) => `https://x.test/${']'.repeat(n)}`,
      (n: number) => `https://x.test/${']'.repeat(n)}`,
    ],
    [
      'mailto with parentheses',
      (n: number) => `mailto:info@example.test${')'.repeat(n)}`,
      (n: number) => `mailto:${REDACTED}@example.test${')'.repeat(n)}`,
    ],
    [
      'mailto with braces',
      (n: number) => `mailto:info@example.test${'}'.repeat(n)}`,
      (n: number) => `mailto:${REDACTED}@example.test${'}'.repeat(n)}`,
    ],
  ] as const)('redacts and scales with %s', (_name, input, expected) => {
    const best = (n: number) => {
      const value = input(n);
      redactText(value);
      return Math.min(
        ...Array.from({ length: 5 }, () => {
          const started = performance.now();
          redactText(value);
          return performance.now() - started;
        }),
      );
    };
    expect(best(80_000) / Math.max(best(20_000), 0.05)).toBeLessThan(12);
    expect(redactText(input(20_000))).toBe(expected(20_000));
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
