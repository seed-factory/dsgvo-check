import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { bannerBox } from '../../../../src/collectors/browser/screenshot.ts';
import { makeCmpFacts } from '../../../utils/snapshot-builder.ts';

/** A page that must not be touched: the CMP measured the container already. */
const untouchedPage = new Proxy({} as Page, {
  get() {
    throw new Error('page must not be used');
  },
});

const banner = (p: Record<string, unknown>) =>
  makeCmpFacts({
    firstLayer: {
      bannerPresent: true,
      bannerVisible: true,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
      ...p,
    },
  });

describe('banner screenshot box (D20, M1 × M2)', () => {
  it('uses the container box measured by the CMP subsystem', async () => {
    const box = { x: 10, y: 500, width: 800, height: 200 };
    const r = await bannerBox(untouchedPage, banner({ containerBox: box, containerUnambiguous: true }));
    expect(r).toEqual({ box, reason: 'cmp' });
  });

  it('an ambiguous container gives no box (screenshot-skipped)', async () => {
    const r = await bannerBox(
      untouchedPage,
      banner({ containerBox: { x: 0, y: 0, width: 10, height: 10 }, containerUnambiguous: false }),
    );
    expect(r).toEqual({ box: null, reason: 'container-ambiguous' });
  });

  it('without a measured box and without visible buttons there is nothing to crop', async () => {
    const r = await bannerBox(untouchedPage, banner({}));
    expect(r).toEqual({ box: null, reason: 'no-visible-buttons' });
  });
});
