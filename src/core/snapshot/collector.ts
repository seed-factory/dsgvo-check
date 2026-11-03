/** Collector contract: collectors do all I/O, redact before storing and return snapshot sections; they know nothing about checks. */

import type { CmpSection } from '../../cmp/types.ts';
import type { Config } from '../config/schema.ts';
import type { AssumeRegion, Lang, MessageParams, SandboxMode } from '../report/schema.ts';
import type { FatalReason } from '../runtime/errors.ts';
import type { Logger } from '../runtime/logger.ts';
import type { NetworkConfig } from '../url/net.ts';
import type { BrowserPlan, BrowserSection, DocumentsSection } from './browser.ts';
import type { DnsSection } from './dns.ts';
import type { HttpSection, ProbeRecord } from './http.ts';
import type { CollectorError, DiagnosticInput, Snapshot, TargetInfo } from './index.ts';
import type { TlsSection } from './tls.ts';

export interface CollectorOptions {
  maxPages: number;
  screenshots: boolean;
  sandbox: SandboxMode;
  lang: Lang;
  assumeRegion: AssumeRegion | null;
}

export interface CollectorContext {
  /** Target for navigation as given (query included); never store it, sections hold sanitized values. `ctx.snapshot.target` is the redacted copy. */
  target: TargetInfo;
  options: CollectorOptions;
  network: NetworkConfig;
  /** Operator settings of this scan (timeouts, limits); `deps` of a collector factory override them in tests. */
  config: Config;
  /** HTTP/TLS UA and the token appended to the browser UA. */
  userAgent: { http: string; token: string };
  /** Aborted on the global `--timeout`: collectors stop promptly and return what they have; a result within `config.scan.abortGraceMs` is kept as `partial` / `timeout`. */
  signal: AbortSignal;
  /** Epoch ms when the scan deadline is reached. */
  deadline: number;
  /** Directory for artifacts (screenshots); paths in the snapshot are relative to the report out dir. */
  artifactsDir: string;
  /** Relative path prefix of `artifactsDir` inside the out dir (e.g. `artifacts`). */
  artifactsRelDir: string;
  now: () => Date;
  /** Milliseconds since `scan.startedAt` on a monotonic clock, the one time scale for all phases. Collectors run without the orchestrator start their own. */
  clock?: () => number;
  log: Logger;
  /** Sections collected earlier in this scan (http/tls/dns run before the browser). Read-only. */
  snapshot: Readonly<Snapshot>;
}

export interface FatalSignal {
  reason: FatalReason;
  /** `scan.failure.code`, e.g. `start-page-unreachable`, `start-page-blocked`, `sandbox-failed`. */
  code: string;
  /** Parameters of the `failure.<code>` text in test/data/texts. */
  params?: MessageParams;
}

export interface CollectorResult<S> {
  status: 'ok' | 'partial' | 'error' | 'skipped';
  /** e.g. `not-implemented`, `tls-blocked`, `timeout`. */
  reason?: string;
  sections: S;
  diagnostics?: DiagnosticInput[];
  probes?: ProbeRecord[];
  error?: CollectorError;
  /** Scan-level failure: unreachable or blocked start page, sandbox unavailable, browser missing. */
  fatal?: FatalSignal;
}

export interface BrowserSections {
  browser?: BrowserSection;
  documents?: DocumentsSection;
  cmp?: CmpSection;
  plan?: BrowserPlan;
  /** Start page after redirects. */
  finalUrl?: string;
}

export type BrowserCollector = (ctx: CollectorContext) => Promise<CollectorResult<BrowserSections>>;
export type HttpCollector = (ctx: CollectorContext) => Promise<CollectorResult<{ http?: HttpSection }>>;
export type TlsCollector = (ctx: CollectorContext) => Promise<CollectorResult<{ tls?: TlsSection }>>;
export type DnsCollector = (ctx: CollectorContext) => Promise<CollectorResult<{ dns?: DnsSection }>>;

export interface Collectors {
  browser: BrowserCollector;
  http: HttpCollector;
  tls: TlsCollector;
  dns: DnsCollector;
}

export function skipped<S>(reason: string, sections: S): CollectorResult<S> {
  return { status: 'skipped', reason, sections };
}
