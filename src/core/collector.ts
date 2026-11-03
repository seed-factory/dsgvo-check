/**
 * Collector contract. Collectors do all I/O, redact before anything is stored and return snapshot sections.
 * They know nothing about checks.
 */

import type { CmpSection } from '../cmp/types.ts';
import type { FatalReason } from './errors.ts';
import type { Logger } from './logger.ts';
import type { NetworkConfig } from './net.ts';
import type { MessageParams } from './report-schema.ts';
import type { CollectorError, DiagnosticInput, Snapshot, TargetInfo } from './snapshot.ts';
import type { BrowserPlan, BrowserSection, DocumentsSection } from './snapshot-browser.ts';
import type { DnsSection } from './snapshot-dns.ts';
import type { HttpSection, ProbeRecord } from './snapshot-http.ts';
import type { TlsSection } from './snapshot-tls.ts';

export interface CollectorOptions {
  maxPages: number;
  screenshots: boolean;
  sandbox: 'require' | 'off';
  lang: 'de' | 'en';
  assumeRegion: 'eea' | 'de' | null;
}

export interface CollectorContext {
  /**
   * Target for navigation: `url`/`input` as given (query included). Never store them; what goes into sections must be
   * sanitized. `ctx.snapshot.target` is the redacted copy that snapshot and report carry.
   */
  target: TargetInfo;
  options: CollectorOptions;
  network: NetworkConfig;
  /** HTTP/TLS UA and the token appended to the browser UA. */
  userAgent: { http: string; token: string };
  /**
   * Aborted on the global `--timeout`. Collectors must stop promptly and return what they have: the orchestrator
   * keeps a result that arrives within `ABORT_GRACE_MS` after the abort (status `partial`, reason `timeout`).
   */
  signal: AbortSignal;
  /** Epoch ms when the scan deadline is reached. */
  deadline: number;
  /** Directory for artifacts (screenshots); paths in the snapshot are relative to the report out dir. */
  artifactsDir: string;
  /** Relative path prefix of `artifactsDir` inside the out dir (e.g. `artifacts`). */
  artifactsRelDir: string;
  now: () => Date;
  /**
   * Milliseconds since `scan.startedAt` on a monotonic clock: the one time scale of 5.3 `tMs` for all phases and
   * collectors. Optional for collectors run without the orchestrator (they then start their own clock).
   */
  clock?: () => number;
  log: Logger;
  /** Sections collected earlier in this scan (http/tls/dns run before the browser). Read-only. */
  snapshot: Readonly<Snapshot>;
}

export interface FatalSignal {
  reason: FatalReason;
  /** `scan.failure.code`, e.g. `start-page-unreachable`, `start-page-blocked`, `sandbox-failed`. */
  code: string;
  /** Parameters of the `failure.<code>` text in data/texts. */
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
  /** Scan-level failure (5.2): unreachable / blocked start page, sandbox unavailable, browser missing. */
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
