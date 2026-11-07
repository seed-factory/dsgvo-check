import type { RunCanaryOptions } from '../../../scripts/canary/runner.ts';
import { type CanarySite, parseSites } from '../../../scripts/canary/sites.ts';

/** A corpus of `n` German media sites `de-s0` … `de-s<n-1>`, read the way the runner reads canary/sites.yaml. */
export function sites(n: number): CanarySite[] {
  const raw = Array.from({ length: n }, (_, i) => ({
    id: `de-s${i}`,
    url: `https://www.s${i}.de/`,
    region: 'de',
    country: 'DE',
    sector: 'media',
    sizeClass: 'medium',
    expectedCmp: 'unknown',
    selectionReason: 'Branchenmix',
    publicReference: null,
  }));
  return parseSites(JSON.stringify({ version: 1, sites: raw }), { expectedCount: null });
}

/** Options of a scan run `run-a` with two workers and short timeouts. */
export const runOptions = (
  resultsDir: string,
  list: CanarySite[],
  over: Partial<RunCanaryOptions> = {},
): RunCanaryOptions => ({
  sites: list,
  resultsDir,
  runId: 'run-a',
  concurrency: 2,
  pauseMs: 10,
  timeoutMs: 1000,
  watchdogReserveMs: 1000,
  retryErrors: false,
  engine: 'api',
  sitesFile: 'canary/sites.yaml',
  ...over,
});
