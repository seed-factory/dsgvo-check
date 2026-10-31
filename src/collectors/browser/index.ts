/**
 * Browser collector (owner: M1). Phases A/B/C, each in a fresh `chromium.launchPersistentContext(tmpdir)` with
 * `channel: 'chromium'` (Chrome for Testing, new headless); `chromiumSandbox: ctx.options.sandbox === 'require'`;
 * extra args from `ctx.network.test?.browserArgs`; UA = browserUserAgent(navigator.userAgent).
 * Fatal conditions are returned in `fatal` (unreachable/blocked start page, sandbox, browser missing).
 * The CMP subsystem is used only through `src/cmp/index.ts` (`defaultCmpApi`); tests may inject a stub.
 */
import { chromium } from 'playwright-core';
import type { BrowserCollector } from '../../core/collector.ts';
import { defaultCmpApi } from './cmp-bridge.ts';
import { BrowserCollection, type BrowserCollectorDeps } from './collector.ts';
import { DEFAULT_TIMING, REQUEST_LIMIT } from './config.ts';

export type { CmpApi } from './cmp-bridge.ts';
export type { BrowserCollectorDeps } from './collector.ts';
export { type BrowserTiming, DEFAULT_TIMING, type PhaseTiming, REQUEST_LIMIT } from './config.ts';

export function createBrowserCollector(over: Partial<BrowserCollectorDeps> = {}): BrowserCollector {
  const deps: BrowserCollectorDeps = {
    cmp: defaultCmpApi,
    timing: DEFAULT_TIMING,
    chromium,
    phases: ['A', 'B', 'C'],
    requestLimit: REQUEST_LIMIT,
    ...over,
  };
  return (ctx) => new BrowserCollection(ctx, deps).run();
}

export const collectBrowser: BrowserCollector = createBrowserCollector();
