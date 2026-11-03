/**
 * Banner screenshot: only the banner area of the current viewport, taken before any action and without
 * scrolling (`page.screenshot({ clip })`, never `locator.screenshot()`), JPEG ≤ 200 KB, only when the container is
 * unique and ≤ 50 % of the viewport. Otherwise no image (`screenshot-skipped`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { CmpFacts } from '../../cmp/types.ts';
import type { ScreenshotRecord } from '../../core/snapshot-browser.ts';
import type { Box, BrowserPhase, SanitizedUrl } from '../../core/snapshot-common.ts';
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_VIEWPORT_SHARE, VIEWPORT } from './config.ts';
import { bannerBoxInPage } from './in-page-dom.ts';
import { sha256Hex } from './util.ts';

export type ShotResult = { record: ScreenshotRecord } | { skipped: string };

/** Box of the banner container: from the CMP facts when they measured it, else from the button positions. */
export async function bannerBox(page: Page, facts: CmpFacts): Promise<{ box: Box | null; reason: string }> {
  const { containerBox, containerUnambiguous } = facts.firstLayer;
  if (containerUnambiguous === false) return { box: null, reason: 'container-ambiguous' };
  if (containerBox) return { box: containerBox, reason: 'cmp' };
  const points = facts.firstLayer.buttons
    .filter((b) => b.layer === 1 && b.visibleAtFirstScreen && b.box)
    .map((b) => ({
      x: (b.box as Box).x + (b.box as Box).width / 2,
      y: (b.box as Box).y + (b.box as Box).height / 2,
    }))
    .filter((p) => p.x >= 0 && p.y >= 0 && p.x < VIEWPORT.width && p.y < VIEWPORT.height);
  if (points.length === 0) return { box: null, reason: 'no-visible-buttons' };
  return page.evaluate(bannerBoxInPage, { points });
}

/**
 * The part of the container that lies in the viewport, in whole CSS pixels (rounded outwards), or null when they do
 * not intersect. This is what `page.screenshot({ clip })` really saves without scrolling: the record describes it
 * instead of the requested box.
 */
export function clipForBox(
  box: Box,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x1 = Math.max(0, Math.floor(box.x));
  const y1 = Math.max(0, Math.floor(box.y));
  const x2 = Math.min(viewport.width, Math.ceil(box.x + box.width));
  const y2 = Math.min(viewport.height, Math.ceil(box.y + box.height));
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export async function bannerScreenshot(
  page: Page,
  facts: CmpFacts,
  o: { artifactsDir: string; artifactsRelDir: string; phase: BrowserPhase; pageUrl: SanitizedUrl },
): Promise<ShotResult> {
  if (!facts.firstLayer.bannerPresent || !facts.firstLayer.bannerVisible) return { skipped: 'no-banner' };
  const { box, reason } = await bannerBox(page, facts);
  if (!box) return { skipped: reason };
  const share = (box.width * box.height) / (VIEWPORT.width * VIEWPORT.height);
  if (share > SCREENSHOT_MAX_VIEWPORT_SHARE) return { skipped: 'container-too-large' };
  // The saved image is the container cut at the viewport edge (no scrolling): size the record by that part.
  const clip = clipForBox(box, page.viewportSize() ?? VIEWPORT);
  if (!clip) return { skipped: 'container-outside-viewport' };
  let buf: Buffer | null = null;
  for (const quality of [70, 50, 35]) {
    const b = await page.screenshot({ clip, type: 'jpeg', quality, scale: 'css', animations: 'allow' });
    if (b.length <= SCREENSHOT_MAX_BYTES) {
      buf = b;
      break;
    }
  }
  if (!buf) return { skipped: 'too-large' };
  const file = `banner-${o.phase}.jpg`;
  await mkdir(o.artifactsDir, { recursive: true });
  await writeFile(path.join(o.artifactsDir, file), buf);
  return {
    record: {
      id: `shot-${o.phase}-banner`,
      phase: o.phase,
      kind: 'banner',
      path: `${o.artifactsRelDir}/${file}`,
      sha256: sha256Hex(buf),
      width: clip.width,
      height: clip.height,
      viewport: 'desktop',
      pageUrl: o.pageUrl,
    },
  };
}
