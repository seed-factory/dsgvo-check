// Browser collector: phases A/B/C, each in a fresh `chromium.launchPersistentContext` (Chrome for Testing, new
// headless; sandbox per `ctx.options.sandbox`, extra args from `ctx.network.test?.browserArgs`). Fatal conditions are
// returned in `fatal`. The CMP subsystem is reached only through `src/cmp/index.ts`; tests may inject a stub.
import { chromium } from 'playwright-core';
import type { BrowserCollector } from '../../core/snapshot/collector.ts';
import { defaultCmpApi } from './cmp-bridge.ts';
import { BrowserCollection, type BrowserCollectorDeps } from './collector.ts';

export type { CmpApi } from './cmp-bridge.ts';
export type { BrowserCollectorDeps } from './collector.ts';
export { type BrowserTiming, browserTiming, DEFAULT_TIMING, type PhaseTiming } from './config.ts';

export function createBrowserCollector(over: Partial<BrowserCollectorDeps> = {}): BrowserCollector {
  const deps: BrowserCollectorDeps = {
    cmp: defaultCmpApi,
    chromium,
    phases: ['A', 'B', 'C'],
    ...over,
  };
  return (ctx) => new BrowserCollection(ctx, deps).run();
}

export const collectBrowser: BrowserCollector = createBrowserCollector();
