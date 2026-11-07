/**
 * The code of a failed navigation comes from Chromium only: from the start of Playwright's message of the `goto`, or
 * from Chromium's own error page, and only as one of its net error names. A page that sends itself to a URL or opens a
 * document whose text shows an error name cannot choose the code. Markers start with `zq8`.
 */
import type { Page, Response } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { RawDomFacts } from '../../../../../src/collectors/browser/in-page/dom.ts';
import { navigationErrorCode, visitPage } from '../../../../../src/collectors/browser/pages/visit.ts';
import type { NetworkRecorder } from '../../../../../src/collectors/browser/recording/recorder.ts';
import { FAST_TIMING } from '../../../../integration/browser/helpers.ts';

describe('the code of a failed navigation', () => {
  it.each([
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example.test/', 'ERR_NAME_NOT_RESOLVED'],
    ['page.reload: net::ERR_CONNECTION_REFUSED at https://x.example.test/', 'ERR_CONNECTION_REFUSED'],
    ['page.goto: net::ERR_ABORTED; maybe frame was detached?', 'ERR_ABORTED'],
    ['net::ERR_FAILED', 'ERR_FAILED'],
    [
      'page.goto: Navigation to "https://www.example.test/" is interrupted by another navigation to "https://www.example.test/?x=net::ERR_4F3A9C1D2E"',
      'navigation-interrupted',
    ],
    ['page.goto: net::ERR_4F3A9C1D2E7B at https://x.example.test/', 'navigation-error'],
    ['page.goto: something at https://x.example.test/?net::ERR_ZQ8SECRET', 'navigation-error'],
    ['net::ERR_ZQ8SECRET', 'navigation-error'],
  ])('%s → %s', (message, code) => {
    expect(navigationErrorCode(message)).toBe(code);
  });
});

describe('a navigation that ends on a document outside http(s)', () => {
  const URL_ = 'https://www.example.test/';
  /** The DOM facts of a document whose title and text show `title`. */
  const domAnswer = (title: string): RawDomFacts => ({
    title,
    lang: 'de',
    h1: title,
    links: [],
    forms: [],
    iframes: [],
    linkRels: [],
    scripts: [],
    metaRefresh: null,
    visibleTextLength: title.length,
    textSample: title,
    placeholders: [],
    linksTotal: 0,
    linksTruncated: false,
  });

  /** A page whose navigation ends at `finalUrl`, a document whose title is `title`. */
  function visitEndingAt(finalUrl: string, title: string) {
    const response = {
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html' }),
      headersArray: async () => [{ name: 'Content-Type', value: 'text/html' }],
      serverAddr: async () => null,
      url: () => URL_,
      request: () => ({ redirectedFrom: () => null }),
    } as unknown as Response;
    const page = {
      goto: async () => response,
      reload: async () => response,
      waitForLoadState: async () => undefined,
      url: () => finalUrl,
      frames: () => [],
      evaluate: async () => domAnswer(title),
    } as unknown as Page;
    const recorder = {
      beginNavigation: () => 'A-n1',
      rebindNavigation: () => undefined,
      lastRequestStart: () => null,
      inflight: () => 0,
      flush: async () => true,
    } as unknown as NetworkRecorder;
    return visitPage(
      {
        page,
        recorder,
        timing: { ...FAST_TIMING, quietWindowMs: 0 },
        phaseTiming: { minDwellMs: 0, hardCapMs: 1_000 },
        signal: new AbortController().signal,
        target: { etld1: 'example.test', host: 'www.example.test' },
        now: () => new Date(),
      },
      { rawUrl: URL_, role: 'start', order: 0, phase: 'A', firstVisit: true },
    );
  }

  it.each([
    ['blob:https://www.example.test/5e1b', 'ERR_4F3A9C1D2E7B', 'ERR_FAILED'],
    ['data:text/html,zq8', 'ERR_NAME_NOT_RESOLVED', 'ERR_FAILED'],
    ['chrome-error://chromewebdata/', 'ERR_ZQ8SECRET', 'ERR_FAILED'],
    ['chrome-error://chromewebdata/', 'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_NOT_RESOLVED'],
  ])('%s titled %s → %s', async (finalUrl, title, code) => {
    const r = await visitEndingAt(finalUrl, title);

    expect(r.visit.navigation.error).toBe(code);
    expect(r.visit.notEvaluableReason).toBe(`navigation-failed:${code}`);
    expect(r.visit.dom).toBeNull();
    expect(JSON.stringify(r.visit)).not.toMatch(/4F3A9C1D2E7B|ZQ8SECRET/);
  });
});
