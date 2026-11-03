/** Command-line options of the canary runner (`node scripts/canary/main.ts`). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type AssumeRegion,
  AssumeRegionSchema,
  type SandboxMode,
  SandboxModeSchema,
} from '../../src/core/report/schema.ts';
import { parseDuration } from '../../src/core/runtime/duration.ts';
import type { Engine } from './results.ts';
import { DEFAULT_SITES_FILE, REGIONS, type Region } from './sites.ts';

export const DEFAULT_RESULTS_DIR = fileURLToPath(new URL('../../canary/results/', import.meta.url));
export const DEFAULT_CLI_PATH = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 5;
export const DEFAULT_PAUSE_MS = 5_000;
/** Never faster than one navigation per 1.5 s; keep at least that between site starts. */
export const MIN_PAUSE_MS = 1_500;
export const DEFAULT_TIMEOUT_MS = 4 * 60_000;

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
  sandbox: SandboxMode;
  screenshots: boolean;
  assumeRegion: AssumeRegion | null;
  retryErrors: boolean;
  reanalyze: string | null;
  dryRun: boolean;
  confirm: boolean;
  help: boolean;
}

export const RUNNER_USAGE = `Usage: node scripts/canary/main.ts [options]
       node scripts/canary/main.ts summary [runId] [--help]

Passive canary run over canary/sites.yaml (see README.md, section Canary). Live scans need --confirm.

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
  const sandbox = SandboxModeSchema.safeParse(values.sandbox ?? 'require');
  if (!sandbox.success) throw new Error(`--sandbox: expected ${SandboxModeSchema.options.join('|')}`);
  const assumeRegion = AssumeRegionSchema.nullable().safeParse(values['assume-region'] ?? null);
  if (!assumeRegion.success)
    throw new Error(`--assume-region: expected ${AssumeRegionSchema.options.join('|')}`);
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
    sandbox: sandbox.data,
    screenshots: !values['no-screenshots'],
    assumeRegion: assumeRegion.data,
    retryErrors: Boolean(values['retry-errors']),
    reanalyze,
    dryRun: Boolean(values['dry-run']),
    confirm: Boolean(values.confirm),
    help: Boolean(values.help),
  };
}
