import { describe, expect, it } from 'vitest';
import { clipForBox } from '../../../../src/collectors/browser/screenshot.ts';

const vp = { width: 1366, height: 768 };

describe('banner screenshot clip (G08: metadata must describe the saved image)', () => {
  it('a container that extends below the viewport is cut at the viewport edge', () => {
    expect(clipForBox({ x: 774, y: 508, width: 576, height: 832 }, vp)).toEqual({
      x: 774,
      y: 508,
      width: 576,
      height: 260,
    });
  });

  it('a container inside the viewport keeps its box (rounded outwards)', () => {
    expect(clipForBox({ x: 10.4, y: 600.2, width: 800.3, height: 100.1 }, vp)).toEqual({
      x: 10,
      y: 600,
      width: 801,
      height: 101,
    });
  });

  it('a container that starts left of / above the viewport is cut at 0', () => {
    expect(clipForBox({ x: -40, y: -10, width: 300, height: 100 }, vp)).toEqual({
      x: 0,
      y: 0,
      width: 260,
      height: 90,
    });
  });

  it('a container that extends right of the viewport is cut at its right edge', () => {
    expect(clipForBox({ x: 1300, y: 100, width: 200, height: 50 }, vp)).toEqual({
      x: 1300,
      y: 100,
      width: 66,
      height: 50,
    });
  });

  it('no intersection → no clip', () => {
    expect(clipForBox({ x: 0, y: 768, width: 500, height: 100 }, vp)).toBeNull();
    expect(clipForBox({ x: 1366, y: 0, width: 100, height: 100 }, vp)).toBeNull();
    expect(clipForBox({ x: -300, y: 10, width: 200, height: 100 }, vp)).toBeNull();
    expect(clipForBox({ x: 10, y: -200, width: 100, height: 100 }, vp)).toBeNull();
  });
});
