/**
 * Canary runner library: polite job pool, per-site execution with a watchdog, resume and reanalysis from saved
 * snapshots. The entry point is scripts/canary.ts; tests inject a fake `SiteScanner`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { TOOL_VERSION } from '../src/core/version.ts';
import {
  type Engine,
  FILES,
  type RunInfo,
  type RunnerError,
  readJson,
  type ScanStatus,
  type SiteMeta,
  type SiteRef,
  siteRef,
  writeJsonAtomic,
} from './canary-results.ts';
import { caSetting, type SiteJob, type SiteScanner, type SiteScanResult } from './canary-scanners.ts';
import { type CanarySite, filterSites, type SiteFilter } from './canary-sites.ts';

/** Runner watchdog on top of the scan timeout (the CLI itself reserves 30 s for writing reports). */
export const WATCHDOG_RESERVE_MS = 60_000;

export interface RunnerDeps {
  scanner: SiteScanner;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  /** Checked before each new site (SIGINT). Running sites finish. */
  shouldStop?: () => boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jobFor(site: SiteRef, runDir: string, mode: SiteJob['mode'], timeoutMs: number): SiteJob {
  const dir = path.join(runDir, site.id);
  return {
    site,
    mode,
    dir,
    reportPath: path.join(dir, FILES.report),
    snapshotPath: path.join(dir, FILES.snapshot),
    logPath: path.join(dir, FILES.log),
    timeoutMs,
  };
}

type Raced = { kind: 'ok'; value: SiteScanResult } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/** Run one site: scanner vs watchdog, then inspect the files and write meta.json last. */
export async function runSite(
  job: SiteJob,
  scanner: SiteScanner,
  ctx: { runId: string; engine: Engine; watchdogReserveMs: number; now: () => Date },
  extra: Partial<SiteMeta> = {},
): Promise<SiteMeta> {
  await mkdir(job.dir, { recursive: true });
  const startedAt = ctx.now();
  const t0 = performance.now();
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<Raced>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), job.timeoutMs + ctx.watchdogReserveMs);
  });
  let raced: Raced;
  try {
    raced = await Promise.race([
      Promise.resolve()
        .then(() => scanner(job, ac.signal))
        .then(
          (value): Raced => ({ kind: 'ok', value }),
          (error): Raced => ({ kind: 'error', error }),
        ),
      watchdog,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (raced.kind === 'timeout') ac.abort(new Error('canary watchdog'));
  const durationMs = Math.round(performance.now() - t0);

  let error: RunnerError | null = null;
  if (raced.kind === 'timeout') {
    error = {
      code: 'watchdog-timeout',
      message: `no result after ${job.timeoutMs + ctx.watchdogReserveMs} ms`,
    };
  } else if (raced.kind === 'error') {
    error = { code: 'runner-exception', message: errorMessage(raced.error) };
  }

  const hasReport = existsSync(job.reportPath);
  const hasSnapshot = existsSync(job.snapshotPath);
  let scanStatus: ScanStatus | null = raced.kind === 'ok' ? (raced.value.scanStatus ?? null) : null;
  if (hasReport) {
    const report = readJson<{ scan?: { status?: ScanStatus } }>(job.reportPath);
    if (report?.scan?.status) scanStatus = report.scan.status;
    else if (!error) error = { code: 'report-unreadable', message: `${FILES.report} is not a report` };
  } else if (!error) {
    error = { code: 'report-missing', message: `${FILES.report} was not written` };
  }

  const meta: SiteMeta = {
    metaVersion: 1,
    runId: ctx.runId,
    mode: job.mode,
    site: job.site,
    engine: ctx.engine,
    toolVersion: TOOL_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: ctx.now().toISOString(),
    durationMs,
    scanDurationMs: durationMs,
    exitCode: raced.kind === 'ok' ? raced.value.exitCode : null,
    scanStatus,
    files: { report: hasReport, snapshot: hasSnapshot },
    error,
    ...extra,
  };
  await writeJsonAtomic(path.join(job.dir, FILES.meta), meta);
  return meta;
}

/** Process items in order; at most `concurrency` at a time, `pauseMs` before every start but the first. */
export async function runPool<T>(
  items: readonly T[],
  opts: {
    concurrency: number;
    pauseMs: number;
    sleep: (ms: number) => Promise<void>;
    shouldStop?: () => boolean;
  },
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const stop = opts.shouldStop ?? (() => false);
  const worker = async (w: number) => {
    if (w > 0 && opts.pauseMs > 0) await opts.sleep(opts.pauseMs * w);
    let first = true;
    while (next < items.length && !stop()) {
      if (!first && opts.pauseMs > 0) await opts.sleep(opts.pauseMs);
      first = false;
      if (next >= items.length || stop()) break;
      const index = next++;
      await work(items[index] as T, index);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency, items.length));
  await Promise.all(Array.from({ length: n }, (_, w) => worker(w)));
}

function sha256File(file: string | null): string | null {
  if (!file) return null;
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

async function writeRunInfo(
  runDir: string,
  info: Omit<RunInfo, 'runVersion' | 'createdAt' | 'updatedAt' | 'toolVersion' | 'node' | 'platform'>,
  now: Date,
): Promise<void> {
  const file = path.join(runDir, FILES.run);
  const prev = readJson<RunInfo>(file);
  const known = new Set((prev?.sites ?? []).map((s) => s.id));
  const sites = [...(prev?.sites ?? []), ...info.sites.filter((s) => !known.has(s.id))];
  const out: RunInfo = {
    runVersion: 1,
    ...info,
    sites,
    createdAt: prev?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    toolVersion: TOOL_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  await writeJsonAtomic(file, out);
}

function isFinished(dir: string, retryErrors: boolean): boolean {
  const meta = readJson<SiteMeta>(path.join(dir, FILES.meta));
  if (!meta) return false;
  return !(retryErrors && meta.error !== null);
}

export interface RunCanaryOptions {
  sites: readonly CanarySite[];
  resultsDir: string;
  runId: string;
  concurrency: number;
  pauseMs: number;
  timeoutMs: number;
  watchdogReserveMs?: number;
  retryErrors: boolean;
  engine: Engine;
  sitesFile: string | null;
  /** Recorded in run.json (sandbox, screenshots, …). */
  extraOptions?: Record<string, unknown>;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  planned: number;
  scanned: number;
  skipped: number;
  errors: number;
  kept: number;
}

function progressLine(i: number, total: number, meta: SiteMeta): string {
  const status = meta.error ? `runner-error:${meta.error.code}` : (meta.scanStatus ?? 'no-report');
  return `[${i}/${total}] ${meta.site.id} ${status} exit=${meta.exitCode ?? '-'} ${(meta.durationMs / 1000).toFixed(1)}s`;
}

export async function runCanary(o: RunCanaryOptions, deps: RunnerDeps): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const runDir = path.join(o.resultsDir, o.runId);
  await mkdir(runDir, { recursive: true });
  const refs = o.sites.map(siteRef);
  await writeRunInfo(
    runDir,
    {
      runId: o.runId,
      mode: 'scan',
      sitesFile: o.sitesFile,
      sitesSha256: sha256File(o.sitesFile),
      options: {
        concurrency: o.concurrency,
        pauseMs: o.pauseMs,
        timeoutMs: o.timeoutMs,
        engine: o.engine,
        ...o.extraOptions,
      },
      ca: caSetting(o.engine),
      sites: refs,
    },
    now(),
  );

  const todo = refs.filter((s) => !isFinished(path.join(runDir, s.id), o.retryErrors));
  const outcome: RunOutcome = {
    runId: o.runId,
    runDir,
    planned: refs.length,
    scanned: 0,
    skipped: refs.length - todo.length,
    errors: 0,
    kept: 0,
  };
  if (outcome.skipped > 0) deps.log(`resume: ${outcome.skipped} site(s) already finished`);
  const ctx = {
    runId: o.runId,
    engine: o.engine,
    watchdogReserveMs: o.watchdogReserveMs ?? WATCHDOG_RESERVE_MS,
    now,
  };
  await runPool(
    todo,
    { concurrency: o.concurrency, pauseMs: o.pauseMs, sleep: deps.sleep, shouldStop: deps.shouldStop },
    async (site) => {
      const meta = await runSite(jobFor(site, runDir, 'scan', o.timeoutMs), deps.scanner, ctx);
      outcome.scanned++;
      if (meta.error) outcome.errors++;
      deps.log(progressLine(outcome.skipped + outcome.scanned, refs.length, meta));
    },
  );
  return outcome;
}

export interface ReanalyzeOptions {
  resultsDir: string;
  fromRunId: string;
  runId: string;
  concurrency: number;
  timeoutMs: number;
  watchdogReserveMs?: number;
  filter: SiteFilter;
  engine?: Engine;
}

/** Finished sites of a run, in run.json order (then directory order for strays). */
export async function finishedSites(runDir: string): Promise<SiteMeta[]> {
  const info = readJson<RunInfo>(path.join(runDir, FILES.run));
  let dirs: string[];
  try {
    dirs = (await readdir(runDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    throw new Error(`run directory not found: ${runDir}`);
  }
  const order = [...(info?.sites ?? []).map((s) => s.id), ...dirs];
  const seen = new Set<string>();
  const out: SiteMeta[] = [];
  for (const id of order) {
    if (seen.has(id) || !dirs.includes(id)) continue;
    seen.add(id);
    const meta = readJson<SiteMeta>(path.join(runDir, id, FILES.meta));
    if (meta?.site?.id === id) out.push(meta);
  }
  return out;
}

export async function reanalyzeRun(o: ReanalyzeOptions, deps: RunnerDeps): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const srcDir = path.join(o.resultsDir, o.fromRunId);
  const runDir = path.join(o.resultsDir, o.runId);
  if (path.resolve(srcDir) === path.resolve(runDir)) throw new Error('reanalysis needs a new run id');
  const source = await finishedSites(srcDir);
  const selected = filterSites(
    source.map((m) => m.site),
    o.filter,
  );
  const byId = new Map(source.map((m) => [m.site.id, m]));
  await mkdir(runDir, { recursive: true });
  await writeRunInfo(
    runDir,
    {
      runId: o.runId,
      mode: 'reanalyze',
      reanalyzedFrom: o.fromRunId,
      sitesFile: null,
      sitesSha256: null,
      options: { concurrency: o.concurrency, timeoutMs: o.timeoutMs, engine: o.engine ?? 'api' },
      sites: selected,
    },
    now(),
  );

  const todo = selected.filter((s) => !isFinished(path.join(runDir, s.id), false));
  const outcome: RunOutcome = {
    runId: o.runId,
    runDir,
    planned: selected.length,
    scanned: 0,
    skipped: selected.length - todo.length,
    errors: 0,
    kept: 0,
  };
  const ctx = {
    runId: o.runId,
    engine: o.engine ?? ('api' as const),
    watchdogReserveMs: o.watchdogReserveMs ?? WATCHDOG_RESERVE_MS,
    now,
  };
  await runPool(
    todo,
    { concurrency: o.concurrency, pauseMs: 0, sleep: deps.sleep, shouldStop: deps.shouldStop },
    async (site) => {
      const src = byId.get(site.id) as SiteMeta;
      const from = path.join(srcDir, site.id);
      const job = jobFor(site, runDir, 'reanalyze', o.timeoutMs);
      await mkdir(job.dir, { recursive: true });
      const srcSnapshot = path.join(from, FILES.snapshot);
      const kept: SiteMeta['kept'] | null =
        src.scanStatus === 'failed' ? 'original-failed' : !existsSync(srcSnapshot) ? 'no-snapshot' : null;
      if (kept) {
        if (existsSync(path.join(from, FILES.report))) {
          await copyFile(path.join(from, FILES.report), job.reportPath);
        }
        const meta: SiteMeta = {
          ...src,
          metaVersion: 1,
          runId: o.runId,
          mode: 'reanalyze',
          reanalyzedFrom: o.fromRunId,
          kept,
          scanDurationMs: src.scanDurationMs ?? src.durationMs,
          files: { report: existsSync(job.reportPath), snapshot: false },
        };
        await writeJsonAtomic(path.join(job.dir, FILES.meta), meta);
        outcome.kept++;
        deps.log(`${site.id} kept (${kept})`);
        return;
      }
      await copyFile(srcSnapshot, job.snapshotPath);
      const meta = await runSite(job, deps.scanner, ctx, {
        reanalyzedFrom: o.fromRunId,
        scanDurationMs: src.scanDurationMs ?? src.durationMs,
      });
      outcome.scanned++;
      if (meta.error) outcome.errors++;
      deps.log(progressLine(outcome.skipped + outcome.scanned + outcome.kept, selected.length, meta));
    },
  );
  return outcome;
}
