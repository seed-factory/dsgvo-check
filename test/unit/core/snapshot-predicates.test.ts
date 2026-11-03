/** Named predicates over the snapshot's closed string sets. */
import { describe, expect, it } from 'vitest';
import {
  type CookieState,
  type HrefKind,
  isCookieHeld,
  isHttpHref,
} from '../../../src/core/snapshot/browser.ts';

describe('isCookieHeld', () => {
  it.each<[CookieState, boolean]>([
    ['accepted', true],
    ['sent', true],
    ['attempted', false],
    ['rejected', false],
  ])('%s → %s', (state, held) => {
    expect(isCookieHeld(state)).toBe(held);
  });
});

describe('isHttpHref', () => {
  it.each<[HrefKind, boolean]>([
    ['http', true],
    ['https', true],
    ['fragment', false],
    ['javascript', false],
    ['mailto', false],
    ['tel', false],
    ['empty', false],
    ['other', false],
  ])('%s → %s', (kind, navigable) => {
    expect(isHttpHref(kind)).toBe(navigable);
  });
});
