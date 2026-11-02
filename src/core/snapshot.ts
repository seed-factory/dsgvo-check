/**
 * Snapshot = raw redacted facts of one scan. Collectors fill sections, `derive` adds `derived`,
 * checks read only the sections listed in `requires`. Saved with `--save-snapshot`, replayed with `--from-snapshot`.
 */

import type { CmpSection } from '../cmp/types.ts';
import type { BrowserPlan, BrowserSection, DocumentsSection } from '../collectors/browser/types.ts';
import type { DnsSection } from '../collectors/dns/types.ts';
import type { HttpSection, ProbeRecord } from '../collectors/http/types.ts';
import type { TlsSection } from '../collectors/tls/types.ts';
import type { DerivedSection } from '../derive/types.ts';
import type { CollectorStatus, IsoTimestamp, SanitizedUrl } from './snapshot-common.ts';

export type * from './snapshot-common.ts';

export const SNAPSHOT_VERSION = 1;

export interface TargetInfo {
  /** URL as given by the user (credentials never allowed). In the snapshot and report: redacted. */
  input: string;
  /** Normalized URL (no fragment). In the snapshot and report: query values redacted like any URL. */
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
  assertedRegion?: 'eea' | 'de';
  source: string;
}

/** Root certificates the Node process trusts for TLS checks: Node's bundled list or the operating system's. */
export type TrustStore = 'node-bundled' | 'system';

export interface SnapshotEnvironment {
  egress: SnapshotEgress;
  sandbox: { mode: 'require' | 'off'; active: boolean | null };
  userAgent: { http: string; browser: string | null };
  locale: string;
  timezone: string;
  node: string;
  platform: string;
  /** CA setting of the scanning process (TLS-02 evidence, 8 reproducibility). Absent in snapshots of older versions. */
  trustStore?: TrustStore;
}

/**
 * The words of `NODE_OPTIONS` the way Node splits them: a space separates words, a double quote opens or closes a
 * quoted part (the quote itself is dropped, a backslash inside it escapes the next character), a single quote is an
 * ordinary character. Node refuses to start with a tab, a newline or an unterminated quote, so those need no care.
 */
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

/** Name of a Node option as the parser reads it: no `=value`, underscores are dashes (`--use_system_ca`). */
const optionName = (word: string): string => {
  const eq = word.indexOf('=');
  return (eq < 0 ? word : word.slice(0, eq)).replaceAll('_', '-');
};

/**
 * The trust store this process uses, as Node resolves it: `NODE_USE_SYSTEM_CA=1` is the starting
 * value; then the options are applied in the order Node applies them, `NODE_OPTIONS` first and the command line
 * after it, so the last of `--use-system-ca` / `--no-use-system-ca` wins and the command line beats `NODE_OPTIONS`.
 * `system` when system roots are in use, else the bundled roots. Pure over its inputs.
 *
 * Two points the two labels cannot express: OpenSSL's own store (`--use-openssl-ca`, the operating system's one on
 * a distribution build of Node) replaces the bundled roots and is counted as `system`; extra roots of
 * `NODE_EXTRA_CA_CERTS` are added to either set and are recorded apart (`run.json` `ca.extraCaCerts`).
 */
export function detectTrustStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
  execArgv: readonly string[] = process.execArgv,
): TrustStore {
  const { systemFlag, openssl } = caOptions(env, execArgv);
  return (systemFlag ?? env.NODE_USE_SYSTEM_CA === '1') || openssl ? 'system' : 'node-bundled';
}

/**
 * Whether `--use-system-ca` is in effect as an option, read like `detectTrustStore` reads it (the last of
 * `--use-system-ca` / `--no-use-system-ca` wins, `NODE_OPTIONS` before the command line): `true` after the first,
 * `false` after the second or without either. `NODE_USE_SYSTEM_CA` and OpenSSL's store are not options of this kind.
 */
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
    assumeRegion: 'eea' | 'de' | null;
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
