/**
 * Canary summary: canary/results/<runId>/ → SUMMARY.md and summary.json in the same directory.
 * No site names unless --with-sites (local analysis only). Usage: node scripts/canary-summary.ts [runId] [options].
 */

import { readdirSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate, loadRun, renderMarkdown } from './canary-aggregate.ts';
import { DEFAULT_RESULTS_DIR, FILES } from './canary-runner.ts';

const USAGE = `Usage: node scripts/canary-summary.ts [runId] [--results <dir>] [--with-sites] [--stdout]

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

async function main(argv: string[]): Promise<number> {
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
    process.stdout.write(USAGE);
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
      runId ? `canary-summary: invalid run id\n${USAGE}` : `canary-summary: no run found\n${USAGE}`,
    );
    return 2;
  }
  const runDir = path.join(resultsDir, runId);
  const { run, results } = await loadRun(runDir);
  if (results.length === 0) {
    process.stderr.write(`canary-summary: no sites in ${runDir}\n`);
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
  if (withSites) process.stderr.write('canary-summary: output contains site names; keep it local\n');
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`canary-summary: ${err instanceof Error ? err.message : String(err)}\n`);
  return 2;
});
