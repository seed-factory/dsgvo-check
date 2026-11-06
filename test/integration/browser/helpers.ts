/** Helpers for the browser collector: fast timings, a CollectorContext against the fixture server. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BrowserCollectorDeps,
  type BrowserTiming,
  createBrowserCollector,
} from '../../../src/collectors/browser/index.ts';
import { defineCheck } from '../../../src/core/api.ts';
import { parseConfigInput } from '../../../src/core/config/load.ts';
import type { ConfigInput } from '../../../src/core/config/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { uaToken } from '../../../src/core/runtime/user-agent.ts';
import type { RequestRecord } from '../../../src/core/snapshot/browser.ts';
import type {
  BrowserSections,
  CollectorContext,
  CollectorResult,
  EntryTarget,
} from '../../../src/core/snapshot/collector.ts';
import type { NetworkConfig } from '../../../src/core/url/net.ts';
import { parseTarget } from '../../../src/core/url/url.ts';
import type { FixtureServer } from '../../fixture-server/server.ts';
import { makeSnapshot } from '../../utils/snapshot-builder.ts';

/** Same algorithm as production, scaled down so that a full A/B/C run takes seconds. */
export const FAST_TIMING: BrowserTiming = {
  quietWindowMs: 300,
  maxInflight: 1,
  phases: {
    A: { minDwellMs: 400, hardCapMs: 4_000 },
    B: { minDwellMs: 400, hardCapMs: 4_000 },
    C: { minDwellMs: 400, hardCapMs: 4_000 },
  },
  navigationPauseMs: 50,
  navigationTimeoutMs: 15_000,
  loadTimeoutMs: 5_000,
  cmpCallTimeoutMs: 10_000,
  retryDelayMs: 200,
  deadlineReserveMs: 0,
};

/** The userns sandbox is not available on every Linux CI host; macOS always has its seatbelt sandbox. */
export const TEST_SANDBOX: 'require' | 'off' =
  process.env.DSGVO_CHECK_TEST_SANDBOX === 'require' || process.platform === 'darwin' ? 'require' : 'off';

export interface CollectRun {
  result: CollectorResult<BrowserSections>;
  ctx: CollectorContext;
  artifactsDir: string;
  requests: RequestRecord[];
}

export async function collect(
  server: FixtureServer,
  o: {
    url?: string;
    deps?: Partial<BrowserCollectorDeps>;
    network?: Partial<NetworkConfig>;
    /** Operator settings of the scan; `deps` (FAST_TIMING) still wins for what it names. */
    config?: ConfigInput;
    maxPages?: number;
    screenshots?: boolean;
    signal?: AbortSignal;
    /** Start page chosen by the orchestrator instead of `url` (redirect target of a refused certificate). */
    entry?: EntryTarget;
  } = {},
): Promise<CollectRun> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dsgvo-browser-test-'));
  const target = parseTarget(o.url ?? 'https://www.example.test/');
  const ctx: CollectorContext = {
    target,
    options: {
      maxPages: o.maxPages ?? 6,
      screenshots: o.screenshots ?? true,
      sandbox: TEST_SANDBOX,
      lang: 'de',
      assumeRegion: null,
    },
    network: { ...server.network(), ...o.network },
    config: parseConfigInput(o.config),
    userAgent: { http: uaToken(), token: uaToken() },
    signal: o.signal ?? new AbortController().signal,
    deadline: Date.now() + 110_000,
    artifactsDir: path.join(outDir, 'artifacts'),
    artifactsRelDir: 'artifacts',
    now: () => new Date(),
    log: silentLogger,
    snapshot: makeSnapshot({ target }),
    ...(o.entry ? { entry: o.entry } : {}),
  };
  const collector = createBrowserCollector({ timing: FAST_TIMING, phases: ['A'], ...o.deps });
  const result = await collector(ctx);
  const requests = (result.sections.browser?.phases ?? []).flatMap((p) => p.requests);
  return { result, ctx, artifactsDir: ctx.artifactsDir, requests };
}

/** Everything a snapshot would persist from this collector, as one string (for "no value leaked" checks). */
export function persisted(run: CollectRun): string {
  return JSON.stringify(run.result);
}

/** Resolves once `condition` holds, checked every `intervalMs` (e.g. "the fixture server has seen the request"). */
export function waitUntil(condition: () => boolean, intervalMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (condition()) {
        clearInterval(poll);
        resolve();
      }
    }, intervalMs);
  });
}

/** A check that only needs the browser sections, so that `scan` runs the browser collector. */
export const BROWSER_PROBE_CHECK = defineCheck({
  id: 'TEST-01',
  module: 'browser',
  requires: ['browser', 'documents', 'cmp'],
  variants: [{ variant: 'seen' }],
  run: () => [],
});
