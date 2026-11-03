import { expect } from 'vitest';
import { sanitizeUrl } from '../../../src/core/url.ts';

export const MARK = 'zq7marker';
export const D = 'example.invalid';
export const M = 'mail.invalid';

/** mulberry32: the same sequence on every run, no extra dependency. */
export const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The output of the first pass is a fixed point. */
export function expectStable(input: string): string {
  const once = sanitizeUrl(input);
  expect(sanitizeUrl(once), `sanitizeUrl(sanitizeUrl(${JSON.stringify(input)}))`).toBe(once);
  return once;
}
