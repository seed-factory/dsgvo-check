/** Collector phase of a scan: runs the collectors the checks need under the global deadline and merges their sections into the snapshot. */
import { isIP } from 'node:net';
import path from 'node:path';
import { DEFAULT_TLS_PORT } from './collectors/tls/probe.ts';
import type { TlsFallbackMode } from './core/config/schema.ts';
import type { AnyCheck } from './core/evaluation/check.ts';
import { errorMessage, ScanFatalError } from './core/runtime/errors.ts';
import type { Logger } from './core/runtime/logger.ts';
import { uaToken } from './core/runtime/user-agent.ts';
import type {
  CollectorContext,
  CollectorHandover,
  CollectorResult,
  Collectors,
  EntryTarget,
  FatalSignal,
} from './core/snapshot/collector.ts';
import type { RedirectChain } from './core/snapshot/http.ts';
import {
  type BrowserEntry,
  type CollectorName,
  SECTION_PRODUCER,
  type Snapshot,
  type SnapshotSectionKey,
  type TargetInfo,
  type TlsFallbackDeclined,
} from './core/snapshot/index.ts';
import { bareHost, sanitizeUrl } from './core/url/url.ts';
import type { ResolvedScanOptions } from './scan-options.ts';

/** Collectors needed by the given checks (`derived` implies `browser`); optional sections start none. */
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
    if (res.timedOut) return await settleAfterTimeout(name, pending, snapshot, state, log, graceMs, t0);
    return recordResult(name, res.value, snapshot, state, Math.round(performance.now() - t0));
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

/** Notes the outcome of a collector that returned before the deadline. */
function recordResult<S extends object>(
  name: CollectorName,
  r: CollectorResult<S>,
  snapshot: Snapshot,
  state: CollectState,
  durationMs: number,
): CollectorResult<S> {
  snapshot.collection[name] = {
    status: r.status,
    durationMs,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
  addSideOutputs(snapshot, r);
  if (r.fatal && !state.fatal) state.fatal = r.fatal;
  return r;
}

/** After the global timeout a collector gets a short grace period to hand over what it has. */
async function settleAfterTimeout<S extends object>(
  name: CollectorName,
  pending: Promise<CollectorResult<S>>,
  snapshot: Snapshot,
  state: CollectState,
  log: Logger,
  graceMs: number,
  t0: number,
): Promise<CollectorResult<S> | null> {
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
  addSideOutputs(snapshot, late);
  return { ...late, fatal: undefined };
}

/** Diagnostics and probes of a collector go into the snapshot whatever its status. */
function addSideOutputs(snapshot: Snapshot, r: CollectorResult<object>): void {
  if (r.diagnostics) snapshot.diagnostics.push(...r.diagnostics);
  if (r.probes) snapshot.plan.probes.push(...r.probes);
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

/**
 * Where the browser may start instead of the target, or why it may not. Only the observed standard-port plain-http
 * chain of the target counts, never a redirect received over a refused https connection: the chain must end normally
 * on https of another DNS host, every https hop on the way must have been confirmed by Node (`true`, not unknown), a
 * handshake record of that host must be accepted, and the page must have answered with content or a challenge the
 * browser may pass. The raw URL comes from the HTTP collector's in-memory handover.
 */
export function tlsFallbackEntry(
  snapshot: Readonly<Snapshot>,
  handover: CollectorHandover | null | undefined,
  mode: TlsFallbackMode,
): TlsFallbackDecision {
  const declined = (why: TlsFallbackDeclined): TlsFallbackDecision => ({ entry: null, declined: why });
  if (mode === 'off') return declined('off');

  const target = snapshot.target;
  if (isIP(bareHost(target.host)) || new URL(target.url).port !== '') return declined('none');
  const chain = snapshot.http?.chains.find(
    (c) => c.hostVariant === 'target' && c.scheme === 'http' && c.port === undefined,
  );
  if (!chain) return declined('none');

  const targetHost = target.host.toLowerCase();
  const urls = chainUrls(chain);
  const end = urls.at(-1);
  if (!end || !urls.some((u) => u.protocol === 'https:')) return declined('none');
  if (end.protocol === 'https:' && end.hostname.toLowerCase() === targetHost) return declined('same-host');
  if (chain.outcome !== 'ok' || !chain.final)
    return declined(chain.outcome === 'tls-error' ? 'invalid' : 'none');

  const raw = handover?.chainUrls?.[chain.id];
  const final = raw ? parseUrl(raw.final) : null;
  if (!raw || !final || final.protocol !== 'https:') return declined('none');
  const host = final.hostname.toLowerCase();
  if (host === targetHost) return declined('same-host');
  if (isIP(bareHost(host)) || final.port !== '') return declined('none');

  const httpsHops = chain.hops.filter((h) => h.url.startsWith('https:'));
  if (httpsHops.some((h) => h.tlsAuthorized !== true) || !handshakesAccepted(snapshot, host)) {
    return declined('invalid');
  }
  if (!FALLBACK_START_STATUS(chain.final.status)) return declined('none');

  return {
    entry: { reason: 'tls-invalid', url: raw.final, via: raw.start },
    record: { reason: 'tls-invalid', url: sanitizeUrl(raw.final), via: chain.startUrl },
  };
}

export type TlsFallbackDecision =
  | { entry: EntryTarget; record: BrowserEntry }
  | { entry: null; declined: TlsFallbackDeclined };

/** Content, or a bot challenge (403, 429) that the browser may pass where the HTTP client did not. */
const FALLBACK_START_STATUS = (status: number | null): boolean =>
  status !== null && ((status >= 200 && status < 300) || status === 403 || status === 429);

/** The URLs a chain reached, and the one its last redirect pointed to when the chain broke off there, in order. */
function chainUrls(chain: RedirectChain): URL[] {
  const urls = chain.hops.map((h) => h.url);
  const last = chain.hops.at(-1);
  if (chain.outcome !== 'ok' && last?.location) urls.push(last.location);
  return urls.map(parseUrl).filter((u): u is URL => u !== null);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Every handshake record of `host` on 443, from the TLS collector or after the redirect, completed and was accepted. */
function handshakesAccepted(snapshot: Readonly<Snapshot>, host: string): boolean {
  const records = [...(snapshot.tls?.endpoints ?? []), ...(snapshot.http?.finalTls ?? [])].filter(
    (e) => e.host.toLowerCase() === host && e.port === DEFAULT_TLS_PORT,
  );
  return records.every((e) => e.outcome === 'handshake' && e.authorized);
}

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
  const ctx = (): CollectorContext => collectorContext(snapshot, rawTarget, o, signal, deadline, log, clock);
  const grace = o.abortGraceMs;

  for (const name of ['browser', 'http', 'tls', 'dns'] as const) {
    if (!needed.has(name))
      snapshot.collection[name] = { status: 'not-run', reason: 'not-required', durationMs: 0 };
  }

  // http, tls and dns are independent; the browser runs after them because it depends on the TLS verdict.
  const [http, tls, dns] = await Promise.all([
    needed.has('http') ? runCollector('http', collectors.http, ctx(), snapshot, state, log, grace) : null,
    needed.has('tls') ? runCollector('tls', collectors.tls, ctx(), snapshot, state, log, grace) : null,
    needed.has('dns') ? runCollector('dns', collectors.dns, ctx(), snapshot, state, log, grace) : null,
  ]);
  if (http?.sections.http) snapshot.http = http.sections.http;
  if (tls?.sections.tls) snapshot.tls = tls.sections.tls;
  if (dns?.sections.dns) snapshot.dns = dns.sections.dns;

  if (needed.has('browser') && !state.fatal) {
    const entry = browserEntry(snapshot, http?.handover, o.config.scan.tlsFallback, log);
    if (entry) await runBrowserCollector(snapshot, collectors.browser, entry(ctx()), state, log, grace);
    if (snapshot.plan.browserEntry) endFailedAttempt(snapshot, state);
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

  // The final host and the Impressum are known only now; also with the browser skipped (the HTTP final URL).
  if (snapshot.dns && !state.fatal) {
    await runDnsFollowUp(snapshot, collectors.dnsFollowUp, ctx(), state, log, grace);
  }
  // So are the pages with a form, whose http:// addresses TLS-01 reads.
  if (snapshot.http && snapshot.browser && !state.fatal) {
    await runFormTwins(snapshot, collectors.httpFormTwins, ctx(), state, log, grace);
  }
  return state;
}

/** Directory of the artifacts (screenshots) inside the out dir. */
const ARTIFACTS_REL_DIR = 'artifacts';

function collectorContext(
  snapshot: Snapshot,
  rawTarget: TargetInfo,
  o: ResolvedScanOptions,
  signal: AbortSignal,
  deadline: number,
  log: Logger,
  clock: () => number,
): CollectorContext {
  return {
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
    config: o.config,
    userAgent: { http: uaToken(), token: uaToken() },
    signal,
    deadline,
    artifactsDir: path.join(o.outDir, ARTIFACTS_REL_DIR),
    artifactsRelDir: ARTIFACTS_REL_DIR,
    now: o.now,
    clock,
    log,
    snapshot,
  };
}

/**
 * Where the browser starts, as a change of its context; null when the TLS verdict makes a visit pointless (browser
 * skipped as `tls-blocked`, with the reason no other start page was taken). A refused certificate of the target sends
 * the browser to the redirect target of its plain-http address when `tlsFallbackEntry` accepts one.
 */
function browserEntry(
  snapshot: Snapshot,
  handover: CollectorHandover | undefined,
  mode: TlsFallbackMode,
  log: Logger,
): ((ctx: CollectorContext) => CollectorContext) | null {
  if (!tlsBlocked(snapshot)) return (ctx) => ctx;

  const decision = tlsFallbackEntry(snapshot, handover, mode);
  if (!decision.entry) {
    snapshot.plan.tlsFallback = decision.declined;
    snapshot.collection.browser = { status: 'skipped', reason: 'tls-blocked', durationMs: 0 };
    return null;
  }
  snapshot.plan.browserEntry = decision.record;
  log.info(`certificate of ${snapshot.target.host} refused: browser starts on ${decision.record.url}`);
  const entry = decision.entry;
  return (ctx) => ({ ...ctx, entry });
}

/**
 * On the redirect target of a refused certificate the browser was only an attempt: whatever kept it from the start page
 * there (the page itself, a browser that did not start, an exception, the global timeout) skips the browser checks, as
 * the refused certificate alone would have, instead of failing the scan or leaving the checks in error.
 */
function endFailedAttempt(snapshot: Snapshot, state: CollectState): void {
  const fatal = state.fatal;
  const status = snapshot.collection.browser;
  if (status?.reason === TLS_FALLBACK_FAILED) return;
  if (!fatal && startPageDone(snapshot)) return;

  const params = Object.entries(fatal?.params ?? {}).map(([k, v]) => `${k}=${v}`);
  fallbackFailed(
    snapshot,
    fatal
      ? { code: fatal.code, message: params.join('; ') || fatal.reason }
      : {
          code: status?.error?.code ?? status?.reason ?? 'no-start-page',
          message: status?.error?.message ?? 'start page not visited',
        },
  );
  state.fatal = null;
}

/** The browser checks did not run on the redirect target either; nothing the browser handed over is kept. */
function fallbackFailed(snapshot: Snapshot, error: { code: string; message: string }): void {
  snapshot.collection.browser = {
    status: 'skipped',
    reason: TLS_FALLBACK_FAILED,
    durationMs: snapshot.collection.browser?.durationMs ?? 0,
    error,
  };
  delete snapshot.browser;
  delete snapshot.documents;
  delete snapshot.cmp;
  snapshot.plan.browser = null;
}

/** Reason of a browser skipped because its start page on the redirect target of a refused certificate failed. */
export const TLS_FALLBACK_FAILED = 'tls-fallback-failed';

/** Runs the browser collector and merges its sections. */
async function runBrowserCollector(
  snapshot: Snapshot,
  collector: Collectors['browser'],
  ctx: CollectorContext,
  state: CollectState,
  log: Logger,
  graceMs: number,
): Promise<void> {
  const result = await runCollector('browser', collector, ctx, snapshot, state, log, graceMs);
  if (!result) return;

  const s = result.sections;
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

/**
 * Runs the DNS stage of the further mail domains and replaces the DNS section with its extended copy. It is not a
 * collector of its own in `collection`: a failure leaves the scanned domain's section as it was and is noted in it,
 * so MAIL-* say that the further domains are unknown instead of silently checking fewer.
 */
async function runDnsFollowUp(
  snapshot: Snapshot,
  collector: Collectors['dnsFollowUp'],
  ctx: CollectorContext,
  state: CollectState,
  log: Logger,
  graceMs: number,
): Promise<void> {
  const t0 = performance.now();
  const failed = (code: string, message: string) => {
    log.warn(`DNS follow-up: ${message}`);
    if (!snapshot.dns) return;
    snapshot.dns.mailDomainStage = {
      contacts: 'not-collected',
      durationMs: Math.round(performance.now() - t0),
      error: { code, message },
    };
  };
  try {
    const pending = collector(ctx);
    const res = await untilDeadline(pending, ctx.signal);
    // After the deadline the stage stops at its next query; what it handed over within the grace period is kept, and
    // the scan reports the timeout like one in any other collector.
    if (res.timedOut) state.timedOut = true;
    const value = res.timedOut ? await withinGrace(pending, graceMs) : res.value;
    if (!value) return failed('timeout', 'no result within the grace period after the global timeout');
    if (value.diagnostics) snapshot.diagnostics.push(...value.diagnostics);
    if (value.sections.dns) snapshot.dns = value.sections.dns;
  } catch (err) {
    failed('collector-exception', errorMessage(err));
  }
}

/**
 * Requests the http:// addresses of the pages with a form and replaces the HTTP section with its extended copy. Like the
 * DNS follow-up it is no collector of its own in `collection`: a failure keeps the section and is noted in it, so TLS-01
 * says that the forms of further pages are unknown instead of reading their absence as clean.
 */
async function runFormTwins(
  snapshot: Snapshot,
  collector: Collectors['httpFormTwins'],
  ctx: CollectorContext,
  state: CollectState,
  log: Logger,
  graceMs: number,
): Promise<void> {
  const t0 = performance.now();
  const failed = (code: string, message: string) => {
    log.warn(`http:// addresses of pages with a form: ${message}`);
    if (!snapshot.http) return;
    snapshot.http.formTwinStage = {
      budget: ctx.config.http.formTwinPages,
      candidates: null,
      durationMs: Math.round(performance.now() - t0),
      error: { code, message },
    };
  };
  try {
    const pending = collector(ctx);
    const res = await untilDeadline(pending, ctx.signal);
    if (res.timedOut) state.timedOut = true;
    const value = res.timedOut ? await withinGrace(pending, graceMs) : res.value;
    if (!value) return failed('timeout', 'no result within the grace period after the global timeout');
    addSideOutputs(snapshot, value);
    if (value.sections.http) snapshot.http = value.sections.http;
  } catch (err) {
    failed('collector-exception', errorMessage(err));
  }
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
