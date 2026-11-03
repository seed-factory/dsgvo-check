/**
 * Browser collection: phase A (≤ maxPages, no interaction), phase B (start page:
 * observation before the click, first screen via the CMP subsystem, reject via the adapter, verify, reload, ≤ 2
 * control pages), phase C (accept on the start page, same control pages). Every phase runs in a fresh persistent
 * profile. Fatal start-page conditions are returned in `fatal` (5.2).
 *
 * This file holds the collection state and the phase lifecycle; the phases live in `phase-a.ts` and
 * `consent-phase.ts`, navigations under the overload policy in `navigate.ts`. They read and write the state of
 * `BrowserCollection` directly, so its shared members are not private.
 */
import type { BrowserType, Page } from 'playwright-core';
import type { CmpAdapter, CmpFacts, CmpPhaseFacts, CmpSection } from '../../cmp/types.ts';
import type {
  BrowserSections,
  CollectorContext,
  CollectorResult,
  FatalSignal,
} from '../../core/collector.ts';
import type { DiagnosticInput } from '../../core/snapshot.ts';
import type {
  BrowserPlan,
  BrowserSection,
  DocumentsSection,
  PhaseRecord,
  PlannedPage,
  ScreenshotRecord,
} from '../../core/snapshot-browser.ts';
import type { BrowserPhase, CollectorError, SanitizedUrl } from '../../core/snapshot-common.ts';
import type { ProbeRecord } from '../../core/snapshot-http.ts';
import { browserUserAgent } from '../../core/user-agent.ts';
import { type CmpApi, CmpBridge } from './cmp-bridge.ts';
import {
  BASE_KNOWN_GAPS,
  BROWSER_CHANNEL,
  type BrowserTiming,
  LOCALE,
  TIMEZONE,
  VIEWPORT,
} from './config.ts';
import { phaseB, phaseC } from './consent-phase.ts';
import { sanitizeRequestUrl } from './features.ts';
import { inputHookInit } from './in-page-input.ts';
import { cookieHookInit, storageHookInit } from './in-page-storage.ts';
import { JarTracker, type Moment } from './jar.ts';
import {
  classifyLaunchError,
  type EngineProbe,
  launchPhase,
  type PhaseBrowser,
  probeEngine,
  removeStaleProfiles,
} from './launch.ts';
import { linkDocuments } from './legal-documents.ts';
import { type BlockedPage, blockedDiagnostic, privateBlockedDiagnostic } from './navigate.ts';
import type { ControlChoice } from './pages.ts';
import { phaseA } from './phase-a.ts';
import { localScanClock, NetworkRecorder, type RequestCounter, type ScanClock } from './recorder.ts';
import { type GuardHandle, type GuardVerdict, installSsrfGuard, type LookupError } from './ssrf.ts';
import { errorText, sleep } from './util.ts';
import { type VisitResult, valueWithin } from './visit.ts';

export interface BrowserCollectorDeps {
  cmp: CmpApi;
  timing: BrowserTiming;
  chromium: BrowserType;
  phases: readonly BrowserPhase[];
  requestLimit: number;
  executablePath?: string;
  /** Budget of closing a phase browser before it is killed (default `CLOSE_BUDGET_MS`). */
  closeBudgetMs?: number;
  /** After the global abort: how long an orderly shutdown may take before the collector hands over what it has. */
  abortOrderlyMs?: number;
  /** SSRF guard: lookup retry policy for transient resolver errors (tests shorten the backoff). */
  lookupBackoffMs?: readonly number[];
}

export interface Session {
  phase: BrowserPhase;
  browser: PhaseBrowser;
  page: Page;
  recorder: NetworkRecorder;
  jar: JarTracker;
  cmp: CmpBridge;
  guard: GuardHandle;
  record: PhaseRecord;
  cmpFacts: CmpPhaseFacts;
  t0: number;
  /** The one end-of-phase pass (records copied into the phase record, pushed to the sections); shared by all callers. */
  sealing?: Promise<void>;
}

export interface AVisit {
  raw: string;
  result: VisitResult;
  source: PlannedPage['source'];
}

export type PhaseAOutcome = { kind: 'ok' } | { kind: 'fatal'; fatal: FatalSignal } | { kind: 'tls-blocked' };

/** A `Page` view without frames: the jar then reads cookies only (PDF viewer, error pages: nothing to read in-page). */
function withoutFrames(page: Page): Page {
  return new Proxy(page, { get: (t, p) => (p === 'frames' ? () => [] : Reflect.get(t, p, t)) });
}

/** How long the recorder may keep a phase waiting for response metadata at the end of the phase. */
const FLUSH_BUDGET_MS = 2_000;
/**
 * After the global abort the orderly shutdown (browser closed, profile removed) normally takes milliseconds and at most
 * about `FLUSH_BUDGET_MS` + `CLOSE_BUDGET_MS`. If it takes longer, the collector hands over what it has instead of
 * being given up by the orchestrator (`ABORT_GRACE_MS` = 10 s).
 */
const ABORT_ORDERLY_MS = 5_500;

export class BrowserCollection {
  readonly counter: RequestCounter;
  private engine: EngineProbe | null = null;
  private userAgent = '';
  current: PhaseBrowser | null = null;
  lastNavigationEnd = 0;
  readonly phases: PhaseRecord[] = [];
  readonly plan: BrowserPlan = { pages: [], controlPages: [], click: {} };
  readonly documents: DocumentsSection = { documents: [], attempts: [] };
  private readonly cmpSection: CmpSection = { phases: [] };
  readonly screenshots: ScreenshotRecord[] = [];
  private readonly errors: CollectorError[] = [];
  readonly diagnostics: DiagnosticInput[] = [];
  readonly probes: ProbeRecord[] = [];
  private readonly knownGaps = new Set<string>(BASE_KNOWN_GAPS);
  guard = { enabled: false, blocked: 0 };
  private guardScope: GuardHandle['scope'];
  /** Verdicts of documents refused by the SSRF guard (address classes for the diagnostic). */
  readonly guardVerdicts: GuardVerdict[] = [];
  /** Verdicts of refusals that a successful repeat of the same navigation made good: no document is missing. */
  readonly guardRecovered: GuardVerdict[] = [];
  /** Hosts of documents the guard refused (in memory only): tells a redirect from a non-public start host. */
  readonly guardBlockedHosts = new Set<string>();
  /** The target host answered with 429/503: no new navigation to it. */
  throttled = false;
  startRaw = '';
  scope = { finalHost: '', etld1: null as string | null };
  readonly aVisits: AVisit[] = [];
  control: ControlChoice[] = [];
  cmpRecognized: boolean | null = null;
  stoppedEarly: string | null = null;
  /** The phase session that is open (not yet closed), for the hand-over after an abort. */
  session: Session | null = null;
  /** Pages with a challenge or an access block other than the start page of phase A (SCAN-BLOCKED). */
  readonly blockedPages: BlockedPage[] = [];
  /** Resolver errors of the SSRF guard: code and scan-clock time. */
  readonly lookupErrors: Array<LookupError & { atMs: number }> = [];

  readonly ctx: CollectorContext;
  readonly deps: BrowserCollectorDeps;
  /** 5.3 `tMs` scale: the scan clock of the orchestrator, else one clock for all phases of this collection. */
  private readonly clock: ScanClock;

  constructor(ctx: CollectorContext, deps: BrowserCollectorDeps) {
    this.ctx = ctx;
    this.deps = deps;
    this.counter = { limit: deps.requestLimit, issued: 0, truncated: false };
    this.clock = ctx.clock ?? localScanClock();
  }

  async run(): Promise<CollectorResult<BrowserSections>> {
    const signal = this.ctx.signal;
    // Abort: close the running phase browser at once; every later close() awaits the same cleanup.
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<'aborted'>((resolve) => {
      onAbort = () => {
        void this.current?.close();
        resolve('aborted');
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const body = this.runBody();
    body.catch(() => undefined);
    try {
      const first = await Promise.race([body, aborted]);
      if (first !== 'aborted') return first;
      // The orderly shutdown closes the browser and removes the profile, and returns the aborted result.
      const orderly = await valueWithin(
        body,
        this.deps.abortOrderlyMs ?? ABORT_ORDERLY_MS,
        new AbortController().signal,
        null,
      );
      return orderly.value ?? (await this.handover());
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async runBody(): Promise<CollectorResult<BrowserSections>> {
    try {
      // Profiles of scans that were killed (SIGKILL, crash) hold cookies of the scanned site: remove them first.
      try {
        const removed = removeStaleProfiles();
        if (removed.length > 0) this.ctx.log.info(`removed ${removed.length} stale browser profile(s)`);
      } catch {
        // housekeeping only
      }
      const cfg = this.launchConfig();
      try {
        this.engine = await probeEngine(cfg);
      } catch (err) {
        if (this.ctx.signal.aborted) return this.abortedResult();
        const fatal = classifyLaunchError(err, this.ctx.options.sandbox);
        this.ctx.log.error(`browser launch failed: ${errorText(err).split('\n')[0]}`);
        return {
          status: 'error',
          reason: fatal.code,
          sections: {},
          error: { code: fatal.code, message: errorText(err).split('\n')[0] ?? fatal.code },
          fatal,
        };
      }
      this.userAgent = browserUserAgent(this.engine.rawUserAgent);

      let a: PhaseAOutcome;
      try {
        a = await phaseA(this);
      } catch (err) {
        if (this.ctx.signal.aborted) return this.abortedResult();
        const message = errorText(err).split('\n')[0]?.slice(0, 300) ?? '';
        this.ctx.log.error(`browser phase A failed: ${message}`);
        return {
          status: 'error',
          reason: 'exception',
          sections: {},
          error: { code: 'phase-a-failed', message },
        };
      }
      // A failure caused by the abort (closed browser → navigation error) is not a fatal of the site.
      if (this.ctx.signal.aborted) return this.abortedResult();
      if (a.kind === 'tls-blocked') return { status: 'skipped', reason: 'tls-blocked', sections: {} };
      if (a.kind === 'fatal') return { ...this.result('error'), fatal: a.fatal, reason: a.fatal.code };
      if (this.deps.phases.includes('B')) await this.runPhase('B', () => phaseB(this));
      if (this.deps.phases.includes('C')) await this.runPhase('C', () => phaseC(this));
      if (this.ctx.signal.aborted) return this.abortedResult();
      const partial =
        this.counter.truncated ||
        this.stoppedEarly !== null ||
        this.phases.some(
          (p) =>
            p.status === 'failed' ||
            p.reason === 'time-budget' ||
            p.reason === 'request-cap' ||
            p.reason === 'throttled',
        );
      return this.result(partial ? 'partial' : 'ok');
    } finally {
      // Awaits the cleanup an abort may already have started (browser closed, temp profile removed).
      await this.current?.close();
    }
  }

  /**
   * Result after the abort (global --timeout): before the start page was visited nothing is delivered (5.2: the
   * orchestrator reports failed/SCAN-TIMEOUT); afterwards what was collected is kept. Phases that did not run are
   * recorded as skipped by the deadline, so that checks can tell "cut by the deadline" from "not planned".
   * Never a fatal of the site.
   */
  private abortedResult(): CollectorResult<BrowserSections> {
    if (!this.startRaw || !this.engine) return { status: 'error', reason: 'timeout', sections: {} };
    for (const phase of this.deps.phases) {
      if (!this.phases.some((p) => p.phase === phase)) {
        this.phases.push(this.skippedPhase(phase, 'skipped', 'timeout'));
      }
    }
    return { ...this.result('partial'), reason: 'timeout' };
  }

  /**
   * The orderly shutdown after an abort did not finish in time (a browser that does not close, a call without
   * timeout): hand over what the phases hold now, from the running phase too. The orderly flow may still run in the
   * background, so the sections are a copy it can no longer change.
   */
  private async handover(): Promise<CollectorResult<BrowserSections>> {
    this.ctx.log.warn(
      'browser collector: shutdown after the abort timed out, handing over the collected facts',
    );
    const s = this.session;
    if (s && this.current === s.browser) await this.sealPhase(s);
    return structuredClone(this.abortedResult());
  }

  private launchConfig() {
    return {
      chromium: this.deps.chromium,
      sandbox: this.ctx.options.sandbox,
      network: this.ctx.network,
      ...(this.deps.executablePath ? { executablePath: this.deps.executablePath } : {}),
      ...(this.deps.closeBudgetMs !== undefined ? { closeBudgetMs: this.deps.closeBudgetMs } : {}),
      log: this.ctx.log,
    };
  }

  timeLeft(): boolean {
    return !this.ctx.signal.aborted && Date.now() < this.ctx.deadline - this.deps.timing.deadlineReserveMs;
  }

  /**
   * A phase stopped because the time ran out. The global deadline (abort) is `timeout`; only the local reserve before it
   * is `time-budget` and marks the collector as stopped early (7.6).
   */
  cutByTime(record: PhaseRecord): void {
    record.status = 'partial';
    if (this.ctx.signal.aborted) record.reason = 'timeout';
    else {
      record.reason = 'time-budget';
      this.stoppedEarly ??= 'time-budget';
    }
  }

  async pace(): Promise<void> {
    const wait = this.lastNavigationEnd + this.deps.timing.navigationPauseMs - Date.now();
    await sleep(wait, this.ctx.signal);
  }

  async openPhase(phase: BrowserPhase): Promise<Session> {
    if (this.ctx.signal.aborted) throw new Error('aborted');
    const browser = await launchPhase(this.launchConfig(), this.userAgent);
    this.current = browser;
    if (this.ctx.signal.aborted) {
      await browser.close();
      throw new Error('aborted');
    }
    const etld1 = this.scope.etld1 ?? this.ctx.target.etld1;
    const recorder = new NetworkRecorder(
      phase,
      etld1,
      this.counter,
      this.ctx.network.proxy !== null,
      this.clock,
      { signal: this.ctx.signal },
    );
    recorder.attach(browser.context);
    await browser.context.addInitScript(cookieHookInit);
    await browser.context.addInitScript(storageHookInit);
    await browser.context.addInitScript(inputHookInit);
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    const guard = await installSsrfGuard(
      browser.context,
      this.ctx.network,
      (url, verdict) => {
        recorder.flagGuardBlocked(url);
        this.guard.blocked++;
        this.guardVerdicts.push(verdict);
        try {
          this.guardBlockedHosts.add(new URL(url).hostname.toLowerCase());
        } catch {
          // not a URL: no host to record
        }
      },
      {
        onLookupError: (e) => this.lookupErrors.push({ ...e, atMs: Math.max(0, Math.round(this.clock())) }),
        ...(this.deps.lookupBackoffMs ? { backoffMs: this.deps.lookupBackoffMs } : {}),
      },
    );
    this.guard.enabled = guard.enabled;
    if (guard.scope) this.guardScope = guard.scope;
    const record: PhaseRecord = {
      phase,
      status: 'completed',
      startedAt: this.ctx.now().toISOString(),
      durationMs: 0,
      profile: 'persistent-tmp',
      pages: [],
      requests: [],
      cookies: [],
      storage: [],
      errors: [],
    };
    const host = this.scope.finalHost || this.ctx.target.host;
    const session: Session = {
      phase,
      browser,
      page,
      recorder,
      jar: this.newJar(recorder, { etld1, host }, record),
      cmp: new CmpBridge(this.deps.cmp, this.deps.timing.cmpCallTimeoutMs, record.errors, phase),
      guard,
      record,
      cmpFacts: { phase, facts: [] },
      t0: performance.now(),
    };
    this.session = session;
    return session;
  }

  /**
   * Cookie/storage tracker; a `Set-Cookie` on a request started after the click is a write after the click. Its
   * in-page reads are bounded by time and by the scan signal; a read that ran out of time is a phase error.
   */
  newJar(
    recorder: NetworkRecorder,
    target: { etld1: string | null; host: string },
    record: PhaseRecord,
  ): JarTracker {
    return new JarTracker(target, recorder.setCookieOrigins, {
      signal: this.ctx.signal,
      onError: (what, err) => {
        const code = 'in-page-read-timeout';
        // One entry per kind of read is enough; a PDF-heavy site would repeat it for every page.
        if (record.errors.some((e) => e.code === code && e.message.startsWith(what))) return;
        record.errors.push({
          code,
          message: `${what}: ${errorText(err)}`.slice(0, 300),
          phase: record.phase,
        });
      },
    });
  }

  moment(s: Session, pageUrl: SanitizedUrl): Moment {
    const ref = s.recorder.reference;
    const actionId = s.recorder.actionId;
    return {
      phase: s.phase,
      pageUrl,
      tMs: Math.max(0, Math.round(performance.now() - ref.at)),
      tRef: ref.tRef,
      afterClick: s.recorder.isAfterClick,
      atMs: s.recorder.now(),
      ...(s.recorder.navigationId ? { navigationId: s.recorder.navigationId } : {}),
      ...(actionId ? { actionId } : {}),
    };
  }

  /** Wait for the recorder's response handlers, at most `FLUSH_BUDGET_MS`, and never past the abort. */
  async flushRecorder(s: Session): Promise<void> {
    await valueWithin(
      s.recorder.flush({ timeoutMs: FLUSH_BUDGET_MS, signal: this.ctx.signal }),
      FLUSH_BUDGET_MS + 250,
      this.ctx.signal,
      true,
    );
  }

  /**
   * End of a phase: the recorder's, the jar's facts go into the phase record, which joins the sections. Done once
   * per session, whoever asks first (the phase itself or the hand-over after an abort); needs no working browser.
   */
  private sealPhase(s: Session): Promise<void> {
    s.sealing ??= (async () => {
      await this.flushRecorder(s);
      s.jar.finalize(this.moment(s, s.record.pages.at(-1)?.finalUrl ?? sanitizeRequestUrl(this.startRaw)));
      s.recorder.dispose();
      s.record.requests = s.recorder.records;
      s.record.cookies = s.jar.cookies;
      s.record.storage = s.jar.storage;
      s.record.durationMs = Math.round(performance.now() - s.t0);
      if (s.recorder.dropped > 0 && s.record.status === 'completed') {
        s.record.status = 'partial';
        s.record.reason = 'request-cap';
      }
      // A phase the global deadline cut off did not run to its end.
      if (this.ctx.signal.aborted && s.record.status === 'completed') {
        s.record.status = 'partial';
        s.record.reason = 'timeout';
      }
      this.cmpSection.phases.push(s.cmpFacts);
      this.phases.push(s.record);
    })();
    return s.sealing;
  }

  async closePhase(s: Session): Promise<void> {
    await this.sealPhase(s);
    await s.browser.close();
    if (this.current === s.browser) this.current = null;
    if (this.session === s) this.session = null;
  }

  /** Run phase B or C; an exception marks the phase failed but keeps everything collected so far. */
  private async runPhase(phase: 'B' | 'C', fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.ctx.log.warn(`phase ${phase} failed: ${errorText(err).split('\n')[0]}`);
      const existing = this.phases.find((p) => p.phase === phase);
      const error = { code: 'phase-failed', message: errorText(err).slice(0, 300), phase };
      if (existing) {
        existing.status = 'failed';
        existing.errors.push(error);
      } else {
        this.phases.push(this.skippedPhase(phase, 'failed', 'exception', [error]));
      }
      await this.current?.close();
      this.current = null;
      this.session = null;
    }
  }

  skippedPhase(
    phase: BrowserPhase,
    status: PhaseRecord['status'],
    reason: string,
    errors: CollectorError[] = [],
  ): PhaseRecord {
    return {
      phase,
      status,
      reason,
      startedAt: this.ctx.now().toISOString(),
      durationMs: 0,
      profile: 'persistent-tmp',
      pages: [],
      requests: [],
      cookies: [],
      storage: [],
      errors,
    };
  }

  /**
   * Cookies/storage snapshot and identifier correlation; CMP facts when `moment` is given. A page that is no readable
   * HTML document (PDF viewer, the browser's error page, a failed DOM read) gets its cookies from the jar only: in-page
   * reads and the CMP calls would wait for frames that never answer.
   */
  async afterPage(
    s: Session,
    r: VisitResult,
    cmpMoment: CmpFacts['moment'] | null,
    adapter: CmpAdapter | null = null,
  ): Promise<CmpFacts | null> {
    // Facts of a page are attributed to the page as shown (final URL after redirects), like its requests.
    const pageUrl = r.visit.finalUrl;
    const readable = !r.error && r.visit.dom !== null;
    const values = await s.jar.snapshot(
      s.browser.context,
      readable ? s.page : withoutFrames(s.page),
      this.moment(s, pageUrl),
    );
    s.recorder.correlate(values);
    values.length = 0;
    if (!cmpMoment || !readable) return null;
    let a = adapter;
    if (s.phase === 'A') a = (await s.cmp.detect(s.page, pageUrl))?.adapter ?? null;
    const facts = await s.cmp.extract(s.page, a, cmpMoment, pageUrl);
    if (facts) s.cmpFacts.facts.push(facts);
    return facts;
  }

  /** Why the collection is partial: the first unfinished phase (7.6 "незавершённые"); `cmp-not-recognized` is normal. */
  private partialReason(): string | undefined {
    const order: BrowserPhase[] = ['A', 'B', 'C'];
    const phases = [...this.phases].sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
    for (const p of phases) {
      if (p.status === 'failed') return `phase-failed:${p.phase}`;
      if (p.reason && ['time-budget', 'throttled', 'request-cap', 'timeout'].includes(p.reason))
        return p.reason;
    }
    if (this.counter.truncated) return 'request-cap';
    return this.stoppedEarly ?? undefined;
  }

  private result(status: 'ok' | 'partial' | 'error'): CollectorResult<BrowserSections> {
    const engine = this.engine as EngineProbe;
    if (this.guard.enabled) this.knownGaps.add('ssrf-guard-subresources-unchecked');
    if (this.guardScope === 'page') this.knownGaps.add('ssrf-guard-popups-unchecked');
    const diagnostics = [
      ...this.diagnostics,
      ...[privateBlockedDiagnostic(this), blockedDiagnostic(this)].filter((d) => d !== null),
    ];
    const reason = status === 'partial' ? this.partialReason() : undefined;
    linkDocuments(this.phases, this.documents);
    const order: BrowserPhase[] = ['A', 'B', 'C'];
    this.phases.sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
    this.cmpSection.phases.sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
    const browser: BrowserSection = {
      engine: {
        name: 'chromium',
        channel: BROWSER_CHANNEL,
        version: engine.version,
        headless: 'new',
        userAgent: this.userAgent,
        sandbox: engine.sandbox,
        disabledFeatures: engine.disabledFeatures,
      },
      viewport: VIEWPORT,
      locale: LOCALE,
      timezoneId: TIMEZONE,
      phases: this.phases,
      requestCap: { ...this.counter },
      guard: { ...this.guard },
      screenshots: this.screenshots,
      knownGaps: [...this.knownGaps].sort(),
      errors: this.errors,
    };
    return {
      status,
      ...(reason ? { reason } : {}),
      sections: {
        browser,
        documents: this.documents,
        cmp: this.cmpSection,
        plan: this.plan,
        ...(this.startRaw ? { finalUrl: this.startRaw } : {}),
      },
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      ...(this.probes.length > 0 ? { probes: this.probes } : {}),
    };
  }
}
