// Banner screenshot: only the banner area of the current viewport, taken before any action and without scrolling
// (`page.screenshot({ clip })`, never `locator.screenshot()`), JPEG within `browser.screenshotMaxBytes`, only when the
// container is unique and within `browser.screenshotMaxViewportShare` of the viewport; otherwise no image
// (`screenshot-skipped`).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { CmpFacts } from '../../../cmp/types.ts';
import { DEFAULT_CONFIG } from '../../../core/config/schema.ts';
import type { ScreenshotRecord } from '../../../core/snapshot/browser.ts';
import type { Box, BrowserPhase, SanitizedUrl } from '../../../core/snapshot/common.ts';
import { VIEWPORT } from '../config.ts';
import { bannerBoxInPage } from '../in-page/dom.ts';
import { box, fields } from '../page-values.ts';
import { loadDomPatterns } from '../rules.ts';
import { sha256Hex } from '../util.ts';

export type ShotResult = { record: ScreenshotRecord } | { skipped: string };

/** JPEG qualities tried in order until the image fits `maxBytes`. */
const JPEG_QUALITIES = [70, 50, 35] as const;

/** What `bannerBoxInPage` answers besides a box; the reason becomes the message of a skipped screenshot. */
const IN_PAGE_REASONS: ReadonlySet<string> = new Set([
  'ok',
  'no-element-at-buttons',
  'no-unique-container',
  'container-off-screen',
]);

/** From the CMP facts when measured, else from the button positions. */
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
  // Measured in the page's own world, whose script can replace `Math` or `getBoundingClientRect`: a box of numbers and
  // a reason of the closed set, else no box.
  const answer = fields(
    await page.evaluate(bannerBoxInPage, { points, bannerNames: loadDomPatterns().page.bannerNames }),
  );
  const reason =
    typeof answer.reason === 'string' && IN_PAGE_REASONS.has(answer.reason) ? answer.reason : null;
  const measured = box(answer.box);
  if (reason !== null && reason !== 'ok') return { box: null, reason };
  return reason === 'ok' && measured
    ? { box: measured, reason }
    : { box: null, reason: 'container-unreadable' };
}

// The part of the container inside the viewport in whole CSS pixels, or null: this is what `page.screenshot({ clip })`
// saves without scrolling, so the record describes it.
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
  o: {
    artifactsDir: string;
    artifactsRelDir: string;
    phase: BrowserPhase;
    pageUrl: SanitizedUrl;
    /** `browser.screenshotMaxBytes` and `browser.screenshotMaxViewportShare`. */
    limits?: { maxBytes: number; maxViewportShare: number };
  },
): Promise<ShotResult> {
  const { maxBytes, maxViewportShare } = o.limits ?? {
    maxBytes: DEFAULT_CONFIG.browser.screenshotMaxBytes,
    maxViewportShare: DEFAULT_CONFIG.browser.screenshotMaxViewportShare,
  };

  if (!facts.firstLayer.bannerPresent || !facts.firstLayer.bannerVisible) return { skipped: 'no-banner' };
  const { box, reason } = await bannerBox(page, facts);
  if (!box) return { skipped: reason };
  const share = (box.width * box.height) / (VIEWPORT.width * VIEWPORT.height);
  if (share > maxViewportShare) return { skipped: 'container-too-large' };
  // The saved image is the container cut at the viewport edge (no scrolling): size the record by that part.
  const clip = clipForBox(box, page.viewportSize() ?? VIEWPORT);
  if (!clip) return { skipped: 'container-outside-viewport' };

  const buf = await jpegWithin(page, clip, maxBytes);
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

/** The first quality whose JPEG is at most `maxBytes`, or null. */
async function jpegWithin(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  maxBytes: number,
): Promise<Buffer | null> {
  for (const quality of JPEG_QUALITIES) {
    const b = await page.screenshot({ clip, type: 'jpeg', quality, scale: 'css', animations: 'allow' });
    if (b.length <= maxBytes) return b;
  }
  return null;
}
