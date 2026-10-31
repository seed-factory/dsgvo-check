/**
 * Orchestrator (D05): validate → preflight → collectors → snapshot → derive → checks over `requires` slices →
 * assess → gate → report. Fatal conditions end in a minimal `failed` report (5.1) with exit code 2.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { allChecks } from './checks/index.ts';
import { collectBrowser } from './collectors/browser/index.ts';
import { collectDns } from './collectors/dns/index.ts';
import { collectHttp } from './collectors/http/index.ts';
import { collectTls } from './collectors/tls/index.ts';
import {
  assess,
  type ExecutedCheck,
  isGating,
  lockedOverrides,
  mergeDiagnostics,
  type SeverityOverride,
} from './core/assess.ts';
import type { AnyCheck, CheckContext } from './core/check.ts';
import type { CollectorContext, CollectorResult, Collectors } from './core/collector.ts';
import { type CoreData, DEFAULT_DATA_DIR, loadCoreData, loadDataDir, type Texts } from './core/data.ts';
import { errorMessage, type FatalReason, InvalidInputError, ScanFatalError } from './core/errors.ts';
import { executeCheck } from './core/execute.ts';
import { type ExitCode, gate } from './core/gate.ts';
import { createLogger, type Logger } from './core/logger.ts';
import { uiText } from './core/messages.ts';
import { classifyAddress, defaultNetworkConfig, type NetworkConfig } from './core/net.ts';
import { CheckRegistry } from './core/registry.ts';
import { buildFailedReport, buildFullReport } from './core/report.ts';
import type {
  CheckResult,
  Diagnostic,
  Evidence,
  FailOn,
  Finding,
  Report,
  ReportScanOptions,
} from './core/report-schema.ts';
import { REPORT_FILES, type ReporterContext, type ReportFormat } from './core/reporter.ts';
import {
  type CollectorName,
  type DiagnosticInput,
  detectTrustStore,
  SECTION_PRODUCER,
  SNAPSHOT_VERSION,
  type Snapshot,
  type SnapshotSectionKey,
  type TargetInfo,
  toSavedSnapshot,
} from './core/snapshot.ts';
import { bareHost, parseTarget, redactTarget, redactTargetInfo, sanitizeUrl } from './core/url.ts';
import { httpUserAgent, uaToken } from './core/user-agent.ts';
import { TOOL_NAME, TOOL_VERSION } from './core/version.ts';
import { derive } from './derive/index.ts';
import { renderConsole } from './reporters/console.ts';
import { renderHtml } from './reporters/html.ts';
import { renderJson } from './reporters/json.ts';
import { renderSummary } from './reporters/summary.ts';

export interface ScanOptions {
  /** Target URL (required unless `fromSnapshot`). */
  url?: string;
  failOn?: FailOn;
  formats?: ReportFormat[];
  outDir?: string;
  maxPages?: number;
  timeoutMs?: number;
  proxy?: string | null;
  assumeRegion?: 'eea' | 'de' | null;
  lang?: 'de' | 'en';
  strict?: boolean;
  sandbox?: 'require' | 'off';
  screenshots?: boolean;
  saveSnapshot?: string | null;
  fromSnapshot?: string | null;
  /** Restrict to these check ids (`--checks`). */
  checks?: string[] | null;
  /** Severity overrides (`CHECK-ID` or `CHECK-ID.variant`). */
  overrides?: SeverityOverride[];
  // ---- programmatic only (tests, canary)
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
  assumeRegion: 'eea' | 'de' | null;
  lang: 'de' | 'en';
  strict: boolean;
  sandbox: 'require' | 'off';
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

export interface ScanResult {
  report: Report;
  /** Null when the scan failed before a snapshot existed. */
  snapshot: Snapshot | null;
  exitCode: ExitCode;
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

/** Reserve on top of `--timeout` for writing reports (D09). */
export const REPORT_WRITE_RESERVE_MS = 30_000;

/**
 * After the global timeout, collectors get this long to stop and hand over what they collected (5.2: findings
 * collected before the failure are kept). Must stay well below `REPORT_WRITE_RESERVE_MS`.
 */
export const ABORT_GRACE_MS = 10_000;

export function resolveOptions(o: ScanOptions): ResolvedScanOptions {
  const failOn = o.failOn ?? DEFAULTS.failOn;
  if (!['critical', 'warning', 'none'].includes(failOn)) {
    throw new InvalidInputError('invalid-fail-on', `Ungültiger Wert für --fail-on: ${failOn}`);
  }
  const maxPages = o.maxPages ?? DEFAULTS.maxPages;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    throw new InvalidInputError('invalid-max-pages', `Ungültiger Wert für --max-pages: ${maxPages}`);
  }
  const timeoutMs = o.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidInputError('invalid-timeout', `Ungültiger Wert für --timeout: ${timeoutMs}`);
  }
  if (!o.url && !o.fromSnapshot) throw new InvalidInputError('target-missing', 'Keine Ziel-URL angegeben.');
  const proxy = o.proxy ?? null;
  // D11 / consensus 2a: in 1.0 only an HTTP CONNECT proxy (`http://`); SOCKS5 is backlog.
  if (proxy !== null && !/^http:\/\/[^\s]+$/i.test(proxy)) {
    throw new InvalidInputError('invalid-proxy', 'Ungültige Proxy-URL (nur http:// wird unterstützt).');
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

function reportOptions(o: ResolvedScanOptions): ReportScanOptions {
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

const DEFAULT_COLLECTORS: Collectors = {
  browser: collectBrowser,
  http: collectHttp,
  tls: collectTls,
  dns: collectDns,
};

/** Collectors needed by the given checks (`derived` implies `browser`). */
export function requiredCollectors(checks: readonly AnyCheck[]): Set<CollectorName> {
  const out = new Set<CollectorName>();
  for (const c of checks) {
    for (const key of c.requires as SnapshotSectionKey[]) {
      const producer = SECTION_PRODUCER[key];
      if (producer === 'derive') out.add('browser');
      else if (producer !== 'core') out.add(producer);
    }
  }
  return out;
}

async function preflight(target: TargetInfo, network: NetworkConfig): Promise<void> {
  // IPv6 literals keep their brackets in URL form; DNS and the address check need the bare address.
  const host = bareHost(target.host);
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await network.lookup(host);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'ERROR';
      throw new ScanFatalError(
        'unreachable',
        code === 'ENOTFOUND' ? 'target-nxdomain' : 'target-dns-error',
        `Zielhost ${host} konnte nicht aufgelöst werden (${code}).`,
        { cause: err },
      );
    }
  }
  if (addresses.length === 0) {
    throw new ScanFatalError('unreachable', 'target-nxdomain', `Zielhost ${host} hat keine Adressen.`);
  }
  if (!network.allowPrivateAddresses) {
    const blocked = addresses.filter((a) => classifyAddress(a.address) !== 'public');
    if (blocked.length === addresses.length) {
      throw new InvalidInputError(
        'target-not-public',
        `Zielhost ${host} löst nur auf nicht-öffentliche Adressen auf; der Scan ist nur für öffentliche Websites vorgesehen.`,
      );
    }
    // One policy for all collectors: the browser cannot pin a checked address, so its guard refuses a host with
    // any non-public address. Refuse it here, before any collector runs, with a precise message.
    if (blocked.length > 0) {
      const list = blocked
        .slice(0, 3)
        .map((a) => a.address)
        .join(', ');
      throw new InvalidInputError(
        'target-mixed-addresses',
        `Zielhost ${host} löst neben öffentlichen auch auf nicht-öffentliche Adressen auf (${list}); der Scan ist nur für öffentliche Websites vorgesehen.`,
      );
    }
  }
}

function initialSnapshot(target: TargetInfo, o: ResolvedScanOptions): Snapshot {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    createdAt: o.now().toISOString(),
    target,
    options: {
      maxPages: o.maxPages,
      screenshots: o.screenshots,
      assumeRegion: o.assumeRegion,
      proxy: o.proxy !== null,
    },
    environment: {
      egress: {
        mode: o.proxy ? 'proxy' : 'direct',
        region: o.assumeRegion ? 'asserted' : 'unknown',
        ...(o.assumeRegion ? { assertedRegion: o.assumeRegion } : {}),
        source: o.assumeRegion ? 'laut Nutzerangabe (--assume-region)' : 'nicht festgestellt',
      },
      sandbox: { mode: o.sandbox, active: null },
      userAgent: { http: httpUserAgent(), browser: null },
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      trustStore: detectTrustStore(),
    },
    plan: { browser: null, probes: [] },
    collection: {},
    diagnostics: [],
  };
}

async function loadSnapshot(file: string): Promise<Snapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new InvalidInputError(
      'snapshot-unreadable',
      `Snapshot ${file} ist nicht lesbar: ${errorMessage(err)}`,
    );
  }
  const s = parsed as Partial<Snapshot>;
  if (s?.snapshotVersion !== SNAPSHOT_VERSION || !s.target || !s.environment || !s.plan || !s.collection) {
    throw new InvalidInputError('snapshot-invalid', `Snapshot ${file} hat kein unterstütztes Format.`);
  }
  const snapshot = s as Snapshot;
  delete snapshot.derived;
  snapshot.diagnostics ??= [];
  // Older snapshots may hold the target unredacted (D20).
  snapshot.target = redactTargetInfo(snapshot.target);
  if (snapshot.target.finalUrl) snapshot.target.finalUrl = sanitizeUrl(snapshot.target.finalUrl);
  return snapshot;
}

type TimedResult<T> = { timedOut: true } | { timedOut: false; value: T };

function untilDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<TimedResult<T>> {
  if (signal.aborted) return Promise.resolve({ timedOut: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ timedOut: true });
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ timedOut: false, value });
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** The value of `p` if it settles successfully within `ms`, else null (a late rejection counts as no result). */
function withinGrace<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

interface CollectState {
  timedOut: boolean;
  fatal: { reason: FatalReason; code: string; message: string } | null;
  /** Collectors that handed over nothing after the global timeout, not even within the grace period. */
  noHandover: Set<CollectorName>;
}

async function runCollector<S extends object>(
  name: CollectorName,
  fn: (ctx: CollectorContext) => Promise<CollectorResult<S>>,
  ctx: CollectorContext,
  snapshot: Snapshot,
  state: CollectState,
  log: Logger,
  graceMs: number,
): Promise<CollectorResult<S> | null> {
  const t0 = performance.now();
  if (ctx.signal.aborted) {
    // The deadline passed before this collector could start.
    state.timedOut = true;
    snapshot.collection[name] = { status: 'error', reason: 'timeout', durationMs: 0 };
    return null;
  }
  try {
    const pending = fn(ctx);
    const res = await untilDeadline(pending, ctx.signal);
    if (res.timedOut) {
      state.timedOut = true;
      // 5.2: findings collected before the timeout are kept — give the collector a bounded chance to stop and
      // return what it has (e.g. the browser with phase A done and phase B cut).
      const late = await withinGrace(pending, graceMs);
      const durationMs = Math.round(performance.now() - t0);
      if (!late) {
        log.warn(
          `collector ${name} handed over no result within ${graceMs} ms after the global timeout; its facts are lost`,
        );
        state.noHandover.add(name);
        snapshot.collection[name] = { status: 'error', reason: 'timeout', durationMs };
        return null;
      }
      // Failures after the abort are caused by it: the timeout is the reason, a late `fatal` is ignored.
      snapshot.collection[name] = {
        status: late.status === 'ok' ? 'partial' : late.status,
        reason: late.status === 'skipped' ? (late.reason ?? 'skipped') : 'timeout',
        durationMs,
        ...(late.error ? { error: late.error } : {}),
      };
      if (late.diagnostics) snapshot.diagnostics.push(...late.diagnostics);
      if (late.probes) snapshot.plan.probes.push(...late.probes);
      return { ...late, fatal: undefined };
    }
    const durationMs = Math.round(performance.now() - t0);
    const r = res.value;
    snapshot.collection[name] = {
      status: r.status,
      durationMs,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
    if (r.diagnostics) snapshot.diagnostics.push(...r.diagnostics);
    if (r.probes) snapshot.plan.probes.push(...r.probes);
    if (r.fatal && !state.fatal) state.fatal = r.fatal;
    return r;
  } catch (err) {
    if (err instanceof ScanFatalError && !state.fatal && !ctx.signal.aborted) {
      state.fatal = { reason: err.reason, code: err.code, message: err.message };
    }
    log.error(`collector ${name} failed: ${errorMessage(err)}`);
    snapshot.collection[name] = {
      status: 'error',
      reason: ctx.signal.aborted ? 'timeout' : 'exception',
      error: { code: 'collector-exception', message: errorMessage(err) },
      durationMs: Math.round(performance.now() - t0),
    };
    return null;
  }
}

/** The browser visited the start page in phase A (5.2: a timeout before that is fatal). */
function startPageDone(snapshot: Snapshot): boolean {
  return (snapshot.browser?.phases ?? []).some(
    (p) => p.phase === 'A' && p.pages.some((v) => v.role === 'start'),
  );
}

/** Node verdicts of a chain the server sent incompletely; Chrome completes such chains via AIA. */
const INCOMPLETE_CHAIN_ERRORS: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** True when the TLS collector saw an invalid certificate on the target host (browser checks → `tls-blocked`). */
function tlsBlocked(snapshot: Snapshot): boolean {
  if (snapshot.target.scheme !== 'https') return false;
  // The target's own endpoint at whatever port it was probed (an explicit target port, S-20), not a final-host one.
  const ep = snapshot.tls?.endpoints.find((e) => e.hostVariant === 'target' && !e.role);
  if (ep?.outcome !== 'handshake' || ep.authorized) return false;
  const incompleteChainOnly =
    ep.chainComplete === false &&
    ep.hostnameMatches !== false &&
    INCOMPLETE_CHAIN_ERRORS.has(ep.authorizationError ?? '');
  return !incompleteChainOnly;
}

async function collect(
  snapshot: Snapshot,
  rawTarget: TargetInfo,
  needed: Set<CollectorName>,
  collectors: Collectors,
  o: ResolvedScanOptions,
  signal: AbortSignal,
  deadline: number,
  log: Logger,
  clock: () => number,
  texts: Texts,
): Promise<CollectState> {
  const state: CollectState = { timedOut: false, fatal: null, noHandover: new Set() };
  const artifactsRelDir = 'artifacts';
  const ctx = (): CollectorContext => ({
    // Collectors navigate to the URL as given; everything stored uses the redacted `snapshot.target` (D20).
    target: { ...snapshot.target, input: rawTarget.input, url: rawTarget.url },
    options: {
      maxPages: o.maxPages,
      screenshots: o.screenshots,
      sandbox: o.sandbox,
      lang: o.lang,
      assumeRegion: o.assumeRegion,
    },
    network: o.network,
    userAgent: { http: httpUserAgent(), token: uaToken() },
    signal,
    deadline,
    artifactsDir: path.join(o.outDir, artifactsRelDir),
    artifactsRelDir,
    now: o.now,
    clock,
    log,
    snapshot,
  });
  for (const name of ['browser', 'http', 'tls', 'dns'] as const) {
    if (!needed.has(name))
      snapshot.collection[name] = { status: 'not-run', reason: 'not-required', durationMs: 0 };
  }

  const grace = o.abortGraceMs;
  const [http, tls, dns] = await Promise.all([
    needed.has('http') ? runCollector('http', collectors.http, ctx(), snapshot, state, log, grace) : null,
    needed.has('tls') ? runCollector('tls', collectors.tls, ctx(), snapshot, state, log, grace) : null,
    needed.has('dns') ? runCollector('dns', collectors.dns, ctx(), snapshot, state, log, grace) : null,
  ]);
  if (http?.sections.http) snapshot.http = http.sections.http;
  if (tls?.sections.tls) snapshot.tls = tls.sections.tls;
  if (dns?.sections.dns) snapshot.dns = dns.sections.dns;

  if (needed.has('browser') && !state.fatal) {
    if (tlsBlocked(snapshot)) {
      snapshot.collection.browser = { status: 'skipped', reason: 'tls-blocked', durationMs: 0 };
    } else {
      const b = await runCollector('browser', collectors.browser, ctx(), snapshot, state, log, grace);
      if (b) {
        const s = b.sections;
        if (s.browser) {
          snapshot.browser = s.browser;
          snapshot.environment.userAgent.browser = s.browser.engine.userAgent;
          snapshot.environment.sandbox.active = s.browser.engine.sandbox;
        }
        if (s.documents) snapshot.documents = s.documents;
        if (s.cmp) snapshot.cmp = s.cmp;
        if (s.plan) snapshot.plan.browser = s.plan;
        if (s.finalUrl) setFinalUrl(snapshot, s.finalUrl);
      }
    }
  }
  // CONTRACTS §3: the browser fills the final URL, else the HTTP start document does.
  if (!snapshot.target.finalUrl) {
    const start = snapshot.http?.documents.find((d) => d.role === 'start' && d.status !== null);
    if (start?.finalUrl) setFinalUrl(snapshot, start.finalUrl);
  }
  // 5.2: the global timeout before phase A finished on the start page is fatal (`timeout`). Without a planned
  // browser run (not needed, or skipped as tls-blocked) a timeout only leaves the unfinished checks in error.
  const browserPlanned = needed.has('browser') && snapshot.collection.browser?.status !== 'skipped';
  if (state.timedOut && !state.fatal && browserPlanned && !startPageDone(snapshot)) {
    const seconds = Math.round(o.timeoutMs / 1000);
    // A browser collector that handed over nothing may have captured the start page: do not claim it had not (G51).
    // The texts are data (`failure.<code>` in data/texts), in the language of the scan (AGENTS rule 3).
    const code = state.noHandover.has('browser') ? 'browser-no-handover' : 'scan-timeout';
    state.fatal = { reason: 'timeout', code, message: uiText(texts, `failure.${code}`, { seconds }) };
  }
  return state;
}

function setFinalUrl(snapshot: Snapshot, raw: string): void {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return;
  }
  snapshot.target.finalUrl = sanitizeUrl(raw);
  snapshot.target.finalHost = host;
}

function selectChecks(
  registry: CheckRegistry,
  ids: string[] | null,
): { enabled: AnyCheck[]; disabled: AnyCheck[] } {
  const all = registry.all();
  if (!ids) return { enabled: all, disabled: [] };
  const unknown = ids.filter((id) => !registry.has(id));
  if (unknown.length > 0) {
    throw new InvalidInputError('unknown-check', `Unbekannte Prüfung(en) in --checks: ${unknown.join(', ')}`);
  }
  return { enabled: all.filter((c) => ids.includes(c.id)), disabled: all.filter((c) => !ids.includes(c.id)) };
}

function runChecks(
  checks: readonly AnyCheck[],
  snapshot: Snapshot,
  o: ResolvedScanOptions,
  core: CoreData,
  timedOut: boolean,
  log: Logger,
): Map<string, ExecutedCheck> {
  const executed = new Map<string, ExecutedCheck>();
  const dataCache = new Map<string, Record<string, unknown>>();
  for (const check of checks) {
    const data: Record<string, unknown> = {};
    for (const name of check.data ?? []) {
      if (!dataCache.has(name)) dataCache.set(name, loadDataDir(name, o.dataDir));
      data[name] = dataCache.get(name);
    }
    const ctx: CheckContext = {
      now: o.now(),
      lang: o.lang,
      routing: core.routing,
      data,
      options: { strict: o.strict, assumeRegion: o.assumeRegion, fromSnapshot: o.fromSnapshot !== null },
    };
    const result = executeCheck(check, snapshot, ctx, { timedOut });
    if (result.error) log.error(`check ${check.id}: ${result.error.message}`);
    executed.set(check.id, result);
  }
  return executed;
}

/**
 * Run one scan. Never throws for scan problems: fatal conditions produce a `failed` report with exit code 2.
 * Report files are NOT written here (see `writeReports`), except `--save-snapshot`.
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const startedAtDate = options.now?.() ?? new Date();
  const startedAt = startedAtDate.toISOString();
  const t0 = performance.now();
  const log = options.log ?? createLogger('warn');
  // D20: the target in any report (also the minimal failed one) is redacted.
  const targetForReport = options.url ? redactTarget(options.url) : (options.fromSnapshot ?? '');
  let o: ResolvedScanOptions | null = null;
  let core: CoreData | null = null;
  let snapshot: Snapshot | null = null;

  const fail = (
    reason: FatalReason,
    code: string,
    message: string,
    extra: Partial<FailedReportExtras> = {},
  ) => {
    const exitReasons = gate({
      failOn: o?.failOn ?? 'critical',
      strict: o?.strict ?? false,
      fatal: [reason],
      findings: extra.gateFindings ?? [],
      checks: extra.gateChecks ?? [],
      sandboxOff: o?.sandbox === 'off',
      egressRegion: o?.assumeRegion ? 'asserted' : 'unknown',
      timedOut: false,
    }).exitReasons;
    const report = buildFailedReport({
      target: snapshot?.target.url ?? targetForReport,
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      failure: { code, message },
      exitReasons,
      texts: core?.texts ?? null,
      ruleset: core?.ruleset ?? null,
      snapshot,
      ...(o ? { options: reportOptions(o) } : {}),
      ...(extra.checks ? { checks: extra.checks, findings: extra.findings, evidence: extra.evidence } : {}),
      ...(extra.diagnostics ? { diagnostics: extra.diagnostics } : {}),
    });
    return { report, snapshot, exitCode: 2 as const };
  };

  try {
    o = resolveOptions(options);
    core = loadCoreData(o.lang, o.dataDir);
    const locked = lockedOverrides(core.ruleset, o.overrides);
    if (locked.length > 0) {
      throw new InvalidInputError(
        'locked-override',
        `Diese Varianten sind nicht überschreibbar: ${locked.join(', ')}`,
      );
    }
    const registry = options.registry ?? new CheckRegistry(allChecks);
    const { enabled, disabled } = selectChecks(registry, o.checks);
    const collectors: Collectors = { ...DEFAULT_COLLECTORS, ...options.collectors };

    const controller = new AbortController();
    const deadline = Date.now() + o.timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error('scan timeout')), o.timeoutMs);
    let state: CollectState = { timedOut: false, fatal: null, noHandover: new Set() };
    try {
      if (o.fromSnapshot) {
        snapshot = await loadSnapshot(o.fromSnapshot);
      } else {
        const target = parseTarget(o.url as string);
        snapshot = initialSnapshot(redactTargetInfo(target), o);
        await preflight(target, o.network);
        state = await collect(
          snapshot,
          target,
          requiredCollectors(enabled),
          collectors,
          o,
          controller.signal,
          deadline,
          log,
          () => performance.now() - t0,
          core.texts,
        );
      }
    } finally {
      clearTimeout(timer);
    }

    // A requested file that cannot be written → exit 2 (report-write-failed), the scan result is kept.
    let snapshotWriteFailed = false;
    if (o.saveSnapshot && !o.fromSnapshot) {
      try {
        await mkdir(path.dirname(path.resolve(o.saveSnapshot)), { recursive: true });
        await writeFile(o.saveSnapshot, `${JSON.stringify(toSavedSnapshot(snapshot), null, 2)}\n`);
      } catch (err) {
        snapshotWriteFailed = true;
        log.error(`snapshot not written: ${errorMessage(err)}`);
      }
    }

    if (snapshot.browser) snapshot.derived = derive(snapshot, { dataDir: o.dataDir });
    const executed = runChecks(enabled, snapshot, o, core, state.timedOut, log);
    for (const c of disabled)
      executed.set(c.id, { status: 'skipped', reason: 'not-selected', outcome: null, durationMs: 0 });
    const assessed = assess({
      checks: [...enabled, ...disabled].sort((a, b) => a.id.localeCompare(b.id)),
      executed,
      ruleset: core.ruleset,
      crm: core.crm,
      routing: core.routing,
      overrides: o.overrides,
      texts: core.texts,
    });

    const diagnosticInputs: DiagnosticInput[] = [...snapshot.diagnostics];
    for (const e of executed.values()) diagnosticInputs.push(...(e.outcome?.diagnostics ?? []));
    if (state.timedOut) {
      const affected = [...executed.entries()].filter(([, e]) => e.reason === 'timeout').map(([id]) => id);
      diagnosticInputs.push({ code: 'SCAN-TIMEOUT', affects: affected, params: { count: affected.length } });
    }
    if (o.sandbox === 'off') diagnosticInputs.push({ code: 'SCAN-SANDBOX-OFF', affects: [] });
    if (state.fatal?.reason === 'unreachable')
      diagnosticInputs.push({ code: 'SCAN-UNREACHABLE', affects: [] });
    if (state.fatal?.reason === 'blocked') {
      const challenge = snapshot.browser?.phases.find((p) => p.phase === 'A')?.pages[0]?.challenge;
      diagnosticInputs.push({
        code: 'SCAN-BLOCKED',
        affects: [],
        params: {
          scope: 'start',
          count: 1,
          page: snapshot.target.url,
          pages: snapshot.target.url,
          ...(challenge?.signals.length ? { signals: challenge.signals.slice(0, 10).join(', ') } : {}),
        },
      });
    }
    const diagnostics = mergeDiagnostics(diagnosticInputs);

    const disabledIds = new Set(disabled.map((c) => c.id));
    const gateChecks = assessed.checks.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      gating: c.gating ?? false,
      maxSeverity: c.maxSeverity ?? null,
      enabled: !disabledIds.has(c.id),
    }));
    const gateFindings = assessed.findings.map((f) => ({
      checkId: f.checkId,
      severity: f.severity,
      suppressed: Boolean(f.suppression && !f.suppression.expired),
      gating: isGating(core!.ruleset, f.checkId, f.variant),
      ...(f.baselineStatus ? { baselineStatus: f.baselineStatus } : {}),
    }));

    if (state.fatal) {
      return fail(state.fatal.reason, state.fatal.code, state.fatal.message, {
        checks: assessed.checks,
        findings: assessed.findings,
        evidence: assessed.evidence,
        diagnostics,
        gateChecks,
        gateFindings,
      });
    }

    const result = gate({
      failOn: o.failOn,
      strict: o.strict,
      fatal: snapshotWriteFailed ? ['report-write-failed'] : [],
      findings: gateFindings,
      checks: gateChecks,
      sandboxOff: o.sandbox === 'off',
      egressRegion: snapshot.environment.egress.region,
      timedOut: state.timedOut,
    });
    const partial =
      state.timedOut ||
      assessed.checks.some((c) => c.status === 'error') ||
      Object.values(snapshot.collection).some((c) => c?.status === 'error' || c?.status === 'partial');
    const report = buildFullReport({
      snapshot,
      status: partial ? 'partial' : 'complete',
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      options: reportOptions(o),
      ruleset: core.ruleset,
      texts: core.texts,
      checks: assessed.checks,
      findings: assessed.findings,
      diagnostics,
      evidence: assessed.evidence,
      exitCode: result.exitCode,
      exitReasons: result.exitReasons,
    });
    return { report, snapshot, exitCode: result.exitCode };
  } catch (err) {
    if (err instanceof ScanFatalError) return fail(err.reason, err.code, err.message);
    log.error(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return fail('internal-error', 'internal-error', errorMessage(err));
  }
}

interface FailedReportExtras {
  checks: CheckResult[];
  findings: Finding[];
  evidence: Evidence[];
  diagnostics: Diagnostic[];
  gateChecks: Parameters<typeof gate>[0]['checks'];
  gateFindings: Parameters<typeof gate>[0]['findings'];
}

// ---------------------------------------------------------------- writing reports

export interface WriteResult {
  exitCode: ExitCode;
  written: string[];
  errors: Array<{ path: string; message: string }>;
  /** Console report text (when `console` is among the formats). */
  console: string | null;
}

const RENDERERS = { json: renderJson, html: renderHtml, summary: renderSummary } as const;

/**
 * Write requested report files to `outDir` (json first). A failed write turns the exit code into 2
 * (`report-write-failed`, 5.2) and the JSON is rewritten with the updated summary when possible.
 */
export async function writeReports(
  result: ScanResult,
  opts: { outDir: string; formats: ReportFormat[]; lang: 'de' | 'en'; color?: boolean; dataDir?: string },
): Promise<WriteResult> {
  const outDir = path.resolve(opts.outDir);
  const texts = loadCoreData(opts.lang, opts.dataDir ?? DEFAULT_DATA_DIR).texts;
  const ctx: ReporterContext = { texts, lang: opts.lang, outDir, color: opts.color ?? false };
  const written: string[] = [];
  const errors: WriteResult['errors'] = [];
  const fileFormats = (['json', 'html', 'summary'] as const).filter((f) => opts.formats.includes(f));

  const writeOne = async (format: (typeof fileFormats)[number]) => {
    const file = path.join(outDir, REPORT_FILES[format]);
    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(file, RENDERERS[format](result.report, ctx));
      if (!written.includes(file)) written.push(file);
    } catch (err) {
      errors.push({ path: file, message: errorMessage(err) });
    }
  };
  for (const f of fileFormats) await writeOne(f);

  let exitCode = result.exitCode;
  if (errors.length > 0) {
    exitCode = 2;
    const s = result.report.summary;
    if (!s.exitReasons.includes('report-write-failed')) s.exitReasons.push('report-write-failed');
    s.exitCode = 2;
    if (fileFormats.includes('json') && !errors.some((e) => e.path.endsWith(REPORT_FILES.json))) {
      await writeOne('json');
    }
  }

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      await appendFile(stepSummary, renderSummary(result.report, ctx));
    } catch {
      // Job Summary is best effort; not a requested report file.
    }
  }

  const consoleText = opts.formats.includes('console') ? renderConsole(result.report, ctx) : null;
  return { exitCode, written, errors, console: consoleText };
}

/** Human line for a written file (used by the CLI). */
export function reportWrittenLine(texts: Texts, file: string): string {
  return uiText(texts, 'console.reportWritten', { path: file });
}
