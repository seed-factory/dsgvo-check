/**
 * Canary runner: passive scans of canary/sites.yaml with low parallelism into canary/results/<runId>/; `summary [runId]`
 * aggregates a run (no site names without --with-sites). Usage and ethics: canary/README.md.
 */
import { readdirSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate } from './aggregate.ts';
import { DEFAULT_RESULTS_DIR, parseRunnerArgs, RUNNER_USAGE } from './args.ts';
import { loadRun } from './load.ts';
import { renderMarkdown } from './markdown.ts';
import { FILES } from './results.ts';
import { reanalyzeRun, runCanary } from './runner.ts';
import { apiScanner, cliScanner, type SiteScanner } from './scanners.ts';
import { filterSites, loadSites } from './sites.ts';

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
    log(`summary: node scripts/canary/main.ts summary ${res.runId}`);
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
  log(`summary: node scripts/canary/main.ts summary ${res.runId}`);
  return 0;
}

const SUMMARY_USAGE = `Usage: node scripts/canary/main.ts summary [runId] [--results <dir>] [--with-sites] [--stdout]

  runId          run directory below canary/results (default: the most recently updated run)
  --with-sites   add per-site rows (site names!) for local analysis; never share that output
  --stdout       also print SUMMARY.md
`;

async function latestRun(resultsDir: string): Promise<string | null> {
  let best: { id: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(resultsDir);
  } catch {
    return null;
  }
  for (const id of entries) {
    try {
      const s = await stat(path.join(resultsDir, id, FILES.run));
      if (!best || s.mtimeMs > best.mtime) best = { id, mtime: s.mtimeMs };
    } catch {
      // not a run directory
    }
  }
  return best?.id ?? null;
}

async function summary(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      results: { type: 'string' },
      'with-sites': { type: 'boolean' },
      stdout: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(SUMMARY_USAGE);
    return 0;
  }
  const resultsDir = path.resolve(values.results ?? DEFAULT_RESULTS_DIR);
  const runId = positionals[0] ?? (await latestRun(resultsDir));
  if (
    !runId ||
    positionals.length > 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
    runId.includes('..')
  ) {
    process.stderr.write(
      runId
        ? `canary summary: invalid run id\n${SUMMARY_USAGE}`
        : `canary summary: no run found\n${SUMMARY_USAGE}`,
    );
    return 2;
  }
  const runDir = path.join(resultsDir, runId);
  const { run, results } = await loadRun(runDir);
  if (results.length === 0) {
    process.stderr.write(`canary summary: no sites in ${runDir}\n`);
    return 2;
  }
  const withSites = Boolean(values['with-sites']);
  const summary = aggregate(results, {
    runId,
    generatedAt: new Date().toISOString(),
    mode: run?.mode ?? 'scan',
    reanalyzedFrom: run?.reanalyzedFrom ?? null,
    withSites,
  });
  const md = renderMarkdown(summary);
  await writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(runDir, 'SUMMARY.md'), md);
  if (values.stdout) process.stdout.write(md);
  const g = summary.groups.all;
  process.stdout.write(
    `${runDir}/SUMMARY.md: ${g.finished}/${g.sites} finished (complete ${g.scanStatus.complete}, ` +
      `partial ${g.scanStatus.partial}, failed ${g.scanStatus.failed}, no report ${g.scanStatus['no-report']})\n`,
  );
  if (withSites) process.stderr.write('canary summary: output contains site names; keep it local\n');
  return 0;
}

const argv = process.argv.slice(2);
process.exitCode = await (argv[0] === 'summary' ? summary(argv.slice(1)) : main(argv)).catch(
  (err: unknown) => {
    warn(errorMessage(err));
    return 2;
  },
);
