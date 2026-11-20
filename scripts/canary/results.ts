/**
 * Canary run directory: layout (run.json, <siteId>/{report.json,snapshot.json,meta.json,scan.log}), records and atomic
 * JSON I/O. meta.json is written last: its presence marks a finished site for resume.
 */
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { TrustStore } from '../../src/core/snapshot/index.ts';
import type { CanarySite, ExpectedCmp, Region, Sector, SizeClass } from './sites.ts';

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

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Read a JSON file; null when missing or invalid. */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
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
