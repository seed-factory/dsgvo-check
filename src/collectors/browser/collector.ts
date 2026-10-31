/**
 * Browser collection (D08, D09, D15, D20, D25): phase A (≤ maxPages, no interaction), phase B (start page:
 * observation before the click, first screen via the CMP subsystem, reject via the adapter, verify, reload, ≤ 2
 * control pages), phase C (accept on the start page, same control pages). Every phase runs in a fresh persistent
 * profile. Fatal start-page conditions are returned in `fatal` (5.2).
 */
import type { BrowserType, Page } from 'playwright-core';
import type { CmpAdapter, CmpButton, CmpFacts, CmpPhaseFacts, CmpSection } from '../../cmp/types.ts';
import type {
  BrowserSections,
  CollectorContext,
  CollectorResult,
  FatalSignal,
} from '../../core/collector.ts';
import type { DiagnosticInput } from '../../core/snapshot.ts';
import type { BrowserPhase, CollectorError, SanitizedUrl } from '../../core/snapshot-common.ts';
import { registrableDomain } from '../../core/url.ts';
import { browserUserAgent } from '../../core/user-agent.ts';
import { TOOL_NAME } from '../../core/version.ts';
import type { ProbeRecord } from '../http/types.ts';
import { type CmpApi, CmpBridge, combineVerify } from './cmp-bridge.ts';
import {
  BASE_KNOWN_GAPS,
  BROWSER_CHANNEL,
  type BrowserTiming,
  LOCALE,
  TIMEZONE,
  VIEWPORT,
} from './config.ts';
import { extractDocument, pdfDocument } from './documents.ts';
import { sanitizeRequestUrl } from './features.ts';
import { fetchText } from './http-fetch.ts';
import { cookieHookInit, inputEventsInPage, inputHookInit, storageHookInit } from './in-page.ts';
import { JarTracker, type Moment } from './jar.ts';
import {
  classifyLaunchError,
  type EngineProbe,
  launchPhase,
  type PhaseBrowser,
  probeEngine,
  removeStaleProfiles,
} from './launch.ts';
import {
  type CandidateLink,
  type ControlChoice,
  chooseControlPages,
  findLegalLink,
  type LegalKind,
  type LegalLinkResult,
  type PageChoice,
  pageKey,
  selectPages,
} from './pages.ts';
import { waitForQuiet } from './quiet.ts';
import { localScanClock, NetworkRecorder, type RequestCounter, type ScanClock } from './recorder.ts';
import { parseRobots, parseSitemap, type Robots } from './robots.ts';
import { bannerScreenshot } from './screenshot.ts';
import { type GuardHandle, type GuardVerdict, installSsrfGuard, type LookupError } from './ssrf.ts';
import type {
  BrowserPlan,
  BrowserSection,
  ClickPlan,
  DocumentRecord,
  DocumentsSection,
  PageRole,
  PhaseRecord,
  PlannedPage,
  ScreenshotRecord,
} from './types.ts';
import { errorText, sleep, withTimeout } from './util.ts';
import { navigationErrorCode, settleWithin, type VisitResult, type VisitSpec, visitPage } from './visit.ts';

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

interface Session {
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

interface AVisit {
  raw: string;
  result: VisitResult;
  source: PlannedPage['source'];
}

type PhaseAOutcome = { kind: 'ok' } | { kind: 'fatal'; fatal: FatalSignal } | { kind: 'tls-blocked' };

/** A page the target host blocked or answered with a challenge (SCAN-BLOCKED, 7.3). */
interface BlockedPage {
  page: SanitizedUrl;
  phase: BrowserPhase;
  role: PageRole;
  kind: string;
  status: number | null;
  signals: string[];
  /** Check ids whose result depends on this page. */
  affects: string[];
}

/** A `Page` view without frames: the jar then reads cookies only (PDF viewer, error pages: nothing to read in-page). */
function withoutFrames(page: Page): Page {
  return new Proxy(page, { get: (t, p) => (p === 'frames' ? () => [] : Reflect.get(t, p, t)) });
}

const LEGAL_KINDS: readonly LegalKind[] = ['impressum', 'privacy'];
const FALLBACK_PATHS: Record<LegalKind, string> = { impressum: '/impressum', privacy: '/datenschutz' };

/** Checks whose browser input is incomplete when the target host throttles (`SCAN-THROTTLED` affects). */
const BROWSER_CHECKS = [
  'CONSENT-01',
  'CONSENT-02',
  'CONSENT-03',
  'CONSENT-04',
  'CONSENT-05',
  'EMBED-01',
  'EMBED-02',
  'LEGAL-01',
  'PRIV-01',
  'TRACK-01',
];
/** Overload answers of the target host (D09, table 5.2). */
const THROTTLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** This many 429/503 responses of the target host within one phase count as throttling (D09). */
const THROTTLE_RESPONSES = 3;
const MAX_RETRY_AFTER_MS = 30_000;
/** `about:blank` has no request: leaving a failed start navigation takes milliseconds, this is only the upper bound (L2). */
const LEAVE_NAVIGATION_TIMEOUT_MS = 3_000;
/** How long the recorder may keep a phase waiting for response metadata at the end of the phase (G49, G51). */
const FLUSH_BUDGET_MS = 2_000;
/**
 * After the global abort the orderly shutdown (browser closed, profile removed) normally takes milliseconds and at most
 * about `FLUSH_BUDGET_MS` + `CLOSE_BUDGET_MS`. If it takes longer, the collector hands over what it has instead of
 * being given up by the orchestrator (`ABORT_GRACE_MS` = 10 s, G51).
 */
const ABORT_ORDERLY_MS = 5_500;
/** Pages tried after a legal link led to a page of the wrong type, per scan (D09: ≤ 3 GET for finding a document). */
const MAX_CANDIDATE_RETRIES = 3;

export class BrowserCollection {
  private readonly counter: RequestCounter;
  private engine: EngineProbe | null = null;
  private userAgent = '';
  private current: PhaseBrowser | null = null;
  private lastNavigationEnd = 0;
  private readonly phases: PhaseRecord[] = [];
  private readonly plan: BrowserPlan = { pages: [], controlPages: [], click: {} };
  private readonly documents: DocumentsSection = { documents: [], attempts: [] };
  private readonly cmpSection: CmpSection = { phases: [] };
  private readonly screenshots: ScreenshotRecord[] = [];
  private readonly errors: CollectorError[] = [];
  private readonly diagnostics: DiagnosticInput[] = [];
  private readonly probes: ProbeRecord[] = [];
  private readonly knownGaps = new Set<string>(BASE_KNOWN_GAPS);
  private guard = { enabled: false, blocked: 0 };
  private guardScope: GuardHandle['scope'];
  /** Verdicts of documents refused by the SSRF guard (address classes for the diagnostic). */
  private readonly guardVerdicts: GuardVerdict[] = [];
  /** Verdicts of refusals that a successful repeat of the same navigation made good (R28): no document is missing. */
  private readonly guardRecovered: GuardVerdict[] = [];
  /** Hosts of documents the guard refused (in memory only): tells a redirect from a non-public start host (FP-05). */
  private readonly guardBlockedHosts = new Set<string>();
  /** The target host answered with 429/503 (D09): no new navigation to it. */
  private throttled = false;
  private startRaw = '';
  private scope = { finalHost: '', etld1: null as string | null };
  private readonly aVisits: AVisit[] = [];
  private control: ControlChoice[] = [];
  private cmpRecognized: boolean | null = null;
  private stoppedEarly: string | null = null;
  /** The phase session that is open (not yet closed), for the hand-over after an abort. */
  private session: Session | null = null;
  /** Pages with a challenge or an access block other than the start page of phase A (SCAN-BLOCKED, G54). */
  private readonly blockedPages: BlockedPage[] = [];
  /** Resolver errors of the SSRF guard: code and scan-clock time (G52). */
  private readonly lookupErrors: Array<LookupError & { atMs: number }> = [];

  private readonly ctx: CollectorContext;
  private readonly deps: BrowserCollectorDeps;
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
      const orderly = await settleWithin(
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
      // Profiles of scans that were killed (SIGKILL, crash) hold cookies of the scanned site: remove them first (G57).
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
          error: { code: fatal.code, message: fatal.message },
          fatal,
        };
      }
      this.userAgent = browserUserAgent(this.engine.rawUserAgent);

      let a: PhaseAOutcome;
      try {
        a = await this.phaseA();
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
      if (this.deps.phases.includes('B')) await this.runPhase('B', () => this.phaseB());
      if (this.deps.phases.includes('C')) await this.runPhase('C', () => this.phaseC());
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
   * recorded as skipped by the deadline, so that checks can tell "cut by the deadline" from "not planned" (G50).
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
   * background, so the sections are a copy it can no longer change (G51).
   */
  private async handover(): Promise<CollectorResult<BrowserSections>> {
    this.ctx.log.warn(
      'browser collector: shutdown after the abort timed out, handing over the collected facts',
    );
    const s = this.session;
    if (s && this.current === s.browser) await this.sealPhase(s);
    return structuredClone(this.abortedResult());
  }

  // ---------------------------------------------------------------- infrastructure

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

  private timeLeft(): boolean {
    return !this.ctx.signal.aborted && Date.now() < this.ctx.deadline - this.deps.timing.deadlineReserveMs;
  }

  /**
   * A phase stopped because the time ran out. The global deadline (abort) is `timeout`; only the local reserve before it
   * is `time-budget` and marks the collector as stopped early (R27, 7.6).
   */
  private cutByTime(record: PhaseRecord): void {
    record.status = 'partial';
    if (this.ctx.signal.aborted) record.reason = 'timeout';
    else {
      record.reason = 'time-budget';
      this.stoppedEarly ??= 'time-budget';
    }
  }

  private async pace(): Promise<void> {
    const wait = this.lastNavigationEnd + this.deps.timing.navigationPauseMs - Date.now();
    await sleep(wait, this.ctx.signal);
  }

  private async openPhase(phase: BrowserPhase): Promise<Session> {
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
   * in-page reads are bounded by time and by the scan signal; a read that ran out of time is a phase error (G49).
   */
  private newJar(
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

  private moment(s: Session, pageUrl: SanitizedUrl): Moment {
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
  private async flushRecorder(s: Session): Promise<void> {
    await settleWithin(
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

  private async closePhase(s: Session): Promise<void> {
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

  private skippedPhase(
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

  private async visit(s: Session, spec: VisitSpec): Promise<VisitResult> {
    await this.pace();
    const r = await visitPage(
      {
        page: s.page,
        recorder: s.recorder,
        timing: this.deps.timing,
        phaseTiming: this.deps.timing.phases[s.phase],
        signal: this.ctx.signal,
        target: {
          etld1: this.scope.etld1 ?? this.ctx.target.etld1,
          host: this.scope.finalHost || this.ctx.target.host,
        },
        now: this.ctx.now,
      },
      spec,
    );
    this.lastNavigationEnd = Date.now();
    s.record.pages.push(r.visit);
    // Facts the page budget cut off (G49) stay visible as phase errors; what was gathered before the cut is kept.
    for (const l of r.limitations ?? []) {
      s.record.errors.push({ code: l.code, message: l.message, phase: s.phase, url: r.visit.url });
    }
    // Whether the page counts as blocked is decided by the final outcome of the logical navigation (`navigate`), not
    // by this attempt: a repeat may still deliver the page (S-robustness-3).
    return r;
  }

  /**
   * Check ids that read the page (7.3 "затронутые ID"): the legal documents by the page's role (a fallback probe by its
   * path), the start page of B/C for the consent checks, the contact page for the embed check.
   */
  private blockedAffects(spec: VisitSpec): string[] {
    let role: PageRole = spec.role;
    if (role === 'fallback') {
      const path = (() => {
        try {
          return new URL(spec.rawUrl).pathname;
        } catch {
          return '';
        }
      })();
      role = path === FALLBACK_PATHS.privacy ? 'privacy' : 'impressum';
    }
    switch (role) {
      case 'impressum':
      case 'legal-hop':
        return ['LEGAL-01'];
      case 'privacy':
        return ['LEGAL-01', 'PRIV-01'];
      case 'contact':
        return ['EMBED-02'];
      case 'start':
        return spec.phase === 'A' ? [] : ['CONSENT-04', 'CONSENT-05'];
      default:
        return [];
    }
  }

  private noteBlocked(spec: VisitSpec, r: VisitResult): void {
    const v = r.visit;
    // One entry per page and phase, however often the page was navigated to.
    if (this.blockedPages.some((b) => b.page === v.url && b.phase === spec.phase)) return;
    this.blockedPages.push({
      page: v.url,
      phase: spec.phase,
      role: spec.role,
      kind: v.challenge.kind ?? 'other',
      status: v.navigation.status,
      signals: v.challenge.signals,
      affects: this.blockedAffects(spec),
    });
  }

  /**
   * A navigation under the overload policy of D09 / table 5.2 (S-27): 429/503 → pause by Retry-After (≤ 30 s) and
   * one retry; still 429/503 — or ≥ 3 such responses of the target host in this phase — → throttled: SCAN-THROTTLED,
   * the phase is partial and no new navigation to the host starts.
   */
  private async navigate(s: Session, spec: VisitSpec): Promise<VisitResult> {
    let r = await this.visit(s, spec);
    const firstAttempt = r;
    const first = this.throttleStatus(r);
    let repeated = false;
    if (first !== null && this.timeLeft()) {
      await sleep(
        Math.min(MAX_RETRY_AFTER_MS, r.retryAfterMs ?? this.deps.timing.retryDelayMs),
        this.ctx.signal,
      );
      s.record.pages.pop();
      r = await this.visit(s, spec);
      repeated = true;
      const second = this.throttleStatus(r);
      if (second !== null) this.markThrottled(s, 'navigation', r.visit.url, [first, second]);
    }
    this.settleBlocked(s, spec, repeated ? firstAttempt : null, r);
    this.checkThrottleResponses(s, r.visit.url);
    return r;
  }

  /**
   * SCAN-BLOCKED follows the final outcome of the logical navigation (S-robustness-3): a page whose final visit is a
   * bot-protection page is blocked, so is one whose first attempt was and whose repeat gave no evaluable page; a page
   * that the repeat delivered is evaluated and not blocked. The block of the first attempt stays a fact of the phase
   * (an entry of `PhaseRecord.errors`, like the start-page repeat of L2). The start page of phase A is the fatal
   * case (scan.ts); every other blocked page is a coverage gap.
   */
  private settleBlocked(
    s: Session,
    spec: VisitSpec,
    firstAttempt: VisitResult | null,
    final: VisitResult,
  ): void {
    if (spec.role === 'start' && spec.phase === 'A') return;
    const first = firstAttempt?.visit.challenge.detected ? firstAttempt : null;
    if (final.visit.challenge.detected) this.noteBlocked(spec, final);
    else if (first && !final.visit.evaluable) this.noteBlocked(spec, first);
    if (!first) return;
    const v = first.visit;
    const outcome = final.visit.challenge.detected
      ? 'was blocked again'
      : final.visit.evaluable
        ? 'delivered the page'
        : 'gave no evaluable page';
    s.record.errors.push({
      code: `http-${v.navigation.status ?? 0}`,
      message:
        `${spec.role} page: attempt 1 of 2 was answered with a bot-protection page (${v.challenge.kind ?? 'other'}); ` +
        `repeated after the overload pause, attempt 2 ${outcome}`,
      phase: s.phase,
      url: v.url,
    });
  }

  private throttleStatus(r: VisitResult): number | null {
    const status = r.visit.navigation.status;
    return !r.error && status !== null && THROTTLE_STATUSES.has(status) ? status : null;
  }

  /** Host of the target: final host, its www/apex pair and the requested host. */
  private isTargetHost(host: string): boolean {
    const h = host.toLowerCase();
    const finalHost = this.scope.finalHost || this.ctx.target.host;
    return (
      h === finalHost || h === this.ctx.target.host || h === `www.${finalHost}` || `www.${h}` === finalHost
    );
  }

  private checkThrottleResponses(s: Session, url: SanitizedUrl): void {
    if (this.throttled) return;
    const statuses = s.recorder.records
      .filter((r) => r.status !== undefined && THROTTLE_STATUSES.has(r.status) && this.isTargetHost(r.host))
      .map((r) => r.status as number);
    if (statuses.length >= THROTTLE_RESPONSES) this.markThrottled(s, 'responses', url, statuses);
  }

  private markThrottled(
    s: Session,
    scope: 'navigation' | 'responses',
    url: SanitizedUrl,
    statuses: number[],
  ): void {
    s.record.status = 'partial';
    s.record.reason = 'throttled';
    this.stoppedEarly ??= 'throttled';
    if (this.throttled) return;
    this.throttled = true;
    this.ctx.log.warn(`target host throttles (${statuses.join(', ')}); no further navigation to it`);
    this.diagnostics.push({
      code: 'SCAN-THROTTLED',
      affects: [...BROWSER_CHECKS],
      params: { phase: s.phase, scope, url, statuses: statuses.slice(0, 10).join(',') },
    });
  }

  /**
   * Cookies/storage snapshot and identifier correlation; CMP facts when `moment` is given. A page that is no readable
   * HTML document (PDF viewer, the browser's error page, a failed DOM read) gets its cookies from the jar only: in-page
   * reads and the CMP calls would wait for frames that never answer (G49).
   */
  private async afterPage(
    s: Session,
    r: VisitResult,
    cmpMoment: CmpFacts['moment'] | null,
    adapter: CmpAdapter | null = null,
  ): Promise<CmpFacts | null> {
    // Facts of a page are attributed to the page as shown (final URL after redirects), like its requests (FC-02).
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

  // ---------------------------------------------------------------- phase A

  private async phaseA(): Promise<PhaseAOutcome> {
    const s = await this.openPhase('A');
    try {
      return await this.phaseABody(s);
    } finally {
      if (this.current === s.browser) await this.closePhase(s);
    }
  }

  private async visitStart(s: Session): Promise<{ r: VisitResult; statuses: number[] }> {
    const spec: VisitSpec = {
      rawUrl: this.ctx.target.url,
      role: 'start',
      order: 0,
      phase: 'A',
      firstVisit: true,
    };
    const t0 = Date.now();
    let r = await this.visit(s, spec);
    const failedAfterMs = Date.now() - t0;
    const statuses = [r.visit.navigation.status ?? 0];
    const status = r.visit.navigation.status;
    // Table 5.2 / 7.4: a timeout or 5xx of the start page counts only when it happens twice, so the first failure is
    // followed by one more attempt (also a timeout: it is the same condition as the 5xx). Not repeated: certificate
    // errors and a request the scanner refused.
    const retryable = r.error
      ? !/^ERR_(CERT|SSL|BLOCKED)/.test(navigationErrorCode(r.error))
      : status !== null && (status >= 500 || status === 429);
    if (retryable && this.timeLeft()) {
      const pauseMs = Math.min(MAX_RETRY_AFTER_MS, r.retryAfterMs ?? this.deps.timing.retryDelayMs);
      // The visit of the failed attempt is replaced by the repeat (one start visit per phase), so its trace is kept
      // as an error of the phase before the pause: the pause itself may run into the global deadline.
      this.noteStartRetry(s, r, failedAfterMs, pauseMs);
      await sleep(pauseMs, this.ctx.signal);
      if (r.error) await this.leaveFailedNavigation(s);
      s.record.pages.pop();
      r = await this.visit(s, spec);
      statuses.push(r.visit.navigation.status ?? 0);
    }
    return { r, statuses };
  }

  /**
   * A navigation that got no committed document (the server sent nothing, the browser timed out) is still the page's
   * navigation for Chromium: a `goto` to the same URL is taken for it and ends at once with `ERR_ABORTED`, without a
   * second request (L2). The page leaves it for `about:blank`, which has no request, so that the repeat is a new
   * navigation. Best effort: a failure here leaves the repeat as it was.
   */
  private async leaveFailedNavigation(s: Session): Promise<void> {
    await withTimeout(
      s.page.goto('about:blank', { waitUntil: 'commit', timeout: LEAVE_NAVIGATION_TIMEOUT_MS }),
      LEAVE_NAVIGATION_TIMEOUT_MS + 1_000,
      'leave the failed navigation',
    ).catch(() => undefined);
  }

  /**
   * The first navigation to the start page failed and is repeated (L2): the budget it used and the pause are a fact of
   * the scan. The entry of the phase carries the code of the failure (`navigation-timeout`, `ERR_…`, `http-503`), the
   * attempt, its duration, the pause and the navigation id of the attempt, whose requests stay in the phase.
   */
  private noteStartRetry(s: Session, failed: VisitResult, afterMs: number, pauseMs: number): void {
    const code = failed.error
      ? navigationErrorCode(failed.error) === 'timeout'
        ? 'navigation-timeout'
        : navigationErrorCode(failed.error)
      : `http-${failed.visit.navigation.status ?? 0}`;
    const id = failed.visit.navigationId;
    this.ctx.log.warn(
      `start page: attempt 1 of 2 failed (${code}) after ${afterMs} ms; repeating after a pause of ${pauseMs} ms`,
    );
    s.record.errors.push({
      code,
      message:
        `start page: attempt 1 of 2 failed after ${afterMs} ms; repeated after a pause of ${pauseMs} ms` +
        (id ? ` (navigation ${id})` : ''),
      phase: s.phase,
      url: failed.visit.url,
    });
  }

  /** Host of the requested start URL (the scan target, before any redirect). */
  private startHost(): string {
    return this.ctx.target.host.toLowerCase();
  }

  private startFatal(r: VisitResult): PhaseAOutcome | null {
    if (r.error) {
      const code = navigationErrorCode(r.error);
      if (/^ERR_(CERT|SSL)/.test(code)) return { kind: 'tls-blocked' };
      if (code === 'ERR_BLOCKED_BY_CLIENT' && this.guard.blocked > 0) {
        // Word it by the facts (FP-05): a redirect only when the refused document is on another host.
        const redirected = [...this.guardBlockedHosts].some((h) => h !== this.startHost());
        // Refused because the name does not resolve locally: the target is unreachable, not "not public".
        if (this.guardVerdicts.every((v) => v === 'unresolved')) {
          return {
            kind: 'fatal',
            fatal: {
              reason: 'unreachable',
              code: 'start-page-unresolved',
              message: redirected
                ? 'Die Startseite leitet auf einen Host weiter, dessen Name nicht aufgelöst werden kann.'
                : 'Der Name des Hosts der Startseite kann nicht aufgelöst werden.',
            },
          };
        }
        return {
          kind: 'fatal',
          fatal: {
            reason: 'invalid-input',
            code: 'start-page-not-public',
            message: redirected
              ? 'Die Startseite leitet auf eine nicht-öffentliche Adresse weiter; der Scan wurde abgebrochen.'
              : 'Der Host der Startseite löst auf eine nicht-öffentliche Adresse auf; der Scan wurde abgebrochen.',
          },
        };
      }
      return {
        kind: 'fatal',
        fatal: {
          reason: 'unreachable',
          code: 'start-page-unreachable',
          message: `Die Startseite konnte nicht geladen werden (${code}).`,
        },
      };
    }
    // 429 after the retry is throttling, not a fatal (5.2: SCAN-THROTTLED, code by the other rules) → phaseABody.
    const status = r.visit.navigation.status ?? 0;
    if (status >= 500) {
      return {
        kind: 'fatal',
        fatal: {
          reason: 'unreachable',
          code: 'start-page-5xx',
          message: `Die Startseite antwortet wiederholt mit HTTP ${status}.`,
        },
      };
    }
    if (r.visit.challenge.detected) {
      return {
        kind: 'fatal',
        fatal: {
          reason: 'blocked',
          code: 'start-page-blocked',
          message: `Die Startseite zeigt eine Sperr- oder Prüfseite (${r.visit.challenge.signals.join(', ')}).`,
        },
      };
    }
    return null;
  }

  private async phaseABody(s: Session): Promise<PhaseAOutcome> {
    const { r: start, statuses: startStatuses } = await this.visitStart(s);
    if (this.ctx.signal.aborted) return { kind: 'ok' }; // run() reports the abort
    const fatal = this.startFatal(start);
    if (fatal) {
      if (fatal.kind === 'tls-blocked') {
        // Do not keep a phase record for a site the browser cannot open; the orchestrator skips checks.
        await s.browser.close();
        this.current = null;
        this.session = null;
      }
      return fatal;
    }
    this.startRaw = start.rawFinalUrl;
    const finalHost = new URL(this.startRaw).hostname.toLowerCase();
    this.scope = { finalHost, etld1: registrableDomain(finalHost) };
    s.jar = this.newJar(s.recorder, { etld1: this.scope.etld1, host: finalHost }, s.record);
    await this.afterPage(s, start, 'first-screen');
    this.aVisits.push({ raw: this.startRaw, result: start, source: 'start' });
    const visited = new Set<string>([pageKey(this.ctx.target.url), pageKey(this.startRaw)]);
    this.plan.pages.push({
      url: sanitizeRequestUrl(this.startRaw),
      role: 'start',
      order: 0,
      reasons: start.visit.navigation.redirectChain.length > 0 ? ['start', 'after-redirects'] : ['start'],
      source: 'start',
    });
    if (this.throttleStatus(start) === 429)
      this.markThrottled(s, 'navigation', start.visit.url, startStatuses);
    this.checkThrottleResponses(s, start.visit.url);
    // Throttled start page: no probes, no subpages (no new request to the host); B and C are skipped.
    if (this.throttled) return { kind: 'ok' };

    const origin = new URL(this.startRaw).origin;
    const robots = await this.fetchRobots(origin);
    const scopeArgs = { startRaw: this.startRaw, finalHost, etld1: this.scope.etld1 };
    const selectArgs = {
      links: start.candidates,
      ...scopeArgs,
      maxPages: this.ctx.options.maxPages,
      robots,
      token: TOOL_NAME,
    };
    let sel = selectPages({ ...selectArgs, sitemapLocs: [] });
    if (sel.extras.length < sel.extrasWanted) {
      const locs = await this.fetchSitemapLocs(origin, robots);
      if (locs.length > 0) sel = selectPages({ ...selectArgs, sitemapLocs: locs });
    }

    interface QItem {
      choice: PageChoice;
      docKind?: LegalKind;
      /** Other kinds whose links lead to this very page (a combined legal page, L3): it is fetched once, read per kind. */
      alsoKinds?: LegalKind[];
      foundVia?: DocumentRecord['foundVia'];
      extra?: boolean;
      hop?: boolean;
      /** Links of the page this candidate was chosen from (the next candidate comes from the same pool). */
      pool?: readonly CandidateLink[];
    }
    const queue: QItem[] = [];
    const found: Record<LegalKind, boolean> = { impressum: false, privacy: false };
    /** Candidate links already queued per document kind: a page of the wrong type is followed by the next one. */
    const tried: Record<LegalKind, Set<string>> = { impressum: new Set(), privacy: new Set() };
    let candidateRetries = 0;
    const pending = (k: LegalKind) => queue.some((q) => q.docKind === k || q.alsoKinds?.includes(k));
    const handleLink = (
      lr: LegalLinkResult,
      via: 'link' | 'hop',
      from: string | null,
      pool: readonly CandidateLink[],
    ): void => {
      if (lr.status === 'page' && lr.choice) {
        tried[lr.kind].add(pageKey(lr.choice.raw));
        if (visited.has(pageKey(lr.choice.raw))) return;
        const queued = queue.find((q) => pageKey(q.choice.raw) === pageKey(lr.choice!.raw));
        if (queued) {
          // The same page behind the links of two kinds: it stays one navigation, the other kind is read from it too.
          if (queued.docKind && queued.docKind !== lr.kind && !queued.alsoKinds?.includes(lr.kind)) {
            queued.alsoKinds = [...(queued.alsoKinds ?? []), lr.kind];
          }
          return;
        }
        const choice: PageChoice =
          via === 'hop'
            ? { ...lr.choice, source: 'hop', reasons: [...lr.choice.reasons, `via:${from}`] }
            : lr.choice;
        const item: QItem = { choice, docKind: lr.kind, foundVia: via, pool };
        if (via === 'hop') queue.unshift(item);
        else queue.push(item);
      } else if (lr.status === 'pdf' && lr.choice) {
        found[lr.kind] = true;
        this.documents.documents.push(
          pdfDocument({
            id: `doc-${lr.kind}-${this.documents.documents.length + 1}`,
            kind: lr.kind,
            phase: 'A',
            url: lr.choice.url,
            foundVia: via,
            status: null,
          }),
        );
        this.documents.attempts.push({
          kind: lr.kind,
          via,
          url: lr.choice.url,
          status: null,
          outcome: 'found',
        });
      } else if ((lr.status === 'unresolved' || lr.status === 'offsite') && lr.link && via === 'link') {
        this.documents.attempts.push({
          kind: lr.kind,
          via,
          url:
            lr.link.hrefKind === 'http' || lr.link.hrefKind === 'https'
              ? sanitizeRequestUrl(lr.link.raw)
              : sanitizeRequestUrl(this.startRaw),
          status: null,
          outcome: 'unresolved',
        });
      }
    };
    /**
     * The page behind a legal link is substantive but not of the expected type (`unconfirmed`, G20): the next best link
     * of the same page is tried instead of stopping at the first (G19), within `MAX_CANDIDATE_RETRIES` extra GETs.
     */
    const tryNextCandidate = (item: QItem): void => {
      const kind = item.docKind;
      if (!kind || !item.pool || candidateRetries >= MAX_CANDIDATE_RETRIES) return;
      const rest = item.pool.filter((l) => !tried[kind].has(pageKey(l.raw)));
      const next = findLegalLink(rest, kind, scopeOf());
      if (next.status !== 'page' || !next.choice) return;
      const key = pageKey(next.choice.raw);
      if (visited.has(key)) return;
      const choice: PageChoice = { ...next.choice, reasons: [...next.choice.reasons, 'next-candidate'] };
      const via = item.foundVia === 'hop' ? 'hop' : 'link';
      const queued = queue.findIndex((q) => pageKey(q.choice.raw) === key);
      if (queued >= 0) {
        const q = queue[queued] as QItem;
        if (q.docKind) {
          // Already queued as the candidate of a document: it stays where it is (no extra navigation) and is read for
          // this kind too, like a combined page behind two links. Taking it out would lose that document.
          tried[kind].add(key);
          if (q.docKind !== kind && !q.alsoKinds?.includes(kind))
            q.alsoKinds = [...(q.alsoKinds ?? []), kind];
          return;
        }
        // The page is already queued as a plain page (e.g. a navigation link): it becomes the candidate, next in line.
        queue.splice(queued, 1);
        tried[kind].add(key);
        candidateRetries++;
        queue.unshift({ ...q, choice, docKind: kind, foundVia: via, pool: item.pool });
        return;
      }
      candidateRetries++;
      handleLink({ ...next, choice }, via, item.choice.role, item.pool);
    };
    const scopeOf = () => ({ startRaw: this.startRaw, finalHost, etld1: this.scope.etld1 });
    handleLink(sel.impressum, 'link', null, start.candidates);
    handleLink(sel.privacy, 'link', null, start.candidates);
    if (sel.contact) queue.push({ choice: sel.contact });
    for (const h of sel.hops) queue.push({ choice: h, hop: true });
    for (const e of sel.extras) queue.push({ choice: e, extra: true });

    let order = 1;
    while (queue.length > 0) {
      const item = queue.shift() as QItem;
      if (this.throttled) break;
      if (!this.timeLeft()) {
        this.cutByTime(s.record);
        break;
      }
      if (this.counter.truncated) {
        s.record.status = 'partial';
        s.record.reason = 'request-cap';
        break;
      }
      // --max-pages counts every page of phase A; legal pages and legal hops are visited regardless (D09).
      const budgeted = !item.docKind && !item.hop;
      if (budgeted && s.record.pages.length >= this.ctx.options.maxPages) continue;
      if (visited.has(pageKey(item.choice.raw))) continue;
      visited.add(pageKey(item.choice.raw));
      const r = await this.navigate(s, {
        rawUrl: item.choice.raw,
        role: item.choice.role,
        order,
        phase: 'A',
        firstVisit: false,
      });
      visited.add(pageKey(r.rawFinalUrl));
      this.plan.pages.push({
        url: item.choice.url,
        role: item.choice.role,
        order,
        reasons: item.choice.reasons,
        source: item.choice.source,
        ...(item.choice.robotsAllowed !== undefined ? { robotsAllowed: item.choice.robotsAllowed } : {}),
      });
      order++;
      await this.afterPage(s, r, 'first-screen');
      this.aVisits.push({ raw: item.choice.raw, result: r, source: item.choice.source });
      if (item.docKind) {
        const doc = await this.recordDocument(s, r, item.docKind, item.choice.url, item.foundVia ?? 'link');
        if (doc === 'found') found[item.docKind] = true;
        else if (doc === 'unconfirmed') tryNextCandidate(item);
        for (const kind of item.alsoKinds ?? []) {
          const also = await this.recordDocument(s, r, kind, item.choice.url, item.foundVia ?? 'link');
          if (also === 'found') found[kind] = true;
          else if (also === 'unconfirmed') tryNextCandidate({ ...item, docKind: kind });
        }
      }
      if (item.choice.role === 'contact' || item.hop) {
        for (const kind of LEGAL_KINDS) {
          if (found[kind] || pending(kind)) continue;
          const lr = findLegalLink(r.candidates, kind, scopeOf());
          if (lr.status === 'page' || lr.status === 'pdf')
            handleLink(lr, 'hop', item.choice.role, r.candidates);
          else
            this.documents.attempts.push({
              kind,
              via: 'hop',
              url: r.visit.url,
              status: r.visit.navigation.status,
              outcome: 'not-found',
            });
        }
      }
    }

    for (const kind of LEGAL_KINDS) {
      if (found[kind] || this.throttled) continue;
      if (!this.timeLeft()) {
        // A fallback probe that was not made leaves phase A unfinished, like a cut queue (R09, G22).
        if (s.record.status === 'completed') this.cutByTime(s.record);
        break;
      }
      const raw = new URL(FALLBACK_PATHS[kind], origin).toString();
      if (visited.has(pageKey(raw))) continue;
      visited.add(pageKey(raw));
      const r = await this.navigate(s, {
        rawUrl: raw,
        role: 'fallback',
        order,
        phase: 'A',
        firstVisit: false,
      });
      this.plan.pages.push({
        url: sanitizeRequestUrl(raw),
        role: 'fallback',
        order,
        reasons: [`fallback:${FALLBACK_PATHS[kind]}`],
        source: 'fallback',
      });
      order++;
      await this.afterPage(s, r, 'first-screen');
      this.aVisits.push({ raw, result: r, source: 'fallback' });
      await this.recordDocument(s, r, kind, sanitizeRequestUrl(raw), 'fallback');
    }

    this.control = chooseControlPages(
      this.aVisits
        .filter((v) => v.source !== 'start' && v.source !== 'fallback' && v.result.visit.evaluable)
        .map((v) => ({
          raw: v.raw,
          url: v.result.visit.url,
          role: v.result.visit.role,
          order: v.result.visit.order,
          signals: this.signalsOf(v, s),
        })),
    );
    this.plan.controlPages = this.control.map((c, i) => ({
      url: c.url,
      role: c.role,
      order: i + 1,
      reasons: c.reasons,
      source: this.aVisits.find((v) => v.raw === c.raw)?.source ?? 'link',
    }));
    return { kind: 'ok' };
  }

  /**
   * Extract a legal document from the current page and record the attempt. `found`: a document of the expected type;
   * `unconfirmed`: a substantive page whose type could not be confirmed (its own outcome, neither found nor soft-404:
   * the caller may try the next candidate, LEGAL-01 reports a limitation, G20); `no`: nothing usable.
   */
  private async recordDocument(
    s: Session,
    r: VisitResult,
    kind: LegalKind,
    url: SanitizedUrl,
    via: DocumentRecord['foundVia'],
  ): Promise<'found' | 'unconfirmed' | 'no'> {
    const attemptVia = via === 'config' ? 'link' : via;
    const status = r.visit.navigation.status;
    if (r.error) {
      const code = navigationErrorCode(r.error);
      if (code === 'download') {
        this.documents.documents.push(
          pdfDocument({
            id: `doc-${kind}-${this.documents.documents.length + 1}`,
            kind,
            phase: 'A',
            url,
            foundVia: via,
            status: null,
          }),
        );
        this.documents.attempts.push({ kind, via: attemptVia, url, status: null, outcome: 'found' });
        return 'found';
      }
      this.documents.attempts.push({ kind, via: attemptVia, url, status: null, outcome: 'error' });
      return 'no';
    }
    if (status !== null && status >= 400) {
      // 429/503: the server refused to answer now — that proves nothing about the document (no false links-broken).
      const outcome = THROTTLE_STATUSES.has(status) ? 'error' : 'not-found';
      this.documents.attempts.push({ kind, via: attemptVia, url, status, outcome });
      return 'no';
    }
    let doc: DocumentRecord;
    try {
      // A page that does not answer must not hold the phase: the read is bounded like every other in-page call (G49).
      doc = await withTimeout(
        extractDocument(s.page, {
          id: `doc-${kind}-${this.documents.documents.length + 1}`,
          kind,
          phase: 'A',
          url,
          foundVia: via,
          status,
          contentType: r.contentType,
        }),
        this.deps.timing.cmpCallTimeoutMs,
        'document extraction',
      );
    } catch (err) {
      s.record.errors.push({
        code: 'document-extract-failed',
        message: errorText(err).slice(0, 300),
        phase: 'A',
        url,
      });
      this.documents.attempts.push({ kind, via: attemptVia, url, status, outcome: 'error' });
      return 'no';
    }
    // `keyword-missing` is the former spelling of "substantive page, no marker of the expected type".
    const soft404 = doc.errors.includes('soft-404');
    const unconfirmed =
      !soft404 && (doc.errors.includes('unconfirmed') || doc.errors.includes('keyword-missing'));
    // A fallback hit that is not the document (e.g. a CMS 200 page) is not recorded as a document.
    if (!((soft404 || unconfirmed) && via === 'fallback')) this.documents.documents.push(doc);
    this.documents.attempts.push({
      kind,
      via: attemptVia,
      url,
      status,
      outcome: soft404 ? 'soft-404' : unconfirmed ? 'unconfirmed' : 'found',
    });
    return soft404 ? 'no' : unconfirmed ? 'unconfirmed' : 'found';
  }

  private signalsOf(v: AVisit, s: Session) {
    const etld1 = this.scope.etld1;
    const thirdParty = (url: string | null) => {
      if (!url) return false;
      try {
        return registrableDomain(new URL(url).hostname) !== etld1;
      } catch {
        return false;
      }
    };
    const dom = v.result.visit.dom;
    const startUrl = sanitizeRequestUrl(this.startRaw);
    const hostsOn = (pageUrl: string) =>
      new Set(
        s.recorder.records
          .filter((r) => r.pageUrl === pageUrl && registrableDomain(r.host) !== etld1)
          .map((r) => r.host),
      );
    const startHosts = hostsOn(startUrl);
    const pageHosts = hostsOn(v.result.visit.finalUrl);
    return {
      thirdPartyIframes: (dom?.iframes ?? []).filter((f) => f.depth === 1 && thirdParty(f.src)).length,
      placeholders: dom?.embedPlaceholders?.length ?? 0,
      newThirdPartyHosts: [...pageHosts].filter((h) => !startHosts.has(h)).length,
    };
  }

  // ---------------------------------------------------------------- robots / sitemap (class T probes)

  private async fetchRobots(origin: string): Promise<Robots | null> {
    const url = `${origin}/robots.txt`;
    this.probes.push({ kind: 'http', class: 'T', target: url, purpose: 'robots.txt' });
    const res = await fetchText(url, this.ctx.network, this.ctx.userAgent.http, {
      timeoutMs: 8_000,
      maxBytes: 256 * 1024,
      signal: this.ctx.signal,
    });
    if (!res || res.status >= 400 || /html/i.test(res.contentType)) return res ? parseRobots('') : null;
    return parseRobots(res.text);
  }

  private async fetchSitemapLocs(origin: string, robots: Robots | null): Promise<string[]> {
    const first = robots?.sitemaps.find((u) => u.startsWith(origin)) ?? `${origin}/sitemap.xml`;
    const get = async (url: string) => {
      this.probes.push({ kind: 'http', class: 'T', target: sanitizeRequestUrl(url), purpose: 'sitemap' });
      await sleep(500, this.ctx.signal); // ≤ 2 requests per second per host (D09)
      const res = await fetchText(url, this.ctx.network, this.ctx.userAgent.http, {
        timeoutMs: 8_000,
        maxBytes: 512 * 1024,
        signal: this.ctx.signal,
      });
      return res && res.status < 400 ? parseSitemap(res.text) : null;
    };
    const sm = await get(first);
    if (!sm) return [];
    if (sm.kind === 'urlset') return sm.locs.slice(0, 500);
    const child = sm.locs.find((u) => u.startsWith(origin));
    if (!child) return [];
    const sub = await get(child);
    return sub?.kind === 'urlset' ? sub.locs.slice(0, 500) : [];
  }

  // ---------------------------------------------------------------- phases B and C

  /** plan.click target: the D12 decision of `classifyFirstLayer` when available, else the unique actionable button. */
  private async clickTarget(
    s: Session,
    facts: CmpFacts | null,
    kind: 'reject' | 'accept',
    cmpId: string,
    pageUrl: SanitizedUrl,
  ): Promise<ClickPlan['target']> {
    const asTarget = (b: CmpButton): NonNullable<ClickPlan['target']> => ({
      cmpId,
      name: b.name,
      role: b.role,
      ...(b.selector ? { selector: b.selector } : {}),
      kindConfidence: b.kindConfidence,
    });
    if (!facts) return null;
    const decided = await s.cmp.targets(facts, pageUrl);
    if (decided) {
      const b = decided[kind];
      return b ? asTarget(b) : null;
    }
    const buttons = facts.firstLayer.buttons.filter(
      (b) => b.kind === kind && b.layer === 1 && b.actionableAtFirstScreen,
    );
    const b = buttons[0];
    return b && new Set(buttons.map((x) => x.name)).size === 1 ? asTarget(b) : null;
  }

  private phaseB(): Promise<void> {
    return this.consentPhase('B');
  }

  private async phaseC(): Promise<void> {
    if (this.cmpRecognized === false) {
      this.phases.push(this.skippedPhase('C', 'skipped', 'cmp-not-recognized'));
      return;
    }
    await this.consentPhase('C');
  }

  /** The navigation failed because the SSRF guard refused only names that did not resolve (not a private address). */
  private refusedAsUnresolved(r: VisitResult, verdictsBefore: number): boolean {
    if (!r.error || navigationErrorCode(r.error) !== 'ERR_BLOCKED_BY_CLIENT') return false;
    const refused = this.guardVerdicts.slice(verdictsBefore);
    return refused.length > 0 && refused.every((v) => v === 'unresolved');
  }

  /**
   * B: observe ≥ MIN_DWELL before the click, first screen (+ banner screenshot), reject via the adapter, verify,
   * reload and verify again, control pages. C: the same with accept, without reload and screenshot.
   */
  private async consentPhase(phase: 'B' | 'C'): Promise<void> {
    if (this.throttled) {
      this.phases.push(this.skippedPhase(phase, 'skipped', 'throttled'));
      return;
    }
    if (!this.timeLeft()) {
      this.phases.push(
        this.skippedPhase(phase, 'skipped', this.ctx.signal.aborted ? 'timeout' : 'time-budget'),
      );
      return;
    }
    if (this.counter.truncated) {
      // Without request records a consent phase would look clean (CONSENT-05) — do not run it.
      this.phases.push(this.skippedPhase(phase, 'skipped', 'request-cap'));
      return;
    }
    const action = phase === 'B' ? 'reject' : 'accept';
    const s = await this.openPhase(phase);
    try {
      const startSpec: VisitSpec = {
        rawUrl: this.startRaw,
        role: 'start',
        order: 0,
        phase,
        firstVisit: false,
      };
      const verdictsBefore = this.guardVerdicts.length;
      let start = await this.navigate(s, startSpec);
      // The name resolved in phase A but not now (a resolver hiccup that outlasted the guard's retries): the start page
      // is the one page this phase cannot do without, so it gets one more navigation after a pause (G52).
      if (this.refusedAsUnresolved(start, verdictsBefore) && this.timeLeft() && !this.throttled) {
        this.ctx.log.warn(`phase ${phase}: start page refused as unresolved, retrying once`);
        const refused = this.guardVerdicts.slice(verdictsBefore);
        await sleep(this.deps.timing.retryDelayMs, this.ctx.signal);
        s.record.pages.pop();
        start = await this.navigate(s, startSpec);
        // The repeat loaded the document: the refusal stays a fact of the request record and of `guard.blocked`, but
        // no document is missing, so the report must not claim that (R28).
        if (!start.error) this.guardRecovered.push(...refused);
      }
      await this.afterPage(s, start, null);
      if (this.throttled) return;
      if (!start.visit.evaluable) {
        if (this.ctx.signal.aborted) {
          // The navigation failed because the deadline closed the browser: the phase was cut, the site did not fail (R27).
          s.record.status = 'partial';
          s.record.reason = 'timeout';
        } else {
          s.record.status = 'failed';
          s.record.reason = start.visit.notEvaluableReason ?? 'start-page-not-evaluable';
        }
        return;
      }
      const url = start.visit.finalUrl;
      const cmpWaitMs = Math.min(5_000, this.deps.timing.cmpCallTimeoutMs);
      const det = await s.cmp.detect(s.page, url, cmpWaitMs);
      const adapter = det?.adapter ?? null;
      // Some CMPs render the dialog after their API is ready (e.g. Borlabs 3): measure the first screen then.
      if (adapter) await s.cmp.waitForBanner(s.page, adapter, url, cmpWaitMs);
      const first = await s.cmp.extract(s.page, adapter, 'first-screen', url);
      if (first) {
        if (phase === 'B' && this.ctx.options.screenshots) await this.screenshot(s, first, url);
        s.cmpFacts.facts.push(first);
      }
      if (!adapter) {
        if (phase === 'B') this.cmpRecognized = false;
        this.plan.click[phase] = { phase, action, target: null, reason: 'cmp-not-recognized' };
        s.record.status = 'partial';
        s.record.reason = 'cmp-not-recognized';
        return;
      }
      if (phase === 'B') this.cmpRecognized = true;
      const target = await this.clickTarget(s, first, action, adapter.id, url);
      this.plan.click[phase] = {
        phase,
        action,
        target,
        ...(target ? {} : { reason: `no-unambiguous-${action}-at-first-layer` }),
      };
      const clicked = await this.act(s, adapter, action, target, url);
      if (!clicked) return;
      const after = await s.cmp.extract(s.page, adapter, 'after-click', url);
      if (after) s.cmpFacts.facts.push(after);
      const verify1 = await s.cmp.verify(s.page, adapter, action, url);
      if (phase === 'B' && this.timeLeft()) {
        const reload = await this.navigate(s, {
          rawUrl: this.startRaw,
          role: 'start',
          order: 0,
          phase,
          firstVisit: false,
          reload: true,
        });
        s.record.reloaded = true;
        await this.afterPage(s, reload, 'after-reload', adapter);
        const verify2 = reload.error
          ? null
          : await s.cmp.verify(s.page, adapter, action, reload.visit.finalUrl);
        // A reject confirmed only after the reload is verified too (FC-09).
        const verify = combineVerify(verify1, verify2);
        if (verify) s.cmpFacts.verify = verify;
      } else if (verify1) {
        s.cmpFacts.verify = verify1;
      }
      await this.controlPages(s, adapter);
    } finally {
      await this.closePhase(s);
    }
  }

  /**
   * Click via the adapter, then observe with `tRef: click`. Returns false when nothing was clicked (the recorder then
   * stays in navigation mode). The adapter clicks exactly `target`, the `plan.click` decision of core (S-31, D12).
   * The click moment is the first trusted press in the page after the adapter was called (FC-03): the adapter still
   * locates and waits for the button before it presses it.
   */
  private async act(
    s: Session,
    adapter: CmpAdapter,
    action: 'reject' | 'accept',
    target: ClickPlan['target'],
    pageUrl: SanitizedUrl,
  ): Promise<boolean> {
    // Snapshot right before the click so that pre-click cookies are not attributed to the click.
    s.recorder.correlate(await s.jar.snapshot(s.browser.context, s.page, this.moment(s, pageUrl)));
    const armedAt = Date.now();
    const outcome = await s.cmp.act(s.page, adapter, action, target, pageUrl);
    const clicked = outcome?.clicked ?? false;
    const pressedAt = clicked ? await this.pressTime(s.page, armedAt) : null;
    // Without an observed press (e.g. the page navigated away on the click) the adapter call is the bound.
    const clickedAt = pressedAt ?? armedAt;
    s.cmpFacts.click = outcome ?? { action, clicked: false, button: null, error: 'cmp-call-failed' };
    s.record.click = {
      action,
      cmpId: adapter.id,
      name: outcome?.button?.name ?? '',
      clickedAt,
      ...(clicked ? { clickedAtSource: pressedAt !== null ? 'input-event' : 'adapter-call' } : {}),
      pageUrl,
      success: clicked,
      ...(outcome?.error ? { error: outcome.error } : outcome ? {} : { error: 'cmp-call-failed' }),
    };
    if (!clicked) {
      s.record.status = 'partial';
      s.record.reason = `no-${action}-button`;
      return false;
    }
    s.recorder.markClickAt(performance.now() - (Date.now() - clickedAt));
    const actionId = s.recorder.actionId;
    if (actionId) s.record.click.actionId = actionId;
    s.jar.markClick(clickedAt);
    await waitForQuiet(
      s.recorder,
      clickedAt,
      {
        ...this.deps.timing.phases[s.phase],
        quietWindowMs: this.deps.timing.quietWindowMs,
        maxInflight: this.deps.timing.maxInflight,
      },
      this.ctx.signal,
    );
    this.lastNavigationEnd = Date.now();
    await this.flushRecorder(s);
    s.recorder.correlate(await s.jar.snapshot(s.browser.context, s.page, this.moment(s, pageUrl)));
    return true;
  }

  private async controlPages(s: Session, adapter: CmpAdapter): Promise<void> {
    let order = 1;
    for (const c of this.control) {
      if (!this.timeLeft() || this.counter.truncated || this.throttled) break;
      const r = await this.navigate(s, {
        rawUrl: c.raw,
        role: c.role as PageRole,
        order: order++,
        phase: s.phase,
        firstVisit: false,
      });
      await this.afterPage(s, r, 'control-page', adapter);
    }
  }

  /** Epoch ms of the first trusted press at or after `after` in any frame of the page (in-page hook), or null. */
  private async pressTime(page: Page, after: number): Promise<number | null> {
    let best: number | null = null;
    for (const frame of page.frames()) {
      const times = (
        await settleWithin(
          frame.evaluate(inputEventsInPage),
          Math.min(2_000, this.deps.timing.cmpCallTimeoutMs),
          this.ctx.signal,
          [] as number[],
        )
      ).value;
      for (const t of times) if (t >= after && (best === null || t < best)) best = t;
    }
    return best;
  }

  private async screenshot(s: Session, facts: CmpFacts, pageUrl: SanitizedUrl): Promise<void> {
    try {
      const shot = await withTimeout(
        bannerScreenshot(s.page, facts, {
          artifactsDir: this.ctx.artifactsDir,
          artifactsRelDir: this.ctx.artifactsRelDir,
          phase: s.phase,
          pageUrl,
        }),
        this.deps.timing.cmpCallTimeoutMs,
        'banner screenshot',
      );
      if ('record' in shot) {
        this.screenshots.push(shot.record);
        facts.screenshotId = shot.record.id;
      } else if (shot.skipped !== 'no-banner') {
        // D20 limitation: no unique container ≤ 50 % of the viewport → no image.
        s.record.errors.push({
          code: 'screenshot-skipped',
          message: shot.skipped,
          phase: s.phase,
          url: pageUrl,
        });
      }
    } catch (err) {
      s.record.errors.push({
        code: 'screenshot-skipped',
        message: `error: ${errorText(err).slice(0, 200)}`,
        phase: s.phase,
        url: pageUrl,
      });
    }
  }

  // ---------------------------------------------------------------- result

  private linkDocuments(): void {
    const visits = this.phases.flatMap((p) => p.pages);
    for (const doc of this.documents.documents) {
      const key = pageKey(doc.url);
      const from: Array<{ pageUrl: SanitizedUrl; text: string }> = [];
      for (const v of visits) {
        for (const l of v.dom?.links ?? []) {
          if (!l.href || pageKey(l.href) !== key) continue;
          if (from.some((f) => f.pageUrl === v.url && f.text === l.text)) continue;
          from.push({ pageUrl: v.url, text: l.text || l.accessibleName || '' });
        }
      }
      doc.linkedFrom = from.slice(0, 20);
    }
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

  /** One SCAN-BLOCKED diagnostic for all pages the target host blocked (the start page of phase A is fatal instead). */
  private blockedDiagnostic(): DiagnosticInput | null {
    if (this.blockedPages.length === 0) return null;
    const unique = (xs: readonly string[]) => [...new Set(xs)];
    const urls = unique(this.blockedPages.map((b) => b.page));
    return {
      code: 'SCAN-BLOCKED',
      affects: unique(this.blockedPages.flatMap((b) => b.affects)).sort(),
      params: {
        scope: 'subpage',
        count: urls.length,
        page: urls[0] as string,
        pages: urls.slice(0, 5).join(', '),
        phase: unique(this.blockedPages.map((b) => b.phase)).join(','),
        kind: unique(this.blockedPages.map((b) => b.kind)).join(','),
        signals: unique(this.blockedPages.flatMap((b) => b.signals))
          .slice(0, 10)
          .join(', '),
      },
    };
  }

  /**
   * SCAN-PRIVATE-REQUEST-BLOCKED: address classes, and for names that did not resolve the resolver error (G52). Only
   * refusals that left a document unfetched count; those a repeat made good are named in `recovered` when others
   * remain, and give no diagnostic when all were made good (R28).
   */
  private privateBlockedDiagnostic(): DiagnosticInput | null {
    const verdicts = [...this.guardVerdicts];
    for (const v of this.guardRecovered) {
      const i = verdicts.indexOf(v);
      if (i >= 0) verdicts.splice(i, 1);
    }
    const blocked = this.guard.blocked - this.guardRecovered.length;
    if (blocked <= 0) return null;
    const unresolved = verdicts.filter((v) => v === 'unresolved').length;
    const codes = [...new Set(this.lookupErrors.map((e) => e.code))].sort();
    const first = this.lookupErrors[0];
    return {
      code: 'SCAN-PRIVATE-REQUEST-BLOCKED',
      affects: [],
      params: {
        count: blocked,
        addressClass: [...new Set(verdicts)].sort().join(', '),
        unresolved,
        nonPublic: Math.max(0, blocked - unresolved),
        hasLookupCodes: codes.length > 0,
        ...(codes.length > 0 ? { lookupCodes: codes.join(', ') } : {}),
        ...(first ? { lookupFirstAtMs: first.atMs } : {}),
        ...(this.guardRecovered.length > 0 ? { recovered: this.guardRecovered.length } : {}),
      },
    };
  }

  private result(status: 'ok' | 'partial' | 'error'): CollectorResult<BrowserSections> {
    const engine = this.engine as EngineProbe;
    if (this.guard.enabled) this.knownGaps.add('ssrf-guard-subresources-unchecked');
    if (this.guardScope === 'page') this.knownGaps.add('ssrf-guard-popups-unchecked');
    const diagnostics = [
      ...this.diagnostics,
      ...[this.privateBlockedDiagnostic(), this.blockedDiagnostic()].filter((d) => d !== null),
    ];
    const reason = status === 'partial' ? this.partialReason() : undefined;
    this.linkDocuments();
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
