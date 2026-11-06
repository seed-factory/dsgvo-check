/** Orchestrator: validate → preflight → collectors → snapshot → derive → checks → assess → gate → report; fatal conditions yield a minimal `failed` report (exit 2). */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { allChecks } from './checks/index.ts';
import { collectBrowser } from './collectors/browser/index.ts';
import { collectDns } from './collectors/dns/index.ts';
import { collectHttp } from './collectors/http/index.ts';
import { collectTls } from './collectors/tls/index.ts';
import { checkThresholds } from './core/config/thresholds.ts';
import { disclaimerText } from './core/data/disclaimer.ts';
import {
  type CoreData,
  DEFAULT_DATA_DIR,
  loadCoreData,
  loadDataDir,
  loadTexts,
  type Texts,
} from './core/data/load.ts';
import { uiText } from './core/data/messages.ts';
import {
  type AssessOutput,
  assess,
  EvidenceStore,
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
  ConsentAction,
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
  type BrowserEntry,
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
import { type CollectState, collect, requiredCollectors, TLS_FALLBACK_FAILED } from './scan-collect.ts';
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

/** Refuses a target that does not resolve or that points into non-public address space, before any collector runs. */
async function preflight(target: TargetInfo, network: NetworkConfig): Promise<void> {
  // IPv6 literals keep their brackets in URL form; DNS and the address check need the bare address.
  const host = bareHost(target.host);
  const addresses = isIP(host) ? [{ address: host }] : await resolveHost(host, network);
  if (addresses.length === 0) {
    throw new ScanFatalError('unreachable', 'target-nxdomain', { host, code: 'no addresses' });
  }
  if (!network.allowPrivateAddresses) assertPublicAddresses(host, addresses);
}

async function resolveHost(host: string, network: NetworkConfig): Promise<{ address: string }[]> {
  try {
    return await network.lookup(host);
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

function assertPublicAddresses(host: string, addresses: readonly { address: string }[]): void {
  const blocked = addresses.filter((a) => classifyAddress(a.address) !== 'public');
  if (blocked.length === addresses.length) {
    throw new InvalidInputError('target-not-public', { host });
  }

  // The browser cannot pin a checked address and its guard refuses a host with any non-public address: refuse it
  // here, before any collector runs, with a precise message.
  if (blocked.length > 0) {
    const list = blocked
      .slice(0, 3)
      .map((a) => a.address)
      .join(', ');
    throw new InvalidInputError('target-mixed-addresses', { host, addresses: list });
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
        // A code: reporters word it in the language of the report.
        source: o.assumeRegion ? 'assume-region' : 'not-determined',
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
  // `derived` is recomputed on every run, never trusted from the file.
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
  const thresholds = checkThresholds(o.config);

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
      thresholds,
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
  enabled: readonly AnyCheck[],
): Diagnostic[] {
  const inputs: DiagnosticInput[] = [...snapshot.diagnostics];
  for (const e of executed.values()) inputs.push(...(e.outcome?.diagnostics ?? []));

  if (state.timedOut) {
    const affected = [...executed.entries()].filter(([, e]) => e.reason === 'timeout').map(([id]) => id);
    inputs.push({ code: 'SCAN-TIMEOUT', affects: affected, params: { count: affected.length } });
  }
  if (o.sandbox === 'off') inputs.push({ code: 'SCAN-SANDBOX-OFF', affects: [] });
  const browserReason = snapshot.collection.browser?.reason;
  const entry = snapshot.plan.browserEntry;
  if (browserReason === 'tls-blocked' || browserReason === TLS_FALLBACK_FAILED)
    inputs.push(tlsBlockedDiagnostic(snapshot, executed, browserReason));
  else if (entry) inputs.push(tlsFallbackDiagnostic(snapshot, entry, executed, enabled));
  if (state.fatal?.reason === 'unreachable') inputs.push({ code: 'SCAN-UNREACHABLE', affects: [] });
  if (state.fatal?.reason === 'blocked') inputs.push(blockedStartPageDiagnostic(snapshot));

  return mergeDiagnostics(inputs);
}

/**
 * The browser checks did not run because the target's certificate was refused: say so instead of leaving only
 * `skipped`, with why the browser did not continue on the redirect target of the plain-http address (`fallback`).
 */
function tlsBlockedDiagnostic(
  snapshot: Snapshot,
  executed: ReadonlyMap<string, ExecutedCheck>,
  reason: string,
): DiagnosticInput {
  const affected = [...executed.entries()]
    .filter(([, e]) => e.status === 'skipped' && e.reason === reason)
    .map(([id]) => id);
  const entry = snapshot.plan.browserEntry;
  const fallback = reason === TLS_FALLBACK_FAILED ? 'blocked' : snapshot.plan.tlsFallback;
  return {
    code: 'SCAN-TLS-BLOCKED',
    affects: affected,
    params: {
      host: snapshot.target.host,
      ...(fallback ? { fallback } : {}),
      ...(reason === TLS_FALLBACK_FAILED && entry ? { via: entry.via, url: entry.url } : {}),
    },
  };
}

/** The browser checks ran on the redirect target of a refused certificate, not on the target: the report says where. */
function tlsFallbackDiagnostic(
  snapshot: Snapshot,
  entry: BrowserEntry,
  executed: ReadonlyMap<string, ExecutedCheck>,
  enabled: readonly AnyCheck[],
): DiagnosticInput {
  const affected = enabled
    .filter((c) => requiredCollectors([c]).has('browser') && executed.get(c.id)?.status !== 'skipped')
    .map((c) => c.id);
  return {
    code: 'SCAN-TLS-FALLBACK',
    affects: affected,
    params: { host: snapshot.target.host, via: entry.via, url: entry.url },
  };
}

/** Bot-protection signals are listed up to a cap so that the diagnostic stays short. */
const MAX_BLOCK_SIGNALS = 10;

function blockedStartPageDiagnostic(snapshot: Snapshot): DiagnosticInput {
  const challenge = snapshot.browser?.phases.find((p) => p.phase === 'A')?.pages[0]?.challenge;
  return {
    code: 'SCAN-BLOCKED',
    affects: [],
    params: {
      scope: 'start',
      count: 1,
      page: snapshot.target.url,
      pages: snapshot.target.url,
      ...(challenge?.signals.length
        ? { signals: challenge.signals.slice(0, MAX_BLOCK_SIGNALS).join(', ') }
        : {}),
    },
  };
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

/** `failure.<code>` in test/data/texts, in the language of the scan; the code alone when no texts can be loaded. */
function failureMessage(
  code: string,
  params: MessageParams,
  core: CoreData | null,
  options: ScanOptions,
): string {
  let texts = core?.texts;
  try {
    texts ??= loadTexts(options.lang === 'en' ? 'en' : 'de', options.dataDir ?? DEFAULT_DATA_DIR);
  } catch {
    return code;
  }
  return uiText(texts, `failure.${code}`, params);
}

/** Everything that follows the collection: derive, run and assess the checks, and the facts the gate needs. */
interface Evaluation {
  assessed: AssessOutput;
  diagnostics: Diagnostic[];
  gateChecks: GateCheck[];
  gateFindings: GateFinding[];
}

function evaluateSnapshot(
  snapshot: Snapshot,
  state: CollectState,
  selection: { enabled: AnyCheck[]; disabled: AnyCheck[] },
  o: ResolvedScanOptions,
  core: CoreData,
  log: Logger,
): Evaluation {
  const { enabled, disabled } = selection;
  if (snapshot.browser) {
    snapshot.derived = derive(snapshot, {
      dataDir: o.dataDir,
      persistentCookieMinDays: o.config.browser.persistentCookieMinDays,
    });
  }

  const executed = runChecks(enabled, snapshot, o, core, state.timedOut, log);
  for (const c of disabled) {
    executed.set(c.id, { status: 'skipped', reason: 'not-selected', outcome: null, durationMs: 0 });
  }
  const assessed = assess({
    checks: [...enabled, ...disabled].sort((a, b) => a.id.localeCompare(b.id)),
    executed,
    ruleset: core.ruleset,
    routing: core.routing,
    overrides: o.overrides,
    texts: core.texts,
    maxEvidencePerFinding: o.config.report.maxEvidencePerFinding,
  });

  return {
    assessed,
    diagnostics: scanDiagnostics(snapshot, executed, state, o, enabled),
    gateChecks: toGateChecks(assessed.checks, new Set(disabled.map((c) => c.id))),
    gateFindings: toGateFindings(assessed.findings, core.ruleset),
  };
}

interface CompletedRun {
  snapshot: Snapshot;
  state: CollectState;
  o: ResolvedScanOptions;
  core: CoreData;
  evaluation: Evaluation;
  snapshotWriteFailed: boolean;
  timing: { startedAt: string; durationMs: number; evaluatedAt?: string };
}

/** The gate decides the exit code, then the full report is built; `partial` marks a result with gaps. */
function completeResult(run: CompletedRun): ScanResult {
  const { snapshot, state, o, core, evaluation } = run;
  const { assessed, diagnostics, gateChecks, gateFindings } = evaluation;

  const result = gate({
    failOn: o.failOn,
    strict: o.strict,
    fatal: run.snapshotWriteFailed ? ['report-write-failed'] : [],
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
    ...run.timing,
    options: reportOptions(o),
    ruleset: core.ruleset,
    texts: core.texts,
    checks: assessed.checks,
    findings: assessed.findings,
    diagnostics,
    evidence: withScreenshots(assessed.evidence, snapshot),
    exitCode: result.exitCode,
    exitReasons: result.exitReasons,
  });
  addConsentActions(report, snapshot, core.texts);
  return { report, snapshot, exitCode: result.exitCode };
}

/**
 * Banner screenshots stay in the report even when no finding cites them (a recognised banner without a finding), so
 * the full report can show them; an id is the one a citing check would get for the same image.
 */
function withScreenshots(evidence: readonly Evidence[], snapshot: Snapshot): Evidence[] {
  type Shot = Extract<Evidence, { type: 'screenshot' }>;
  const cited = new Set(
    evidence.flatMap((e) => {
      if (e.type !== 'screenshot') return [];
      const shot = e as Shot;
      return [JSON.stringify([shot.path, shot.sha256])];
    }),
  );
  const store = new EvidenceStore();
  for (const shot of snapshot.browser?.screenshots ?? []) {
    if (cited.has(JSON.stringify([shot.path, shot.sha256]))) continue;
    store.add({
      type: 'screenshot',
      path: shot.path,
      sha256: shot.sha256,
      kind: shot.kind,
      phase: shot.phase,
    });
  }
  const added = store.all();
  return added.length ? [...evidence, ...added].sort((a, b) => a.id.localeCompare(b.id)) : [...evidence];
}

/** Outcome of the reject (phase B) and accept (phase C) click on the start page; phases that did not run are left out. */
function consentActions(snapshot: Snapshot): ConsentAction[] {
  const out: ConsentAction[] = [];
  for (const [action, phase] of [
    ['reject', 'B'],
    ['accept', 'C'],
  ] as const) {
    const record = snapshot.browser?.phases.find((p) => p.phase === phase);
    if (!record || record.status === 'skipped') continue;
    const clicked = record.click?.action === action && record.click.success === true;
    const verify = snapshot.cmp?.phases.find((p) => p.phase === phase)?.verify;
    out.push({ action, clicked, verified: clicked && verify?.action === action ? verify.verified : null });
  }
  return out;
}

/**
 * The disclaimer and the first page depend on whether the accept click succeeded, not only on a visit in phase C:
 * the click outcome joins the coverage and the disclaimer text is composed again.
 */
function addConsentActions(report: Report, snapshot: Snapshot, texts: Texts | null): void {
  const coverage = report.scan.coverage;
  if (!coverage || !snapshot.browser) return;
  const actions = consentActions(snapshot);
  if (actions.length === 0) return;
  coverage.consentActions = actions;
  if (texts) report.disclaimer.text = disclaimerText(report, texts);
}

/**
 * When and how long the site was observed, for a saved snapshot: its capture time, and the run time of its collectors
 * (http, tls and dns run side by side, the browser after them). The clock of the re-evaluation would date the report
 * to a moment the site was not visited.
 */
export function captureTiming(snapshot: Snapshot): { startedAt: string; durationMs: number } {
  const c = snapshot.collection;
  const sideBySide = Math.max(0, ...(['http', 'tls', 'dns'] as const).map((n) => c[n]?.durationMs ?? 0));
  return { startedAt: snapshot.createdAt, durationMs: sideBySide + (c.browser?.durationMs ?? 0) };
}

/** Runs one scan; fatal conditions produce a `failed` report (exit 2) instead of throwing. Report files are written by `writeReports`. */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const startedAtDate = options.now?.() ?? new Date();
  const runStartedAt = startedAtDate.toISOString();
  const t0 = performance.now();
  // A re-evaluated snapshot is dated to its capture; the time of the evaluation is kept beside it.
  let capture: { startedAt: string; durationMs: number } | null = null;
  const timing = () =>
    capture
      ? { startedAt: capture.startedAt, durationMs: capture.durationMs, evaluatedAt: runStartedAt }
      : { startedAt: runStartedAt, durationMs: Math.round(performance.now() - t0) };
  const log = options.log ?? createLogger('warn');
  // the target in any report (also the minimal failed one) is redacted
  const targetForReport = options.url ? redactTarget(options.url) : (options.fromSnapshot ?? '');

  // Filled in as the run progresses: a failure reports whatever exists by then.
  let o: ResolvedScanOptions | null = null;
  let core: CoreData | null = null;
  let snapshot: Snapshot | null = null;

  const fail = (
    reason: FatalReason,
    code: string,
    params: MessageParams = {},
    extra: Partial<FailedReportExtras> = {},
  ) => {
    const message = failureMessage(code, params, core, options);
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
      ...timing(),
      failure: { code, message },
      exitReasons,
      texts: core?.texts ?? null,
      ruleset: core?.ruleset ?? null,
      snapshot,
      ...(o ? { options: reportOptions(o) } : {}),
      ...(extra.checks
        ? {
            checks: extra.checks,
            findings: extra.findings,
            evidence: snapshot ? withScreenshots(extra.evidence ?? [], snapshot) : extra.evidence,
          }
        : {}),
      ...(extra.diagnostics ? { diagnostics: extra.diagnostics } : {}),
    });
    if (snapshot) addConsentActions(report, snapshot, core?.texts ?? null);
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
    const selection = selectChecks(registry, o.checks);
    const collectors: Collectors = { ...DEFAULT_COLLECTORS, ...options.collectors };

    // The snapshot comes from a saved file or from the collectors, which stop at the scan deadline.
    const controller = new AbortController();
    const deadline = Date.now() + o.timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error('scan timeout')), o.timeoutMs);
    let state: CollectState = { timedOut: false, fatal: null, noHandover: new Set() };
    try {
      if (o.fromSnapshot) {
        snapshot = await loadSnapshot(o.fromSnapshot);
        capture = captureTiming(snapshot);
      } else {
        const target = parseTarget(o.url as string);
        snapshot = initialSnapshot(redactTargetInfo(target), o);
        await preflight(target, o.network);
        state = await collect(
          snapshot,
          target,
          requiredCollectors(selection.enabled),
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

    const evaluation = evaluateSnapshot(snapshot, state, selection, o, core, log);
    if (state.fatal) {
      return fail(state.fatal.reason, state.fatal.code, state.fatal.params, {
        checks: evaluation.assessed.checks,
        findings: evaluation.assessed.findings,
        evidence: evaluation.assessed.evidence,
        diagnostics: evaluation.diagnostics,
        gateChecks: evaluation.gateChecks,
        gateFindings: evaluation.gateFindings,
      });
    }

    return completeResult({ snapshot, state, o, core, evaluation, snapshotWriteFailed, timing: timing() });
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
