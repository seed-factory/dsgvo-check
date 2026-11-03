/** Raw redacted facts of one scan: collectors fill the sections, `derive` adds `derived`, checks read what they list in `requires`. */

import type { CmpSection } from '../../cmp/types.ts';
import type { DerivedSection } from '../../derive/types.ts';
import type { AssumeRegion, SandboxMode } from '../report/schema.ts';
import type { BrowserPlan, BrowserSection, DocumentsSection } from './browser.ts';
import type { CollectorStatus, IsoTimestamp, SanitizedUrl } from './common.ts';
import type { DnsSection } from './dns.ts';
import type { HttpSection, ProbeRecord } from './http.ts';
import type { TlsSection } from './tls.ts';

export type * from './common.ts';

export const SNAPSHOT_VERSION = 1;

export interface TargetInfo {
  /** URL as given by the user; redacted in snapshot and report (credentials are rejected). */
  input: string;
  /** Normalized URL without fragment; redacted like any URL in snapshot and report. */
  url: string;
  scheme: 'http' | 'https';
  /** Host in URL form (`URL.hostname`, IPv6 literals in brackets); `bareHost()` for DNS and sockets. */
  host: string;
  /** Registrable domain (eTLD+1, PSL incl. private suffixes); null for IPs / unknown suffixes. */
  etld1: string | null;
  /** Start page after redirects (filled by the browser collector, else by HTTP). */
  finalUrl: SanitizedUrl | null;
  finalHost: string | null;
}

export interface SnapshotEgress {
  mode: 'direct' | 'proxy';
  region: 'unknown' | 'asserted';
  assertedRegion?: AssumeRegion;
  source: string;
}

/** Root certificates the Node process trusts for TLS checks: Node's bundled list or the operating system's. */
export type TrustStore = 'node-bundled' | 'system';

export interface SnapshotEnvironment {
  egress: SnapshotEgress;
  sandbox: { mode: SandboxMode; active: boolean | null };
  userAgent: { http: string; browser: string | null };
  locale: string;
  timezone: string;
  node: string;
  platform: string;
  /** CA setting of the scanning process (TLS-02 evidence). Absent in older snapshots. */
  trustStore?: TrustStore;
}

/** The words of `NODE_OPTIONS` as Node splits them: spaces separate, `"` quotes (a backslash inside escapes), `'` is ordinary. */
function nodeOptionsWords(raw: string): string[] {
  const words: string[] = [];
  let quoted = false;
  let startsWord = true;
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i] as string;
    if (c === '\\' && quoted) {
      if (i + 1 === raw.length) break;
      c = raw[++i] as string;
    } else if (c === ' ' && !quoted) {
      startsWord = true;
      continue;
    } else if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (startsWord) words.push(c);
    else words[words.length - 1] += c;
    startsWord = false;
  }
  return words;
}

/** Name of a Node option as the parser reads it: no `=value`, underscores are dashes. */
const optionName = (word: string): string => {
  const eq = word.indexOf('=');
  return (eq < 0 ? word : word.slice(0, eq)).replaceAll('_', '-');
};

/**
 * Trust store as Node resolves it: `NODE_USE_SYSTEM_CA=1` is the start value, then `NODE_OPTIONS` and the command line
 * apply in that order (the last `--(no-)use-system-ca` wins). OpenSSL's own store counts as `system`; extra roots are recorded apart.
 */
export function detectTrustStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
  execArgv: readonly string[] = process.execArgv,
): TrustStore {
  const { systemFlag, openssl } = caOptions(env, execArgv);
  return (systemFlag ?? env.NODE_USE_SYSTEM_CA === '1') || openssl ? 'system' : 'node-bundled';
}

/** Whether `--use-system-ca` is in effect as an option, read like `detectTrustStore` does (not the env variable or OpenSSL's store). */
export function useSystemCaOption(
  env: Readonly<Record<string, string | undefined>> = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  return caOptions(env, execArgv).systemFlag === true;
}

/** The last `--(no-)use-system-ca` (null if there is none) and the state of `--use-openssl-ca`, in Node's order. */
function caOptions(
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[],
): { systemFlag: boolean | null; openssl: boolean } {
  let systemFlag: boolean | null = null;
  let openssl = false;
  for (const word of [...nodeOptionsWords(env.NODE_OPTIONS ?? ''), ...execArgv]) {
    switch (optionName(word)) {
      case '--use-system-ca':
        systemFlag = true;
        break;
      case '--no-use-system-ca':
        systemFlag = false;
        break;
      case '--use-openssl-ca':
        openssl = true;
        break;
      case '--no-use-openssl-ca':
        openssl = false;
        break;
    }
  }
  return { systemFlag, openssl };
}

export interface ScanPlan {
  browser: BrowserPlan | null;
  probes: ProbeRecord[];
}

export type CollectorName = 'browser' | 'http' | 'tls' | 'dns';

/** Diagnostic raised during collection (SCAN-BOTMODE, SCAN-GEO, SCAN-BLOCKED on subpages, SCAN-THROTTLED…). */
export interface DiagnosticInput {
  code: `SCAN-${string}`;
  /** Check ids whose result is affected. */
  affects: string[];
  params?: Record<string, string | number | boolean | null>;
}

export interface Snapshot {
  snapshotVersion: typeof SNAPSHOT_VERSION;
  tool: { name: 'dsgvo-check'; version: string };
  createdAt: IsoTimestamp;
  target: TargetInfo;
  options: {
    maxPages: number;
    screenshots: boolean;
    assumeRegion: AssumeRegion | null;
    proxy: boolean;
  };
  environment: SnapshotEnvironment;
  plan: ScanPlan;
  collection: Partial<Record<CollectorName, CollectorStatus>>;
  /** Diagnostics recorded by collectors (re-emitted on replay). */
  diagnostics: DiagnosticInput[];
  browser?: BrowserSection;
  documents?: DocumentsSection;
  cmp?: CmpSection;
  http?: HttpSection;
  tls?: TlsSection;
  dns?: DnsSection;
  /** Computed by `derive()`, never saved. */
  derived?: DerivedSection;
}

/** Sections a check can list in `requires`. `target`, `environment`, `plan` are always present. */
export type SnapshotSectionKey =
  | 'target'
  | 'environment'
  | 'plan'
  | 'browser'
  | 'documents'
  | 'cmp'
  | 'http'
  | 'tls'
  | 'dns'
  | 'derived';

export const SNAPSHOT_SECTION_KEYS: readonly SnapshotSectionKey[] = [
  'target',
  'environment',
  'plan',
  'browser',
  'documents',
  'cmp',
  'http',
  'tls',
  'dns',
  'derived',
];

/** Which collector produces which optional section (used to explain a missing section). */
export const SECTION_PRODUCER: Readonly<Record<SnapshotSectionKey, CollectorName | 'derive' | 'core'>> = {
  target: 'core',
  environment: 'core',
  plan: 'core',
  browser: 'browser',
  documents: 'browser',
  cmp: 'browser',
  http: 'http',
  tls: 'tls',
  dns: 'dns',
  derived: 'derive',
};

/** What a check receives: exactly its required sections, all guaranteed present, plus `target`. */
export type SnapshotSlice<K extends SnapshotSectionKey> = {
  readonly [P in K]-?: NonNullable<Snapshot[P]>;
} & { readonly target: TargetInfo };

/** Build the slice for `requires`; returns the list of missing sections instead when any is absent. */
export function sliceSnapshot<K extends SnapshotSectionKey>(
  snapshot: Snapshot,
  requires: readonly K[],
): { ok: true; slice: SnapshotSlice<K> } | { ok: false; missing: K[] } {
  const missing: K[] = [];
  const slice: Record<string, unknown> = { target: snapshot.target };
  for (const key of requires) {
    const value = snapshot[key];
    if (value === undefined || value === null) missing.push(key);
    else slice[key] = value;
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, slice: Object.freeze(slice) as SnapshotSlice<K> };
}

/** Strip computed parts before saving (`derived` is recomputed on replay). */
export function toSavedSnapshot(snapshot: Snapshot): Snapshot {
  const { derived: _derived, ...rest } = snapshot;
  return rest;
}
