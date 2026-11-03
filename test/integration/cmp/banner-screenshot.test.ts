/**
 * The metadata of the banner screenshot record describes the saved image: Playwright crops a clip at the viewport
 * edge, so the record uses the intersection of the container with the viewport.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CmpFacts } from '../../../src/cmp/types.ts';
import { bannerScreenshot } from '../../../src/collectors/browser/phases/screenshot.ts';
import { makeCmpFacts } from '../../utils/snapshot-builder.ts';
import { useCmpServer } from './helpers.ts';

/** Width and height from the JPEG start-of-frame marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no JPEG frame header');
}

const withBox = (box: { x: number; y: number; width: number; height: number }): CmpFacts =>
  makeCmpFacts({
    firstLayer: {
      bannerPresent: true,
      bannerVisible: true,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
      containerBox: box,
      containerUnambiguous: true,
    },
  });

describe('bannerScreenshot: metadata of the saved image', () => {
  const env = useCmpServer(['cmp/generic']);
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function shoot(
    box: { x: number; y: number; width: number; height: number },
    limits?: { maxBytes: number; maxViewportShare: number },
  ) {
    const { page } = await env.open('https://www.generic.test/none.html');
    const dir = await mkdtemp(path.join(tmpdir(), 'dsgvo-check-shot-'));
    dirs.push(dir);
    const res = await bannerScreenshot(page, withBox(box), {
      artifactsDir: dir,
      artifactsRelDir: 'artifacts',
      phase: 'B',
      pageUrl: 'https://www.generic.test/none.html',
      ...(limits ? { limits } : {}),
    });
    return { res, dir };
  }

  it('container 576×832 at y=508 in a 1366×768 viewport: image and record are 576×260', async () => {
    const { res, dir } = await shoot({ x: 774, y: 508, width: 576, height: 832 });
    expect('record' in res).toBe(true);
    if (!('record' in res)) return;
    expect(res.record.width).toBe(576);
    expect(res.record.height).toBe(260);
    const size = jpegSize(await readFile(path.join(dir, 'banner-B.jpg')));
    expect(size).toEqual({ width: res.record.width, height: res.record.height });
  });

  it('counterexample: a container inside the viewport keeps its size', async () => {
    const { res, dir } = await shoot({ x: 0, y: 600, width: 1366, height: 168 });
    expect('record' in res).toBe(true);
    if (!('record' in res)) return;
    expect({ width: res.record.width, height: res.record.height }).toEqual({ width: 1366, height: 168 });
    expect(jpegSize(await readFile(path.join(dir, 'banner-B.jpg')))).toEqual({ width: 1366, height: 168 });
  });

  it('a container completely outside the viewport: no image (screenshot-skipped)', async () => {
    const { res } = await shoot({ x: 100, y: 900, width: 400, height: 100 });
    expect(res).toEqual({ skipped: 'container-outside-viewport' });
  });

  it('a container above 50 % of the viewport: skipped as before', async () => {
    const { res } = await shoot({ x: 0, y: 0, width: 1366, height: 500 });
    expect(res).toEqual({ skipped: 'container-too-large' });
  });

  it('the limits of the settings decide: a larger share is photographed, a byte limit that is too small skips', async () => {
    const box = { x: 0, y: 0, width: 1366, height: 500 };
    const roomy = await shoot(box, { maxBytes: 204_800, maxViewportShare: 0.8 });
    expect('record' in roomy.res).toBe(true);
    const tooBig = await shoot(
      { x: 0, y: 600, width: 1366, height: 168 },
      { maxBytes: 100, maxViewportShare: 0.5 },
    );
    expect(tooBig.res).toEqual({ skipped: 'too-large' });
    const strict = await shoot(
      { x: 0, y: 600, width: 1366, height: 168 },
      { maxBytes: 204_800, maxViewportShare: 0.1 },
    );
    expect(strict.res).toEqual({ skipped: 'container-too-large' });
  });
});
