import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { bannerBox, clipForBox } from '../../../../src/collectors/browser/phases/screenshot.ts';
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

describe('banner screenshot box', () => {
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

describe('banner screenshot clipping to the viewport', () => {
  it.each([
    ['below', { x: 774, y: 508, width: 576, height: 832 }, { x: 774, y: 508, width: 576, height: 260 }],
    [
      'inside, rounded outwards',
      { x: 10.4, y: 600.2, width: 800.3, height: 100.1 },
      { x: 10, y: 600, width: 801, height: 101 },
    ],
    ['left and above', { x: -40, y: -10, width: 300, height: 100 }, { x: 0, y: 0, width: 260, height: 90 }],
    ['right', { x: 1300, y: 100, width: 200, height: 50 }, { x: 1300, y: 100, width: 66, height: 50 }],
    ['outside below', { x: 0, y: 768, width: 500, height: 100 }, null],
    ['outside right', { x: 1366, y: 0, width: 100, height: 100 }, null],
    ['outside left', { x: -300, y: 10, width: 200, height: 100 }, null],
    ['outside above', { x: 10, y: -200, width: 100, height: 100 }, null],
  ])('%s', (_name, box, expected) => {
    expect(clipForBox(box, { width: 1366, height: 768 })).toEqual(expected);
  });
});
