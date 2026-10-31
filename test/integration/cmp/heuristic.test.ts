/**
 * L2: unknown banners (no adapter) — generic heuristic in the main document, open shadow DOM and a cross-origin
 * iframe. Facts only: the classification is always `banner-not-recognized` (5.5), nothing is clicked.
 */
import { describe, expect, it } from 'vitest';
import { classifyFirstLayer, detectCmp, extract, loadLexicon } from '../../../src/cmp/index.ts';
import { useCmpServer } from './helpers.ts';

describe('generic heuristic (unknown banner)', () => {
  const env = useCmpServer(['cmp/generic']);
  const lexicon = loadLexicon();

  it('main document: fixed bar with consent wording → heuristic facts, banner-not-recognized', async () => {
    const { page } = await env.open('https://www.generic.test/');
    const { adapter, detection } = await detectCmp(page);
    expect(adapter).toBeNull();
    expect(detection.method).toBe('heuristic');
    expect(detection.recognitionConfidence).not.toBe('high');
    expect(detection.signals).toContain('heuristic:fixed');
    const facts = await extract(page, null, 'first-screen');
    expect(facts.firstLayer.bannerVisible).toBe(true);
    expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'settings']);
    const cls = classifyFirstLayer(facts, lexicon);
    expect(cls.variant).toBe('banner-not-recognized');
    expect(cls.reasons).toEqual(['heuristic-only']);
    expect(cls.targets).toEqual({ reject: null, accept: null });
  });

  it('open shadow DOM: modal dialog found through the shadow root', async () => {
    const { page } = await env.open('https://www.generic.test/shadow.html');
    const facts = await extract(page, null, 'first-screen');
    expect(facts.detection.method).toBe('heuristic');
    expect(facts.detection.signals).toContain('heuristic:dialog');
    expect(facts.firstLayer.buttons.every((b) => b.inShadowDom)).toBe(true);
    expect(facts.firstLayer.buttons.map((b) => b.kind).sort()).toEqual(['accept', 'reject']);
  });

  it('cross-origin iframe: banner body inside the frame, geometry offset to the main viewport', async () => {
    const { page } = await env.open('https://www.generic.test/iframe.html');
    const facts = await extract(page, null, 'first-screen');
    expect(facts.detection.method).toBe('heuristic');
    expect(facts.detection.frameUrl).toBe('https://consent.unknown-cmp.test/banner.html');
    const accept = facts.firstLayer.buttons.find((b) => b.kind === 'accept');
    expect(accept?.box?.y).toBeGreaterThan(768 - 180 - 1);
    expect(facts.firstLayer.containerFixed).toBe(true);
  });

  it('no banner → method none', async () => {
    const { page } = await env.open('https://www.generic.test/none.html');
    const { detection } = await detectCmp(page);
    expect(detection.method).toBe('none');
    const facts = await extract(page, null, 'first-screen');
    expect(facts.firstLayer.bannerPresent).toBe(false);
    expect(classifyFirstLayer(facts, lexicon).reasons).toEqual(['no-banner-detected']);
  });
});
