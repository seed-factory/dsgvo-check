// biome-ignore-all lint/suspicious/noExplicitAny: in-page callbacks run in Chromium; tsconfig has no DOM lib
/**
 * attribution of requests to pages and to the B/C click on the `browser/cmp-stub` site.
 * - a redirected start page (apex → www) attributes its requests and CMP facts to the final URL in every
 * phase, the same URL as `plan.pages[0]`.
 * - the click moment is the actual press of the button, not the call of the adapter: requests started while
 * the adapter was still preparing are not "after the click"; a failed click changes nothing.
 * - a reject confirmed only after the reload counts as verified (marked `verified-after-reload-only`).
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VerifyResult } from '../../../src/cmp/types.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { type CollectRun, collect } from './helpers.ts';
import { stubAdapter, stubCmpApi } from './stub-cmp.ts';

declare const fetch: any;

const hit = (page: Page, en: string) =>
  page.evaluate(
    (u: string) => fetch(u, { mode: 'no-cors' }).then(() => undefined),
    `https://www.google-analytics.com/g/collect?v=2&tid=G-TEST123&en=${en}`,
  );

describe('redirected start page, click timing, verification after reload', () => {
  let server: FixtureServer;
  let run: CollectRun;
  let verifyCalls = 0;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['browser/cmp-stub'] });
    server.addRoute({
      host: 'example.test',
      path: '/',
      status: 301,
      headers: { location: 'https://www.example.test/' },
    });
    const cmp = stubCmpApi({
      // The adapter is still preparing (classification, actionability checks) when a tracker fires.
      reject: async (page) => {
        await hit(page, 'before_click');
        await page.waitForTimeout(300);
        await page.locator('#stub-reject').click({ timeout: 5_000 });
        await hit(page, 'after_click');
        return {
          action: 'reject',
          clicked: true,
          button: { name: 'Ablehnen', role: 'button', kind: 'reject', kindConfidence: 'high' },
        };
      },
      // The accept button cannot be pressed (e.g. ambiguous target) after a tracker fired.
      accept: async (page) => {
        await hit(page, 'failed_click');
        return { action: 'accept', clicked: false, button: null, error: 'target-ambiguous' };
      },
      // The CMP confirms the reject asynchronously: not yet right after the click, but after the reload.
      verify: async (page, action, opts): Promise<VerifyResult> => {
        verifyCalls++;
        const real = await stubAdapter.verify(page, action, opts);
        return verifyCalls === 1 ? { ...real, verified: false, method: ['api:stub-pending'] } : real;
      },
    });
    run = await collect(server, {
      url: 'https://example.test/',
      maxPages: 1,
      deps: { cmp, phases: ['A', 'B', 'C'] },
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  const phase = (p: 'A' | 'B' | 'C') => run.result.sections.browser?.phases.find((x) => x.phase === p);
  const byEvent = (p: 'A' | 'B' | 'C', en: string) => phase(p)?.requests.find((r) => r.eventType === en);

  it('the start page is attributed to its final URL in every phase and in the plan', () => {
    const start = phase('A')?.pages[0];
    expect(start).toMatchObject({ url: 'https://example.test/', finalUrl: 'https://www.example.test/' });
    expect(run.result.sections.plan?.pages[0]?.url).toBe('https://www.example.test/');
    const cmpJs = (p: 'A' | 'B') =>
      phase(p)
        ?.requests.filter((r) => r.url === 'https://www.example.test/cmp.js')
        .map((r) => r.pageUrl);
    expect(cmpJs('A')).toEqual(['https://www.example.test/']);
    expect(cmpJs('B')?.[0]).toBe('https://www.example.test/');
    const factsA = run.result.sections.cmp?.phases.find((p) => p.phase === 'A')?.facts ?? [];
    expect(factsA[0]?.pageUrl).toBe('https://www.example.test/');
  });

  it('a request started before the actual press is not after the click; one after it is', () => {
    expect(byEvent('B', 'before_click')).toMatchObject({ afterClick: false, tRef: 'navigation' });
    expect(byEvent('B', 'after_click')).toMatchObject({ afterClick: true, tRef: 'click' });
    expect(phase('B')?.click).toMatchObject({ action: 'reject', success: true });
  });

  it('a failed click leaves the recorder in navigation mode', () => {
    expect(phase('C')).toMatchObject({ status: 'partial', reason: 'no-accept-button' });
    expect(byEvent('C', 'failed_click')).toMatchObject({ afterClick: false, tRef: 'navigation' });
    expect(phase('C')?.requests.every((r) => !r.afterClick)).toBe(true);
    expect(phase('C')?.cookies.every((c) => !c.afterClick)).toBe(true);
  });

  it('confirmed only after the reload → verified, persisted, marked', () => {
    const v = run.result.sections.cmp?.phases.find((p) => p.phase === 'B')?.verify;
    expect(v).toMatchObject({ action: 'reject', verified: true, persistedAfterReload: true });
    expect(v?.method).toContain('verified-after-reload-only');
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
