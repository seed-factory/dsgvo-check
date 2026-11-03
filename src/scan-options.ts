/** Scan options: what callers pass, the defaults, validation and the subset recorded in the report. */
import path from 'node:path';
import { DEFAULT_DATA_DIR } from './core/data/load.ts';
import type { SeverityOverride } from './core/evaluation/assess.ts';
import type { CheckRegistry } from './core/evaluation/registry.ts';
import type { ReportFormat } from './core/report/reporter.ts';
import {
  type AssumeRegion,
  type FailOn,
  FailOnSchema,
  type Lang,
  type ReportScanOptions,
  type SandboxMode,
} from './core/report/schema.ts';
import { InvalidInputError } from './core/runtime/errors.ts';
import type { Logger } from './core/runtime/logger.ts';
import type { Collectors } from './core/snapshot/collector.ts';
import { defaultNetworkConfig, type NetworkConfig } from './core/url/net.ts';

export interface ScanOptions {
  /** Target URL (required unless `fromSnapshot`). */
  url?: string;
  failOn?: FailOn;
  formats?: ReportFormat[];
  outDir?: string;
  maxPages?: number;
  timeoutMs?: number;
  proxy?: string | null;
  assumeRegion?: AssumeRegion | null;
  lang?: Lang;
  strict?: boolean;
  sandbox?: SandboxMode;
  screenshots?: boolean;
  saveSnapshot?: string | null;
  fromSnapshot?: string | null;
  /** Restrict to these check ids (`--checks`). */
  checks?: string[] | null;
  /** Severity overrides (`CHECK-ID` or `CHECK-ID.variant`). */
  overrides?: SeverityOverride[];
  // programmatic only (tests, canary)
  network?: Partial<NetworkConfig>;
  dataDir?: string;
  now?: () => Date;
  registry?: CheckRegistry;
  collectors?: Partial<Collectors>;
  log?: Logger;
  /** How long to wait for a collector's partial result after the global timeout (default `ABORT_GRACE_MS`). */
  abortGraceMs?: number;
}

export interface ResolvedScanOptions {
  url: string | null;
  failOn: FailOn;
  formats: ReportFormat[];
  outDir: string;
  maxPages: number;
  timeoutMs: number;
  proxy: string | null;
  assumeRegion: AssumeRegion | null;
  lang: Lang;
  strict: boolean;
  sandbox: SandboxMode;
  screenshots: boolean;
  saveSnapshot: string | null;
  fromSnapshot: string | null;
  checks: string[] | null;
  overrides: SeverityOverride[];
  network: NetworkConfig;
  dataDir: string;
  now: () => Date;
  abortGraceMs: number;
}

export const DEFAULTS = {
  failOn: 'critical' as FailOn,
  formats: ['console', 'json'] as ReportFormat[],
  outDir: './dsgvo-check-report',
  maxPages: 6,
  timeoutMs: 8 * 60_000,
  lang: 'de' as const,
  sandbox: 'require' as const,
};

/** Reserve on top of `--timeout` for writing reports. */
export const REPORT_WRITE_RESERVE_MS = 30_000;

/** After the global timeout, collectors get this long to stop and hand over what they have; must stay well below `REPORT_WRITE_RESERVE_MS`. */
export const ABORT_GRACE_MS = 10_000;

export function resolveOptions(o: ScanOptions): ResolvedScanOptions {
  const failOn = o.failOn ?? DEFAULTS.failOn;
  if (!FailOnSchema.options.includes(failOn)) {
    throw new InvalidInputError('invalid-fail-on', { value: failOn });
  }
  const maxPages = o.maxPages ?? DEFAULTS.maxPages;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    throw new InvalidInputError('invalid-max-pages', { value: String(maxPages) });
  }
  const timeoutMs = o.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidInputError('invalid-timeout', { value: String(timeoutMs) });
  }
  if (!o.url && !o.fromSnapshot) throw new InvalidInputError('target-missing');
  const proxy = o.proxy ?? null;
  // The supported proxy transport is HTTP CONNECT.
  if (proxy !== null && !/^http:\/\/[^\s]+$/i.test(proxy)) {
    throw new InvalidInputError('invalid-proxy');
  }
  return {
    url: o.url ?? null,
    failOn,
    formats: o.formats ?? DEFAULTS.formats,
    outDir: path.resolve(o.outDir ?? DEFAULTS.outDir),
    maxPages,
    timeoutMs,
    proxy,
    assumeRegion: o.assumeRegion ?? null,
    lang: o.lang ?? DEFAULTS.lang,
    strict: o.strict ?? false,
    sandbox: o.sandbox ?? DEFAULTS.sandbox,
    screenshots: o.screenshots ?? true,
    saveSnapshot: o.saveSnapshot ?? null,
    fromSnapshot: o.fromSnapshot ?? null,
    checks: o.checks && o.checks.length > 0 ? o.checks : null,
    overrides: o.overrides ?? [],
    network: { ...defaultNetworkConfig(proxy), ...o.network },
    dataDir: o.dataDir ?? DEFAULT_DATA_DIR,
    now: o.now ?? (() => new Date()),
    abortGraceMs: Math.max(0, o.abortGraceMs ?? ABORT_GRACE_MS),
  };
}

export function reportOptions(o: ResolvedScanOptions): ReportScanOptions {
  return {
    failOn: o.failOn,
    strict: o.strict,
    lang: o.lang,
    formats: o.formats,
    maxPages: o.maxPages,
    timeoutMs: o.timeoutMs,
    sandbox: o.sandbox,
    screenshots: o.screenshots,
    checks: o.checks,
    proxy: o.proxy !== null,
    assumeRegion: o.assumeRegion,
    fromSnapshot: o.fromSnapshot !== null,
    overrides: o.overrides.map((x) => ({ rule: x.rule, severity: x.severity })),
  };
}
