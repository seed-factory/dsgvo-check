/**
 * Canary runner: passive scans of canary/sites.yaml with low parallelism, results in canary/results/<runId>/.
 * Usage and ethics: canary/README.md. `node scripts/canary.ts --help`.
 */
import path from 'node:path';
import {
  apiScanner,
  cliScanner,
  parseRunnerArgs,
  RUNNER_USAGE,
  reanalyzeRun,
  runCanary,
  type SiteScanner,
} from './canary-runner.ts';
import { filterSites, loadSites } from './canary-sites.ts';

const log = (line: string) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`canary: ${line}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseRunnerArgs>;
  try {
    args = parseRunnerArgs(argv, new Date());
  } catch (err) {
    warn(errorMessage(err));
    process.stderr.write(RUNNER_USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(RUNNER_USAGE);
    return 0;
  }

  const scannerOptions = {
    sandbox: args.sandbox,
    screenshots: args.screenshots,
    assumeRegion: args.assumeRegion,
  };
  const scanner: SiteScanner =
    args.engine === 'cli'
      ? cliScanner({ ...scannerOptions, cliPath: args.cliPath })
      : apiScanner(scannerOptions);

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    warn('SIGINT: no new sites are started; running sites finish (press Ctrl-C again to abort)');
  });
  // In-process scans: a stray rejection inside one scan must not end the whole run.
  process.on('unhandledRejection', (err) => warn(`unhandled rejection: ${errorMessage(err)}`));
  const deps = { scanner, sleep, log, shouldStop: () => stopping };
  const filter = { regions: args.regions, ids: args.ids, limit: args.limit };

  if (args.reanalyze) {
    const res = await reanalyzeRun(
      {
        resultsDir: args.resultsDir,
        fromRunId: args.reanalyze,
        runId: args.runId,
        concurrency: args.concurrency,
        timeoutMs: args.timeoutMs,
        filter,
        engine: args.engine,
      },
      deps,
    );
    log(
      `run ${res.runId}: ${res.scanned} reanalyzed, ${res.kept} kept from source, ${res.skipped} already done, ` +
        `${res.errors} runner error(s) → ${res.runDir}`,
    );
    log(`summary: node scripts/canary-summary.ts ${res.runId}`);
    return 0;
  }

  const sites = filterSites(loadSites(args.sitesFile, { expectedCount: args.expectedCount }), filter);
  const runDir = path.join(args.resultsDir, args.runId);
  log(
    `plan: ${sites.length} site(s), engine ${args.engine}, concurrency ${args.concurrency}, ` +
      `pause ${args.pauseMs / 1000} s, timeout ${args.timeoutMs / 1000} s per site → ${runDir}`,
  );
  if (args.dryRun || !args.confirm) {
    for (const s of sites) log(`  ${s.id.padEnd(32)} ${s.region.padEnd(7)} ${s.url}`);
    if (args.dryRun) return 0;
    warn('live scans need --confirm (passive only, results stay local: see canary/README.md)');
    return 1;
  }

  const res = await runCanary(
    {
      sites,
      resultsDir: args.resultsDir,
      runId: args.runId,
      concurrency: args.concurrency,
      pauseMs: args.pauseMs,
      timeoutMs: args.timeoutMs,
      retryErrors: args.retryErrors,
      engine: args.engine,
      sitesFile: args.sitesFile,
      extraOptions: { sandbox: args.sandbox, screenshots: args.screenshots, assumeRegion: args.assumeRegion },
    },
    deps,
  );
  log(
    `run ${res.runId}: ${res.scanned} scanned, ${res.skipped} already done, ${res.errors} runner error(s)` +
      `${stopping ? ' (stopped early, resume with --run-id)' : ''} → ${res.runDir}`,
  );
  log(`summary: node scripts/canary-summary.ts ${res.runId}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
  warn(errorMessage(err));
  return 2;
});
