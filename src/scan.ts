/** Orchestrator: validate → preflight → collectors → snapshot → derive → checks → assess → gate → report; fatal conditions yield a minimal `failed` report (exit 2). */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { allChecks } from './checks/index.ts';
import { collectBrowser } from './collectors/browser/index.ts';
import { collectDns } from './collectors/dns/index.ts';
import { collectHttp } from './collectors/http/index.ts';
import { collectTls } from './collectors/tls/index.ts';
import { type CoreData, DEFAULT_DATA_DIR, loadCoreData, loadDataDir, loadTexts } from './core/data/load.ts';
import { uiText } from './core/data/messages.ts';
import {
  assess,
  type ExecutedCheck,
  isGating,
  lockedOverrides,
  mergeDiagnostics,
} from './core/evaluation/assess.ts';
import type { AnyCheck, CheckContext } from './core/evaluation/check.ts';
import { executeCheck } from './core/evaluation/execute.ts';
import { type ExitCode, type GateCheck, type GateFinding, gate } from './core/evaluation/gate.ts';
import { CheckRegistry } from './core/evaluation/registry.ts';
import { buildFailedReport, buildFullReport } from './core/report/build.ts';
import type {
  CheckResult,
  Diagnostic,
  Evidence,
  Finding,
  MessageParams,
  Report,
} from './core/report/schema.ts';
import { errorMessage, type FatalReason, InvalidInputError, ScanFatalError } from './core/runtime/errors.ts';
import { createLogger, type Logger } from './core/runtime/logger.ts';
import { uaToken } from './core/runtime/user-agent.ts';
import { TOOL_NAME, TOOL_VERSION } from './core/runtime/version.ts';
import type { Collectors } from './core/snapshot/collector.ts';
import {
  type DiagnosticInput,
  detectTrustStore,
  SNAPSHOT_VERSION,
  type Snapshot,
  type TargetInfo,
  toSavedSnapshot,
} from './core/snapshot/index.ts';
import { classifyAddress, type NetworkConfig } from './core/url/net.ts';
import { bareHost, parseTarget, redactTarget, redactTargetInfo, sanitizeUrl } from './core/url/url.ts';
import { derive } from './derive/index.ts';
import { type CollectState, collect, requiredCollectors } from './scan-collect.ts';
import { type ResolvedScanOptions, reportOptions, resolveOptions, type ScanOptions } from './scan-options.ts';

export interface ScanResult {
  report: Report;
  /** Null when the scan failed before a snapshot existed. */
  snapshot: Snapshot | null;
  exitCode: ExitCode;
}

const DEFAULT_COLLECTORS: Collectors = {
  browser: collectBrowser,
  http: collectHttp,
  tls: collectTls,
  dns: collectDns,
};

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
        { host, code },
        { cause: err },
      );
    }
  }
  if (addresses.length === 0) {
    throw new ScanFatalError('unreachable', 'target-nxdomain', { host, code: 'no addresses' });
  }
  if (!network.allowPrivateAddresses) {
    const blocked = addresses.filter((a) => classifyAddress(a.address) !== 'public');
    if (blocked.length === addresses.length) {
      throw new InvalidInputError('target-not-public', { host });
    }
    // the browser cannot pin a checked address and its guard refuses a host with any non-public address: refuse it
    // here, before any collector runs, with a precise message
    if (blocked.length > 0) {
      const list = blocked
        .slice(0, 3)
        .map((a) => a.address)
        .join(', ');
      throw new InvalidInputError('target-mixed-addresses', { host, addresses: list });
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
      userAgent: { http: uaToken(), browser: null },
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
    throw new InvalidInputError('snapshot-unreadable', { file, message: errorMessage(err) });
  }
  const s = parsed as Partial<Snapshot>;
  if (s?.snapshotVersion !== SNAPSHOT_VERSION || !s.target || !s.environment || !s.plan || !s.collection) {
    throw new InvalidInputError('snapshot-invalid', { file });
  }
  const snapshot = s as Snapshot;
  delete snapshot.derived;
  snapshot.diagnostics ??= [];
  // Older snapshots may hold the target unredacted.
  snapshot.target = redactTargetInfo(snapshot.target);
  if (snapshot.target.finalUrl) snapshot.target.finalUrl = sanitizeUrl(snapshot.target.finalUrl);
  return snapshot;
}

function selectChecks(
  registry: CheckRegistry,
  ids: string[] | null,
): { enabled: AnyCheck[]; disabled: AnyCheck[] } {
  const all = registry.all();
  if (!ids) return { enabled: all, disabled: [] };
  const unknown = ids.filter((id) => !registry.has(id));
  if (unknown.length > 0) {
    throw new InvalidInputError('unknown-check', { checks: unknown.join(', ') });
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

/** Writes the snapshot to `file`; false (and a log line) when that fails. */
async function saveSnapshotFile(snapshot: Snapshot, file: string, log: Logger): Promise<boolean> {
  try {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, `${JSON.stringify(toSavedSnapshot(snapshot), null, 2)}\n`);
    return true;
  } catch (err) {
    log.error(`snapshot not written: ${errorMessage(err)}`);
    return false;
  }
}

/** What the collectors and checks raised, plus what follows from how the scan ended (timeout, sandbox off, fatal start page). */
function scanDiagnostics(
  snapshot: Snapshot,
  executed: ReadonlyMap<string, ExecutedCheck>,
  state: CollectState,
  o: ResolvedScanOptions,
): Diagnostic[] {
  const inputs: DiagnosticInput[] = [...snapshot.diagnostics];
  for (const e of executed.values()) inputs.push(...(e.outcome?.diagnostics ?? []));
  if (state.timedOut) {
    const affected = [...executed.entries()].filter(([, e]) => e.reason === 'timeout').map(([id]) => id);
    inputs.push({ code: 'SCAN-TIMEOUT', affects: affected, params: { count: affected.length } });
  }
  if (o.sandbox === 'off') inputs.push({ code: 'SCAN-SANDBOX-OFF', affects: [] });
  if (state.fatal?.reason === 'unreachable') inputs.push({ code: 'SCAN-UNREACHABLE', affects: [] });
  if (state.fatal?.reason === 'blocked') {
    const challenge = snapshot.browser?.phases.find((p) => p.phase === 'A')?.pages[0]?.challenge;
    inputs.push({
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
  return mergeDiagnostics(inputs);
}

function toGateChecks(checks: readonly CheckResult[], disabledIds: ReadonlySet<string>): GateCheck[] {
  return checks.map((c) => ({
    id: c.id,
    status: c.status,
    reason: c.reason,
    gating: c.gating ?? false,
    maxSeverity: c.maxSeverity ?? null,
    enabled: !disabledIds.has(c.id),
  }));
}

function toGateFindings(findings: readonly Finding[], ruleset: CoreData['ruleset']): GateFinding[] {
  return findings.map((f) => ({
    checkId: f.checkId,
    severity: f.severity,
    suppressed: Boolean(f.suppression && !f.suppression.expired),
    gating: isGating(ruleset, f.checkId, f.variant),
    ...(f.baselineStatus ? { baselineStatus: f.baselineStatus } : {}),
  }));
}

/** The result is `partial` when the deadline hit, a check failed or a collector did not finish cleanly. */
function isPartial(snapshot: Snapshot, checks: readonly CheckResult[], state: CollectState): boolean {
  return (
    state.timedOut ||
    checks.some((c) => c.status === 'error') ||
    Object.values(snapshot.collection).some((c) => c?.status === 'error' || c?.status === 'partial')
  );
}

/** Runs one scan; fatal conditions produce a `failed` report (exit 2) instead of throwing. Report files are written by `writeReports`. */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const startedAtDate = options.now?.() ?? new Date();
  const startedAt = startedAtDate.toISOString();
  const t0 = performance.now();
  const log = options.log ?? createLogger('warn');
  // the target in any report (also the minimal failed one) is redacted
  const targetForReport = options.url ? redactTarget(options.url) : (options.fromSnapshot ?? '');
  let o: ResolvedScanOptions | null = null;
  let core: CoreData | null = null;
  let snapshot: Snapshot | null = null;

  // `failure.<code>` in test/data/texts, in the language of the scan; the code alone when no texts can be loaded.
  const failureMessage = (code: string, params: MessageParams): string => {
    let texts = core?.texts;
    try {
      texts ??= loadTexts(options.lang === 'en' ? 'en' : 'de', options.dataDir ?? DEFAULT_DATA_DIR);
    } catch {
      return code;
    }
    return uiText(texts, `failure.${code}`, params);
  };
  const fail = (
    reason: FatalReason,
    code: string,
    params: MessageParams = {},
    extra: Partial<FailedReportExtras> = {},
  ) => {
    const message = failureMessage(code, params);
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
      throw new InvalidInputError('locked-override', { variants: locked.join(', ') });
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
        );
      }
    } finally {
      clearTimeout(timer);
    }

    // A requested file that cannot be written → exit 2 (report-write-failed), the scan result is kept.
    let snapshotWriteFailed = false;
    if (o.saveSnapshot && !o.fromSnapshot) {
      snapshotWriteFailed = !(await saveSnapshotFile(snapshot, o.saveSnapshot, log));
    }

    if (snapshot.browser) snapshot.derived = derive(snapshot, { dataDir: o.dataDir });
    const executed = runChecks(enabled, snapshot, o, core, state.timedOut, log);
    for (const c of disabled)
      executed.set(c.id, { status: 'skipped', reason: 'not-selected', outcome: null, durationMs: 0 });
    const assessed = assess({
      checks: [...enabled, ...disabled].sort((a, b) => a.id.localeCompare(b.id)),
      executed,
      ruleset: core.ruleset,
      routing: core.routing,
      overrides: o.overrides,
      texts: core.texts,
    });

    const diagnostics = scanDiagnostics(snapshot, executed, state, o);
    const gateChecks = toGateChecks(assessed.checks, new Set(disabled.map((c) => c.id)));
    const gateFindings = toGateFindings(assessed.findings, core.ruleset);

    if (state.fatal) {
      return fail(state.fatal.reason, state.fatal.code, state.fatal.params, {
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
    const partial = isPartial(snapshot, assessed.checks, state);
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
    if (err instanceof ScanFatalError) return fail(err.reason, err.code, err.params);
    log.error(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return fail('internal-error', 'internal-error', { message: errorMessage(err) });
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
