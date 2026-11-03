/** Collector phase of a scan: runs the collectors the checks need under the global deadline and merges their sections into the snapshot. */
import path from 'node:path';
import type { AnyCheck } from './core/evaluation/check.ts';
import { errorMessage, ScanFatalError } from './core/runtime/errors.ts';
import type { Logger } from './core/runtime/logger.ts';
import { uaToken } from './core/runtime/user-agent.ts';
import type {
  CollectorContext,
  CollectorResult,
  Collectors,
  FatalSignal,
} from './core/snapshot/collector.ts';
import {
  type CollectorName,
  SECTION_PRODUCER,
  type Snapshot,
  type SnapshotSectionKey,
  type TargetInfo,
} from './core/snapshot/index.ts';
import { sanitizeUrl } from './core/url/url.ts';
import type { ResolvedScanOptions } from './scan-options.ts';

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

export interface CollectState {
  timedOut: boolean;
  fatal: FatalSignal | null;
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
      // findings collected before the timeout are kept: give the collector a bounded chance to stop and return what it has
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
      state.fatal = { reason: err.reason, code: err.code, params: err.params };
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

/** The browser visited the start page in phase A (a timeout before that is fatal). */
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
  // Keep the target's endpoint and explicit port rather than borrowing a final-host endpoint.
  const ep = snapshot.tls?.endpoints.find((e) => e.hostVariant === 'target' && !e.role);
  if (ep?.outcome !== 'handshake' || ep.authorized) return false;
  const incompleteChainOnly =
    ep.chainComplete === false &&
    ep.hostnameMatches !== false &&
    INCOMPLETE_CHAIN_ERRORS.has(ep.authorizationError ?? '');
  return !incompleteChainOnly;
}

export async function collect(
  snapshot: Snapshot,
  rawTarget: TargetInfo,
  needed: Set<CollectorName>,
  collectors: Collectors,
  o: ResolvedScanOptions,
  signal: AbortSignal,
  deadline: number,
  log: Logger,
  clock: () => number,
): Promise<CollectState> {
  const state: CollectState = { timedOut: false, fatal: null, noHandover: new Set() };
  const artifactsRelDir = 'artifacts';
  const ctx = (): CollectorContext => ({
    // Collectors navigate to the URL as given; everything stored uses the redacted `snapshot.target`.
    target: { ...snapshot.target, input: rawTarget.input, url: rawTarget.url },
    options: {
      maxPages: o.maxPages,
      screenshots: o.screenshots,
      sandbox: o.sandbox,
      lang: o.lang,
      assumeRegion: o.assumeRegion,
    },
    network: o.network,
    userAgent: { http: uaToken(), token: uaToken() },
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
  // Prefer the browser's final URL; use the HTTP start document when the browser did not provide it.
  if (!snapshot.target.finalUrl) {
    const start = snapshot.http?.documents.find((d) => d.role === 'start' && d.status !== null);
    if (start?.finalUrl) setFinalUrl(snapshot, start.finalUrl);
  }
  // the global timeout before phase A finished on the start page is fatal (`timeout`). Without a planned
  // browser run (not needed, or skipped as tls-blocked) a timeout only leaves the unfinished checks in error.
  const browserPlanned = needed.has('browser') && snapshot.collection.browser?.status !== 'skipped';
  if (state.timedOut && !state.fatal && browserPlanned && !startPageDone(snapshot)) {
    const seconds = Math.round(o.timeoutMs / 1000);
    // A browser collector that handed over nothing may have captured the start page: do not claim it had not.
    const code = state.noHandover.has('browser') ? 'browser-no-handover' : 'scan-timeout';
    state.fatal = { reason: 'timeout', code, params: { seconds } };
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
