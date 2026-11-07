import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { decodeLenient } from '../../../../src/core/url/email.ts';
import { parseUrl } from '../../../../src/core/url/url.ts';

/** Length in bytes of the UTF-8 sequence that a lead byte starts; 0 for a byte that cannot start one. */
function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

/** Decodes a run of `%xx` escapes that `decodeURIComponent` rejects: only the malformed bytes stay escaped. */
function decodeMalformedRun(run: string): string {
  let out = '';
  for (let at = 0; at < run.length; ) {
    const byte = Number.parseInt(run.slice(at + 1, at + 3), 16);
    const width = utf8SequenceLength(byte);

    if (width > 0 && at + width * 3 <= run.length) {
      try {
        out += decodeURIComponent(run.slice(at, at + width * 3));
        at += width * 3;
        continue;
      } catch {
        // Only this malformed byte stays escaped; later valid sequences still decode.
      }
    }

    out += run.slice(at, at + 3);
    at += 3;
  }
  return out;
}

/** The previous decoder is the compatibility oracle for malformed percent escapes. */
function referenceDecode(input: string): string {
  return input.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return decodeMalformedRun(run);
    }
  });
}

/** A linear congruential generator, so the "random" inputs are the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const RANDOM_PIECES = ['plain', '%', '%Z1', '%4', '/', '%2540', '%E2%82%AC', '%F0%9F%98%80'];

/** 32 parts: mostly arbitrary `%xx` bytes, every fifth a fixed piece of text or of a valid or broken escape. */
function randomInput(next: () => number): string {
  let input = '';
  for (let part = 0; part < 32; part++) {
    const random = next();
    input +=
      random % 5 === 0
        ? RANDOM_PIECES[(random >>> 16) % RANDOM_PIECES.length]
        : `%${(random >>> 16).toString(16).padStart(4, '0').slice(-2)}`;
  }
  return input;
}

describe('lenient percent decoding', () => {
  it.each([
    ['%41%C3%BC%F0%9F%98%80', 'Aü😀'],
    ['%E9%40%C3%BC%FF', '%E9@ü%FF'],
    ['%ED%A0%80%20', '%ED%A0%80 '],
    ['%F4%90%80%80%40', '%F4%90%80%80@'],
    ['%C0%AF%F0%80%80%AF', '%C0%AF%F0%80%80%AF'],
    ['%e9%40%F0%9F%98%80%C2', '%e9@😀%C2'],
    ['%ZZ%4%25%00', '%ZZ%4%\0'],
  ])('decodes valid sequences and preserves malformed bytes in %s', (input, expected) => {
    expect(decodeLenient(input)).toBe(expected);
  });

  it('matches the previous decoder for deterministic random byte sequences and mixed text', () => {
    const next = seededRandom(0x42a917cd);

    for (let sample = 0; sample < 3_000; sample++) {
      const input = randomInput(next);

      expect(decodeLenient(input), input).toBe(referenceDecode(input));
    }
  });

  it('keeps malformed escape decoding proportional to input size', () => {
    const small = '%E9'.repeat(65_536);
    const large = small.repeat(4);
    const measure = (input: string) => {
      const started = performance.now();
      expect(decodeLenient(input)).toBe(input);
      return performance.now() - started;
    };

    // warm-up, so the first (compiling) run does not skew the ratio
    decodeLenient(small);
    decodeLenient(large);

    // 4x the input may cost far less than 12x the time (a quadratic decoder would need ~16x); the median of 5 runs
    const ratios = Array.from({ length: 5 }, () => {
      const baseline = measure(small);
      return measure(large) / baseline;
    }).sort((a, b) => a - b);

    expect(ratios[2]).toBeLessThan(12);
  });
});

describe('safe URL parsing', () => {
  it('resolves relative paths while preserving the URL parser rules', () => {
    expect(parseUrl(' ../next?q=value ', 'https://example.test/start/path')?.href).toBe(
      'https://example.test/next?q=value',
    );
    expect(parseUrl('https://EXAMPLE.test:443/')?.hostname).toBe('example.test');
    expect(parseUrl('http://[::1]:8080/')?.hostname).toBe('[::1]');
  });

  it('can require HTTP while still accepting other schemes for callers that need them', () => {
    expect(parseUrl('mailto:person@example.test')?.protocol).toBe('mailto:');
    expect(parseUrl('mailto:person@example.test', undefined, true)).toBeNull();
    expect(parseUrl('/next', 'https://example.test/', true)?.protocol).toBe('https:');
  });

  it.each(['http://', 'https://[invalid', 'relative-path'])('returns null for malformed %s', (input) => {
    expect(parseUrl(input)).toBeNull();
  });
});
