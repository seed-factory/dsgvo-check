/**
 * Canary runner library: argument parsing, polite job pool, per-site execution with a watchdog, resume and
 * reanalysis from saved snapshots. The entry point is scripts/canary.ts; tests inject a fake `SiteScanner`.
 *
 * Layout: canary/results/<runId>/run.json and canary/results/<runId>/<siteId>/{report.json,snapshot.json,meta.json,scan.log}.
 * meta.json is written last (atomically): its presence marks a finished site for resume.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { removeProfilesOfPid } from '../src/collectors/browser/launch.ts';
import { parseDuration } from '../src/core/duration.ts';
import type { Logger } from '../src/core/logger.ts';
import { detectTrustStore, type TrustStore, useSystemCaOption } from '../src/core/snapshot.ts';
import { TOOL_VERSION } from '../src/core/version.ts';
import { type ScanOptions, scan, writeReports } from '../src/scan.ts';
import {
  type CanarySite,
  DEFAULT_SITES_FILE,
  type ExpectedCmp,
  filterSites,
  REGIONS,
  type Region,
  type Sector,
  type SiteFilter,
  type SizeClass,
} from './canary-sites.ts';

export const DEFAULT_RESULTS_DIR = fileURLToPath(new URL('../canary/results/', import.meta.url));
export const DEFAULT_CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 5;
export const DEFAULT_PAUSE_MS = 5_000;
/** Never faster than one navigation per 1.5 s; keep at least that between site starts. */
export const MIN_PAUSE_MS = 1_500;
export const DEFAULT_TIMEOUT_MS = 4 * 60_000;
/** Runner watchdog on top of the scan timeout (the CLI itself reserves 30 s for writing reports). */
export const WATCHDOG_RESERVE_MS = 60_000;
/**
 * Time between SIGTERM and SIGKILL of a child scan. SIGTERM lets the CLI close its browser and remove the temp
 * profile (cookies of the scanned site); SIGKILL cannot be handled, so the child gets time to finish.
 */
export const KILL_GRACE_MS = 30_000;

export const FILES = {
  run: 'run.json',
  report: 'report.json',
  snapshot: 'snapshot.json',
  meta: 'meta.json',
  log: 'scan.log',
} as const;

export type Engine = 'api' | 'cli';
export type ExitCode = 0 | 1 | 2;
export type ScanStatus = 'complete' | 'partial' | 'failed';

/** Site attributes copied into every meta.json, so a run directory is self-describing. */
export interface SiteRef {
  id: string;
  url: string;
  region: Region;
  country: string;
  sector: Sector;
  sizeClass: SizeClass;
  expectedCmp: ExpectedCmp;
}

export interface RunnerError {
  code: string;
  message: string;
}

export interface SiteMeta {
  metaVersion: 1;
  runId: string;
  mode: 'scan' | 'reanalyze';
  site: SiteRef;
  engine: Engine;
  toolVersion: string;
  startedAt: string;
  finishedAt: string;
  /** Wall time of this runner step (scan, or reanalysis). */
  durationMs: number;
  /** Wall time of the live scan (equals durationMs in scan mode, copied from the source run on reanalysis). */
  scanDurationMs: number;
  exitCode: ExitCode | null;
  scanStatus: ScanStatus | null;
  files: { report: boolean; snapshot: boolean };
  /** Runner-level problem (scanner threw, watchdog, report missing). Scan failures are in report.json. */
  error: RunnerError | null;
  reanalyzedFrom?: string;
  /** Reanalysis kept the source result instead of recomputing it. */
  kept?: 'original-failed' | 'no-snapshot';
}

export interface SiteJob {
  site: SiteRef;
  mode: 'scan' | 'reanalyze';
  dir: string;
  reportPath: string;
  /** Scan: where to save the snapshot. Reanalyze: the snapshot to replay. */
  snapshotPath: string;
  logPath: string;
  timeoutMs: number;
}

export interface SiteScanResult {
  exitCode: ExitCode | null;
  scanStatus?: ScanStatus;
}

export type SiteScanner = (job: SiteJob, signal: AbortSignal) => Promise<SiteScanResult>;

export interface RunnerDeps {
  scanner: SiteScanner;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  /** Checked before each new site (SIGINT). Running sites finish. */
  shouldStop?: () => boolean;
}

export interface RunnerArgs {
  sitesFile: string;
  expectedCount: number | null;
  resultsDir: string;
  runId: string;
  concurrency: number;
  pauseMs: number;
  timeoutMs: number;
  regions: Region[] | null;
  ids: string[] | null;
  limit: number | null;
  engine: Engine;
  cliPath: string;
  sandbox: 'require' | 'off';
  screenshots: boolean;
  assumeRegion: 'eea' | 'de' | null;
  retryErrors: boolean;
  reanalyze: string | null;
  dryRun: boolean;
  confirm: boolean;
  help: boolean;
}

export const RUNNER_USAGE = `Usage: node scripts/canary.ts [options]

Passive canary run over canary/sites.yaml (see canary/README.md). Live scans need --confirm.

  --confirm                 really scan the live sites (without it: print the plan only)
  --dry-run                 print the plan and exit
  --run-id <id>             name of the run; an existing id resumes it (default: UTC timestamp)
  --region <list>           de,eu,non-eu
  --id <list>               site ids from sites.yaml
  --limit <n>               first n sites after the other filters
  --concurrency <n>         parallel sites, 1..${MAX_CONCURRENCY} (default ${DEFAULT_CONCURRENCY})
  --pause <duration>        pause before each site start per worker, >= 1.5s (default 5s)
  --timeout <duration>      scan timeout per site (default 4m)
  --engine api|cli          programmatic scan() in-process (default) or one CLI process per site
  --cli <path>              CLI entry for --engine cli (default src/cli.ts)
  --sandbox require|off     Chromium sandbox (default require)
  --no-screenshots          do not store banner screenshots
  --assume-region eea|de    passed to the scanner
  --retry-errors            re-run sites whose meta.json records a runner error
  --reanalyze <runId>       recompute checks from the saved snapshots of <runId>, no network
  --sites <file>            corpus file (default canary/sites.yaml)
  --expected-count <n>      require exactly n corpus entries (default: no fixed size)
  --results <dir>           results directory (default canary/results)
`;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function newRunId(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
}

function list(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function intIn(name: string, value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`--${name}: expected an integer, got "${value}"`);
  const n = Number(value);
  if (n < min || n > max) throw new Error(`--${name}: expected ${min}..${max}, got ${n}`);
  return n;
}

function checkRunId(name: string, id: string): string {
  if (!RUN_ID_RE.test(id) || id.includes('..')) throw new Error(`--${name}: invalid run id "${id}"`);
  return id;
}

export function parseRunnerArgs(argv: readonly string[], now: Date): RunnerArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      sites: { type: 'string' },
      'expected-count': { type: 'string' },
      results: { type: 'string' },
      'run-id': { type: 'string' },
      concurrency: { type: 'string' },
      pause: { type: 'string' },
      timeout: { type: 'string' },
      region: { type: 'string' },
      id: { type: 'string' },
      limit: { type: 'string' },
      engine: { type: 'string' },
      cli: { type: 'string' },
      sandbox: { type: 'string' },
      'no-screenshots': { type: 'boolean' },
      'assume-region': { type: 'string' },
      'retry-errors': { type: 'boolean' },
      reanalyze: { type: 'string' },
      'dry-run': { type: 'boolean' },
      confirm: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const regions = list(values.region);
  for (const r of regions ?? []) {
    if (!(REGIONS as readonly string[]).includes(r)) throw new Error(`--region: unknown region "${r}"`);
  }
  const engine = values.engine ?? 'api';
  if (engine !== 'api' && engine !== 'cli') throw new Error(`--engine: expected api|cli, got "${engine}"`);
  const sandbox = values.sandbox ?? 'require';
  if (sandbox !== 'require' && sandbox !== 'off') throw new Error(`--sandbox: expected require|off`);
  const assumeRegion = values['assume-region'] ?? null;
  if (assumeRegion !== null && assumeRegion !== 'eea' && assumeRegion !== 'de') {
    throw new Error('--assume-region: expected eea|de');
  }
  const pauseMs = values.pause === undefined ? DEFAULT_PAUSE_MS : parseDuration(values.pause);
  if (pauseMs < MIN_PAUSE_MS) throw new Error(`--pause: at least ${MIN_PAUSE_MS} ms`);
  const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(values.timeout);
  const reanalyze = values.reanalyze === undefined ? null : checkRunId('reanalyze', values.reanalyze);
  const stamp = newRunId(now);
  const runId =
    values['run-id'] !== undefined
      ? checkRunId('run-id', values['run-id'])
      : reanalyze
        ? `${reanalyze}.re-${stamp}`
        : stamp;

  return {
    sitesFile: path.resolve(values.sites ?? DEFAULT_SITES_FILE),
    expectedCount:
      values['expected-count'] === undefined
        ? null
        : intIn('expected-count', values['expected-count'], 1, Number.MAX_SAFE_INTEGER),
    resultsDir: path.resolve(values.results ?? DEFAULT_RESULTS_DIR),
    runId,
    concurrency:
      values.concurrency === undefined
        ? DEFAULT_CONCURRENCY
        : intIn('concurrency', values.concurrency, 1, MAX_CONCURRENCY),
    pauseMs,
    timeoutMs,
    regions: regions as Region[] | null,
    ids: list(values.id),
    limit: values.limit === undefined ? null : intIn('limit', values.limit, 1, 10_000),
    engine,
    cliPath: path.resolve(values.cli ?? DEFAULT_CLI_PATH),
    sandbox,
    screenshots: !values['no-screenshots'],
    assumeRegion,
    retryErrors: Boolean(values['retry-errors']),
    reanalyze,
    dryRun: Boolean(values['dry-run']),
    confirm: Boolean(values.confirm),
    help: Boolean(values.help),
  };
}

export interface ScannerOptions {
  sandbox: 'require' | 'off';
  screenshots: boolean;
  assumeRegion: 'eea' | 'de' | null;
  lang?: 'de' | 'en';
  /** Pause between SIGTERM and SIGKILL of a child scan (default `KILL_GRACE_MS`). */
  killGraceMs?: number;
}

/** CA setting of the scanning process, recorded in run.json: the TLS verdicts depend on it. */
export interface CaSetting {
  trustStore: TrustStore;
  /** `NODE_USE_SYSTEM_CA` as set, or null. */
  nodeUseSystemCa: string | null;
  /** `--use-system-ca` is in effect as an option (command line or `NODE_OPTIONS`; a later `--no-use-system-ca` cancels it). */
  useSystemCaFlag: boolean;
  /** Whether `NODE_EXTRA_CA_CERTS` is set (the path is not recorded). */
  extraCaCerts: boolean;
}

/**
 * The CA setting the scans of this run see. A child scan (`cli` engine) inherits the environment of the runner but
 * not its command-line flags, so only the environment counts there.
 */
export function caSetting(
  engine: Engine,
  env: Readonly<Record<string, string | undefined>> = process.env,
  execArgv: readonly string[] = process.execArgv,
): CaSetting {
  const argv = engine === 'cli' ? [] : execArgv;
  return {
    trustStore: detectTrustStore(env, argv),
    nodeUseSystemCa: env.NODE_USE_SYSTEM_CA ?? null,
    useSystemCaFlag: useSystemCaOption(env, argv),
    extraCaCerts: Boolean(env.NODE_EXTRA_CA_CERTS),
  };
}

/** Logger that buffers lines for `scan.log` (keeps parallel scans from interleaving on stderr). */
function bufferLogger(lines: string[]): Logger {
  const at = (level: string) => (msg: string) => {
    lines.push(`${new Date().toISOString()} ${level}: ${msg}`);
  };
  return { debug: () => {}, info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * In-process scanner via the programmatic API. `scanOverrides` exist for offline tests (fake collectors,
 * lookups, registry). scan() stops collectors at its own deadline; the runner watchdog is a last resort.
 */
export function apiScanner(o: ScannerOptions & { scanOverrides?: Partial<ScanOptions> }): SiteScanner {
  const lang = o.lang ?? 'de';
  return async (job) => {
    const lines: string[] = [];
    try {
      const target: Partial<ScanOptions> =
        job.mode === 'scan'
          ? { url: job.site.url, saveSnapshot: job.snapshotPath }
          : { fromSnapshot: job.snapshotPath };
      const result = await scan({
        ...target,
        failOn: 'none',
        formats: ['json'],
        outDir: job.dir,
        timeoutMs: job.timeoutMs,
        lang,
        sandbox: o.sandbox,
        screenshots: o.screenshots,
        assumeRegion: o.assumeRegion,
        log: bufferLogger(lines),
        ...o.scanOverrides,
      });
      const written = await writeReports(result, { outDir: job.dir, formats: ['json'], lang });
      return { exitCode: written.exitCode, scanStatus: result.report.scan.status };
    } finally {
      if (lines.length > 0) await writeFile(job.logPath, `${lines.join('\n')}\n`);
    }
  };
}

/** Scanner that runs the CLI in a child process per site (isolation; killed by the watchdog). */
export function cliScanner(o: ScannerOptions & { cliPath: string }): SiteScanner {
  const lang = o.lang ?? 'de';
  return (job, signal) =>
    new Promise((resolve, reject) => {
      const common = ['--fail-on', 'none', '--format', 'json', '--out', job.dir, '--lang', lang];
      const args =
        job.mode === 'scan'
          ? [
              job.site.url,
              ...common,
              '--timeout',
              `${job.timeoutMs}ms`,
              '--sandbox',
              o.sandbox,
              '--save-snapshot',
              job.snapshotPath,
              ...(o.screenshots ? [] : ['--no-screenshots']),
              ...(o.assumeRegion ? ['--assume-region', o.assumeRegion] : []),
            ]
          : ['--from-snapshot', job.snapshotPath, ...common];
      const out = createWriteStream(job.logPath);
      const child = spawn(process.execPath, [o.cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      const kill = () => {
        child.kill('SIGTERM');
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, o.killGraceMs ?? KILL_GRACE_MS);
        hard.unref();
        child.once('close', () => clearTimeout(hard));
      };
      signal.addEventListener('abort', kill, { once: true });
      child.on('error', (err) => {
        signal.removeEventListener('abort', kill);
        out.end();
        reject(err);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', kill);
        out.end();
        // A child that was killed ran no exit hook: its temp browser profile (cookies of the site) is still there.
        if (child.pid !== undefined) removeProfilesOfPid(child.pid);
        resolve({ exitCode: code === 0 || code === 1 || code === 2 ? code : null });
      });
    });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function siteRef(s: CanarySite | SiteRef): SiteRef {
  return {
    id: s.id,
    url: s.url,
    region: s.region,
    country: s.country,
    sector: s.sector,
    sizeClass: s.sizeClass,
    expectedCmp: s.expectedCmp,
  };
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

export interface RunInfo {
  runVersion: 1;
  runId: string;
  mode: 'scan' | 'reanalyze';
  reanalyzedFrom?: string;
  createdAt: string;
  updatedAt: string;
  toolVersion: string;
  node: string;
  platform: string;
  sitesFile: string | null;
  sitesSha256: string | null;
  options: Record<string, unknown>;
  /** CA setting of the scanning process; absent in runs of older versions and in reanalysis runs. */
  ca?: CaSetting;
  sites: SiteRef[];
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

/** Read a JSON file; null when missing or invalid. */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
