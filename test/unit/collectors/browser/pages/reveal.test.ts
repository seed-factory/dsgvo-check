/** How tall the viewport gets for the content below the first screen: never shrunk, capped, only for a page at the top. */
import { describe, expect, it } from 'vitest';
import { VIEWPORT } from '../../../../../src/collectors/browser/config.ts';
import { revealPlan } from '../../../../../src/collectors/browser/pages/reveal.ts';

const facts = (heightPx: number, p: { scrollY?: number; locked?: boolean } = {}) => ({
  heightPx,
  scrollY: p.scrollY ?? 0,
  locked: p.locked ?? false,
});

describe('revealPlan', () => {
  it.each([
    ['a page as tall as the viewport', 768, { outcome: 'fits-viewport', documentHeightPx: 768 }],
    ['a short page', 300, { outcome: 'fits-viewport', documentHeightPx: 300 }],
    [
      'a long page',
      5_300,
      { outcome: 'revealed', documentHeightPx: 5_300, viewportHeightPx: 5_300, capped: false },
    ],
    [
      'a page taller than the cap',
      20_000,
      { outcome: 'revealed', documentHeightPx: 20_000, viewportHeightPx: 10_000, capped: true },
    ],
    [
      'a fractional height',
      768.4,
      { outcome: 'revealed', documentHeightPx: 769, viewportHeightPx: 769, capped: false },
    ],
  ])('%s', (_name, heightPx, plan) => {
    expect(revealPlan(facts(heightPx), VIEWPORT, 10_000)).toEqual(plan);
  });

  it('counterexample: a page that scrolled itself is left as it is, since a resize could move it back up', () => {
    expect(revealPlan(facts(5_000, { scrollY: 1_000 }), VIEWPORT, 10_000)).toEqual({
      outcome: 'scrolled',
      documentHeightPx: 5_000,
    });
    expect(revealPlan(facts(5_000, { scrollY: 0.5 }), VIEWPORT, 10_000)).toMatchObject({
      outcome: 'scrolled',
    });
  });

  it('counterexample: a page the visitor cannot scroll (a blocking banner locks it) is not revealed', () => {
    expect(revealPlan(facts(8_000, { locked: true }), VIEWPORT, 10_000)).toEqual({
      outcome: 'scroll-locked',
      documentHeightPx: 8_000,
    });
  });

  it('never makes the viewport lower than the first screen, whatever the cap', () => {
    expect(revealPlan(facts(5_000), VIEWPORT, 500)).toMatchObject({
      viewportHeightPx: VIEWPORT.height,
      capped: true,
    });
  });
});
