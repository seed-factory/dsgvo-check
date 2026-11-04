/** Scan options: what callers pass, the defaults, validation and the subset recorded in the report. */
import path from 'node:path';
import { ConfigError, describeProblems, parseConfigInput } from './core/config/load.ts';
import { configOverrides } from './core/config/overrides.ts';
import { type Config, type ConfigInput, DEFAULT_CONFIG, SECTIONS } from './core/config/schema.ts';
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
  /** Operator settings (src/core/config); the options above win for the settings they name. */
  config?: ConfigInput;
  // programmatic only (tests, canary)
  network?: Partial<NetworkConfig>;
  dataDir?: string;
  now?: () => Date;
  registry?: CheckRegistry;
  collectors?: Partial<Collectors>;
  log?: Logger;
  /** How long to wait for a collector's partial result after the global timeout (default `scan.abortGraceMs`). */
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
  /** The settings in force: `config` of the caller with the options above applied. */
  config: Config;
}

export const DEFAULTS = {
  failOn: DEFAULT_CONFIG.scan.failOn,
  formats: [...DEFAULT_CONFIG.report.formats] as ReportFormat[],
  outDir: DEFAULT_CONFIG.report.outDir,
  maxPages: DEFAULT_CONFIG.scan.maxPages,
  timeoutMs: DEFAULT_CONFIG.scan.timeoutMs,
  lang: DEFAULT_CONFIG.report.lang,
  sandbox: DEFAULT_CONFIG.browser.sandbox,
};

/** The problems of a refused `config` are worded in the language of the scan (`lang` is not validated yet: de unless `en`). */
function validConfig(o: ScanOptions): Config {
  try {
    return parseConfigInput(o.config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const problems = describeProblems(err.problems, o.lang === 'en' ? 'en' : 'de', o.dataDir);
    throw new InvalidInputError('invalid-config', { problems });
  }
}

export function resolveOptions(o: ScanOptions): ResolvedScanOptions {
  const config = validConfig(o);

  const failOn = o.failOn ?? config.scan.failOn;
  if (!FailOnSchema.options.includes(failOn)) {
    throw new InvalidInputError('invalid-fail-on', { value: failOn });
  }
  const maxPages = o.maxPages ?? config.scan.maxPages;
  // `--max-pages` has the bounds of the `scan.maxPages` setting; the schema is their only definition.
  if (!SECTIONS.scan.shape.maxPages.safeParse(maxPages).success) {
    throw new InvalidInputError('invalid-max-pages', { value: String(maxPages) });
  }
  const timeoutMs = o.timeoutMs ?? config.scan.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidInputError('invalid-timeout', { value: String(timeoutMs) });
  }
  if (!o.url && !o.fromSnapshot) throw new InvalidInputError('target-missing');
  const proxy = o.proxy === undefined ? config.scan.proxy : o.proxy;
  // The supported proxy transport is HTTP CONNECT.
  if (proxy !== null && !/^http:\/\/[^\s]+$/i.test(proxy)) {
    throw new InvalidInputError('invalid-proxy');
  }

  const formats = o.formats ?? config.report.formats;
  const lang = o.lang ?? config.report.lang;
  const sandbox = o.sandbox ?? config.browser.sandbox;
  const screenshots = o.screenshots ?? true;
  const outDir = o.outDir ?? config.report.outDir;
  const abortGraceMs = Math.max(0, o.abortGraceMs ?? config.scan.abortGraceMs);

  // The settings of a scan are what `config` says plus what the caller's own options changed.
  const effective: Config = {
    ...config,
    scan: { ...config.scan, failOn, maxPages, timeoutMs, proxy, abortGraceMs },
    browser: { ...config.browser, sandbox },
    report: { ...config.report, formats, outDir, lang },
  };

  return {
    url: o.url ?? null,
    failOn,
    formats,
    outDir: path.resolve(outDir),
    maxPages,
    timeoutMs,
    proxy,
    assumeRegion: o.assumeRegion ?? null,
    lang,
    strict: o.strict ?? false,
    sandbox,
    screenshots,
    saveSnapshot: o.saveSnapshot ?? null,
    fromSnapshot: o.fromSnapshot ?? null,
    checks: o.checks && o.checks.length > 0 ? o.checks : null,
    overrides: o.overrides ?? [],
    network: {
      ...defaultNetworkConfig(proxy),
      ...(config.dns.servers.length > 0 ? { dnsServers: config.dns.servers } : {}),
      ...o.network,
    },
    dataDir: o.dataDir ?? DEFAULT_DATA_DIR,
    now: o.now ?? (() => new Date()),
    abortGraceMs,
    config: effective,
  };
}

export function reportOptions(o: ResolvedScanOptions): ReportScanOptions {
  const settings = configOverrides(o.config);
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
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}
