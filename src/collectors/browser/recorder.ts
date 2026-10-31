/**
 * Network recorder for one phase: subscribes to context events BEFORE the first navigation, builds redacted
 * `RequestRecord`s (D05, D20, 5.3), tracks activity for the quiet algorithm and keeps identifier values in memory
 * only for the stored-identifier correlation (cleared with `dispose()`).
 */
import { isIP } from 'node:net';
import type { BrowserContext, Request, Response } from 'playwright-core';
import type { BrowserPhase } from '../../core/snapshot-common.ts';
import { registrableDomain } from '../../core/url.ts';
import { IDENTIFIER_COOKIES, LONG_LIVED_RESOURCE_TYPES } from './config.ts';
import {
  extractRequestFeatures,
  parseSetCookies,
  REQUEST_FEATURES_VERSION,
  sanitizeRequestUrl,
  splitSetCookieNames,
} from './features.ts';
import type { ActivitySource } from './quiet.ts';
import type { RequestRecord } from './types.ts';
import { truncate } from './util.ts';

export interface RequestCounter {
  limit: number;
  issued: number;
  truncated: boolean;
}

/**
 * A response that sent `Set-Cookie` for one cookie (name, domain, path, partition; no value). Domain, path and
 * partition decide which jar cookie it can be: a response of another registrable domain cannot set a cookie of this
 * one (G34). A `Domain=` the response host may not set (RFC 6265 5.3) is not kept: the origin is `rejected`.
 */
export interface SetCookieOrigin {
  name: string;
  /** Host of the response (the setter). */
  host: string;
  url: string;
  /**
   * `Domain=` attribute (lower case, no leading dot) that `host` may set; absent → host-only cookie of `host` (also a
   * `Domain=` that is a public suffix equal to `host`, and every `rejected` origin).
   */
  domain?: string;
  /** `Path=` attribute, or the default path of the request URL (RFC 6265 5.1.4). */
  path: string;
  /** `Partitioned` attribute. */
  partitioned: boolean;
  /**
   * The `Domain=` of the response was one `host` may not set: `host` does not domain-match it, or it is a public
   * suffix (S-requests-2). The browser ignores such a cookie entirely, so this origin is no setter of any jar cookie
   * and no write after the click of one; it only stands for the attempt of `host` (`attempted`, domain = `host`).
   */
  rejected?: true;
  /** Monotonic ms (performance.now) when the response arrived. */
  at: number;
  /**
   * A response to a request that started after the B/C click set this same key (R06): the cookie was written
   * again after the click. Set on the first origin of the key even when that response came before the click, so the
   * setter attribution (first writer) stays unchanged.
   */
  afterClick?: boolean;
}

/** Key of a `Set-Cookie` origin: the same key is the same cookie in the jar. */
export function setCookieKey(
  o: Pick<SetCookieOrigin, 'name' | 'host' | 'domain' | 'path' | 'partitioned' | 'rejected'>,
): string {
  // A rejected attempt never shares the key of a cookie the host really set (it must not swallow it).
  return `${o.name}|${o.domain ?? o.host}|${o.path}|${o.partitioned ? 'P' : ''}${o.rejected ? '|rejected' : ''}`;
}

/** RFC 6265 5.1.3: the host domain-matches the domain if equal, or if it ends with `.domain` and is no IP address. */
function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return isIP(host.replace(/^\[|\]$/g, '')) === 0 && host.endsWith(`.${domain}`);
}

/** What a `Domain=` attribute means for a `Set-Cookie` of the response host (RFC 6265 5.3 steps 5 and 6). */
export type CookieDomainVerdict = 'host-only' | 'domain' | 'rejected';

/**
 * `host` sends `Set-Cookie` with `Domain=domain` (lower case, no leading dot; `undefined` = no attribute):
 * - `host-only`: no attribute, or a public suffix identical to the host (the attribute is dropped);
 * - `domain`: the host domain-matches the attribute and it is no public suffix (the browser keeps a domain cookie);
 * - `rejected`: the host does not domain-match it, or it is a public suffix (or an IP address) other than the host:
 *   the browser ignores the cookie entirely.
 */
export function cookieDomainVerdict(host: string, domain: string | undefined): CookieDomainVerdict {
  if (!domain) return 'host-only';
  // `registrableDomain` is null for a public suffix (private suffixes included), an IP address and a non-host.
  const suffixOrIp = registrableDomain(domain) === null;
  if (domain === host) return suffixOrIp ? 'host-only' : 'domain';
  if (suffixOrIp) return 'rejected';
  return domainMatches(host, domain) ? 'domain' : 'rejected';
}

/** Default path of a cookie without `Path=` (RFC 6265 5.1.4) from the request URL. */
function defaultCookiePath(rawUrl: string): string {
  let path = '/';
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return '/';
  }
  if (!path.startsWith('/')) return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}

/** Outcome of a bounded wait. A rejection is `error` (data not available); only `expired` ends the budget. */
export type Settled<T> = { status: 'ok'; value: T } | { status: 'error' } | { status: 'expired' };

/** Largest delay `setTimeout` accepts (a larger one fires after 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Wait for `p` at most `ms` and not beyond `signal`. The promise itself keeps running (callers must not change
 * stored facts when they get `expired`). A promise that is already settled still wins over an expired budget.
 */
export function settleWithin<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: Settled<T>) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => done({ status: 'expired' });
    p.then(
      (value) => done({ status: 'ok', value }),
      () => done({ status: 'error' }),
    );
    if (signal?.aborted || ms <= 0) {
      // Settled promises resolve in the microtask queue first.
      queueMicrotask(() => queueMicrotask(onAbort));
      return;
    }
    // No limit (`Infinity`): setTimeout would turn it into a 1 ms timer (overflow), so only the signal can end the wait.
    if (Number.isFinite(ms)) timer = setTimeout(onAbort, Math.min(ms, MAX_TIMER_MS));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Options of the recorder that bound waits on response metadata (G49). */
export interface RecorderOptions {
  /** Budget per response for `headersArray()`, `serverAddr()` and `allHeaders()` together. Default 5 s. */
  metaTimeoutMs?: number;
  /** Scan abort: pending metadata reads are abandoned at once. */
  signal?: AbortSignal;
}

const DEFAULT_META_TIMEOUT_MS = 5_000;

/** Metadata budget of one response; once expired the handler leaves the stored record as it is. */
class MetaBudget {
  expired = false;
  readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }
}

interface Entry {
  /** null when the request cap was exceeded (counted, not recorded). */
  record: RequestRecord | null;
  identifierValues: string[];
  countsForQuiet: boolean;
}

const BLOCKED_RE = /ERR_BLOCKED_BY_(CLIENT|RESPONSE|CSP|ORB|ADMINISTRATOR)|ERR_BLOCKED_BY/;
const ABORTED_RE = /ERR_ABORTED/;

/** Milliseconds since the scan start on a monotonic clock (5.3 `tMs`). */
export type ScanClock = () => number;

/** A clock starting now: for collectors run without the orchestrator (tests). */
export function localScanClock(): ScanClock {
  const origin = performance.now();
  return () => performance.now() - origin;
}

export class NetworkRecorder implements ActivitySource {
  readonly records: RequestRecord[] = [];
  /** Requests of this phase not recorded because the shared cap was exceeded. */
  dropped = 0;
  /** `Set-Cookie` key (name, domain, path, partition) → first response that set it (`setter: http-response`). */
  readonly setCookieOrigins = new Map<string, SetCookieOrigin>();
  /** Open metadata budgets: abandoned (expired) by a flush that gave up and by `dispose()`. */
  private readonly budgets = new Set<MetaBudget>();
  private readonly entries = new Map<Request, Entry>();
  /**
   * Open requests of the current navigation and document, for the quiet decision only (`inflight()`). Requests of an
   * earlier page or document are dropped from it: Chromium does not always report the end of a request that the
   * navigation cancelled, and such a request would keep every later page of the phase waiting for its HARD_CAP. Their
   * records stay as observed.
   */
  private readonly inflightSet = new Set<Request>();
  /** Main frame of the page: the frame of its first document request. Its new documents end the old one's requests. */
  private mainFrame: object | null = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly guardBlocked = new Set<string>();
  /** Monotonic start (performance.now) of every record, in memory only: re-timing at the actual click (FC-03). */
  private readonly starts = new Map<RequestRecord, number>();
  /**
   * `Set-Cookie` origins written by the response of a request that was not yet known to be after the click when the
   * response was handled: the late `markClickAt` flags them too (S-requests-1). Keys only, no values.
   */
  private readonly originsOfRequest = new Map<RequestRecord, SetCookieOrigin[]>();
  private seq = 0;
  private pageUrl = '';
  /** Index of the first record of the current navigation. */
  private navStart = 0;
  private refAt = performance.now();
  private tRef: 'navigation' | 'click' = 'navigation';
  private afterClick = false;
  private lastStart: number | null = null;
  private navSeq = 0;
  private navId = '';
  private actionSeq = 0;
  private currentAction: string | undefined;
  private frameSeq = 0;
  /** Playwright frame → `frameId` (5.3); the frame object stays the same across its navigations. */
  private readonly frameIds = new WeakMap<object, string>();

  private readonly phase: BrowserPhase;
  private readonly targetEtld1: string | null;
  private readonly counter: RequestCounter;
  private readonly proxied: boolean;
  private readonly clock: ScanClock;
  private readonly metaTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(
    phase: BrowserPhase,
    targetEtld1: string | null,
    counter: RequestCounter,
    proxied: boolean,
    clock: ScanClock = localScanClock(),
    options: RecorderOptions = {},
  ) {
    this.phase = phase;
    this.targetEtld1 = targetEtld1;
    this.counter = counter;
    this.proxied = proxied;
    this.clock = clock;
    this.metaTimeoutMs = options.metaTimeoutMs ?? DEFAULT_META_TIMEOUT_MS;
    this.signal = options.signal;
  }

  /** Current position on the scan clock (ms since the scan start, 5.3 `tMs`). */
  now(): number {
    return Math.max(0, Math.round(this.clock()));
  }

  /** `navigationId` of the current top-level navigation (empty before the first one). */
  get navigationId(): string {
    return this.navId;
  }

  /** `actionId` of the B/C click once it happened (5.3 `actionId?`). */
  get actionId(): string | undefined {
    return this.currentAction;
  }

  attach(context: BrowserContext): void {
    context.on('request', (r) => this.onRequest(r));
    context.on('response', (r) => this.track(this.onResponse(r)));
    context.on('requestfinished', (r) => this.onDone(r, null));
    context.on('requestfailed', (r) => this.onDone(r, r.failure()?.errorText ?? 'failed'));
  }

  /**
   * A new top-level page (also the reload): request times are relative to this navigation from now on. Returns the
   * new `navigationId` (5.3).
   */
  beginNavigation(pageUrl: string): string {
    this.inflightSet.clear();
    this.pageUrl = pageUrl;
    this.navStart = this.records.length;
    this.refAt = performance.now();
    this.tRef = 'navigation';
    this.navId = `${this.phase}-n${++this.navSeq}`;
    return this.navId;
  }

  /**
   * The navigation ended on `finalUrl` (HTTP redirect, JS/meta redirect): its requests belong to the page as shown,
   * the same URL the plan, the CMP facts and the other phases use for it (FC-02).
   */
  rebindNavigation(finalUrl: string): void {
    if (finalUrl === this.pageUrl) return;
    for (let i = this.navStart; i < this.records.length; i++) {
      const r = this.records[i] as RequestRecord;
      if (r.pageUrl === this.pageUrl) r.pageUrl = finalUrl;
    }
    this.pageUrl = finalUrl;
  }

  /**
   * The B/C click happened at `at` (performance.now domain): requests started at or after it are `afterClick` and
   * timed from it — also those recorded while the adapter call was still returning; earlier ones keep their
   * navigation timing (FC-03). Only called for a click that really happened.
   */
  markClickAt(at: number): void {
    const actionId = `${this.phase}-a${++this.actionSeq}`;
    for (const [rec, start] of this.starts) {
      if (start < at) continue;
      rec.afterClick = true;
      rec.tRef = 'click';
      rec.tStartMs = Math.max(0, Math.round(start - at));
      rec.actionId = actionId;
      // The cookies this request's response wrote count as written after the click as well (R06, S-requests-1).
      for (const o of this.originsOfRequest.get(rec) ?? []) o.afterClick = true;
      this.originsOfRequest.delete(rec);
    }
    this.currentAction = actionId;
    this.afterClick = true;
    this.tRef = 'click';
    this.refAt = at;
  }

  get isAfterClick(): boolean {
    return this.afterClick;
  }

  get reference(): { tRef: 'navigation' | 'click'; at: number } {
    return { tRef: this.tRef, at: this.refAt };
  }

  /** URL of a document request failed by the SSRF guard (flagged before the failure event arrives). */
  flagGuardBlocked(url: string): void {
    this.guardBlocked.add(url);
  }

  lastRequestStart(): number | null {
    return this.lastStart;
  }

  /** Requests of the current navigation and document that are still open (long-lived types excluded). */
  inflight(): number {
    let n = 0;
    for (const r of this.inflightSet) if (this.entries.get(r)?.countsForQuiet !== false) n++;
    return n;
  }

  /**
   * Wait for async response handlers (headers, server address) to settle. Every handler is bounded by its own
   * metadata budget, so the wait always ends; `timeoutMs` / `signal` end it earlier. When it gives up, the handlers
   * still pending are abandoned: they no longer change the records. Returns whether everything settled.
   */
  async flush(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const until = opts.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.timeoutMs;
    const signal = opts.signal ?? this.signal;
    while (this.pending.size > 0) {
      const r = await settleWithin(Promise.allSettled([...this.pending]), until - Date.now(), signal);
      if (r.status === 'expired') {
        for (const b of this.budgets) b.expired = true;
        return false;
      }
    }
    return true;
  }

  /**
   * Compare identifier values of this phase's requests with stored values (cookie values), in memory only.
   * Sets `matchesStoredIdentifier` on records that carried an identifier.
   */
  correlate(storedValues: readonly string[]): void {
    const stored = storedValues.flatMap((v) => {
      try {
        const d = decodeURIComponent(v);
        return d === v ? [v] : [v, d];
      } catch {
        return [v];
      }
    });
    for (const e of this.entries.values()) {
      if (!e.record || e.identifierValues.length === 0 || e.record.matchesStoredIdentifier) continue;
      e.record.matchesStoredIdentifier = e.identifierValues.some(
        (v) => v.length >= 4 && stored.some((s) => s.includes(v)),
      );
    }
  }

  /** Drop in-memory identifier values (end of phase). */
  dispose(): void {
    for (const e of this.entries.values()) e.identifierValues = [];
    this.starts.clear();
    this.originsOfRequest.clear();
    for (const b of this.budgets) b.expired = true;
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
  }

  private relative(): number {
    return Math.max(0, Math.round(performance.now() - this.refAt));
  }

  private thirdParty(host: string): boolean {
    const etld1 = registrableDomain(host);
    return this.targetEtld1 === null ? true : etld1 !== this.targetEtld1;
  }

  private onRequest(r: Request): void {
    this.counter.issued++;
    const countsForQuiet = !LONG_LIVED_RESOURCE_TYPES.has(r.resourceType());
    // A new document of the page (JS or meta redirect, reload) replaces the old one with its requests.
    if (this.startsMainDocument(r)) this.inflightSet.clear();
    this.inflightSet.add(r);
    if (countsForQuiet) this.lastStart = Date.now();
    if (this.counter.issued > this.counter.limit) {
      this.counter.truncated = true;
      this.dropped++;
      this.entries.set(r, { record: null, identifierValues: [], countsForQuiet });
      return;
    }
    const raw = r.url();
    let host = '';
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      host = '';
    }
    let postData: string | null = null;
    try {
      postData = r.postData();
    } catch {
      postData = null;
    }
    const features = extractRequestFeatures(raw, postData);
    let isMainFrame = false;
    let frameUrl: string | undefined;
    let frameId: string | undefined;
    const sw = r.serviceWorker();
    if (!sw) {
      try {
        const frame = r.frame();
        frameId = this.frameIdOf(frame);
        isMainFrame = frame.parentFrame() === null;
        if (!isMainFrame) {
          // A subframe's own navigation: the frame is (becoming) the requested document.
          const fu = r.isNavigationRequest() ? raw : frame.url();
          if (/^https?:/.test(fu)) frameUrl = sanitizeRequestUrl(fu);
        }
      } catch {
        // frame detached
      }
    }
    const redirectedFrom = r.redirectedFrom();
    const parentRequestId = redirectedFrom ? this.entries.get(redirectedFrom)?.record?.id : undefined;
    const record: RequestRecord = {
      id: `${this.phase}-${String(++this.seq).padStart(4, '0')}`,
      phase: this.phase,
      pageUrl: this.pageUrl,
      ...(frameUrl ? { frameUrl } : {}),
      isNavigation: r.isNavigationRequest(),
      isMainFrame,
      url: sanitizeRequestUrl(raw),
      host,
      method: r.method(),
      resourceType: r.resourceType(),
      tStartMs: this.relative(),
      tRef: this.tRef,
      atMs: this.now(),
      ...(this.navId ? { navigationId: this.navId } : {}),
      ...(this.currentAction ? { actionId: this.currentAction } : {}),
      ...(frameId ? { frameId } : {}),
      ...(parentRequestId ? { parentRequestId } : {}),
      afterClick: this.afterClick,
      state: 'attempted',
      delivery: 'attempted',
      result: { kind: 'none' },
      identifierPresent: features.identifierNames.length > 0,
      ...(features.identifierNames.length > 0 ? { identifierNames: features.identifierNames } : {}),
      ...(features.eventType !== undefined ? { eventType: features.eventType } : {}),
      ...(features.consentSignals ? { consentSignals: features.consentSignals } : {}),
      ...(redirectedFrom
        ? { initiator: { type: 'redirect', url: sanitizeRequestUrl(redirectedFrom.url()) } }
        : {}),
      ...(sw ? { fromServiceWorker: true } : {}),
      parserVersion: REQUEST_FEATURES_VERSION,
      observationSource: 'playwright',
    };
    this.records.push(record);
    this.starts.set(record, performance.now());
    this.entries.set(r, { record, identifierValues: features.identifierValues, countsForQuiet });
  }

  /**
   * The request loads a new document into the page's main frame. A redirect hop of the same navigation, a subframe
   * document and the document of another page (popup) are not that.
   */
  private startsMainDocument(r: Request): boolean {
    try {
      if (!r.isNavigationRequest() || r.redirectedFrom() || r.serviceWorker()) return false;
      const frame = r.frame();
      if (frame.parentFrame() !== null) return false;
      this.mainFrame ??= frame;
      return frame === this.mainFrame;
    } catch {
      return false; // frame detached
    }
  }

  private async onResponse(resp: Response): Promise<void> {
    const req = resp.request();
    const e = this.entries.get(req);
    if (!e?.record) return;
    const rec = e.record;
    rec.status = resp.status();
    rec.delivery = 'sent';
    rec.result = { kind: 'response', status: resp.status() };
    if (resp.fromServiceWorker()) {
      rec.state = 'from-sw';
      rec.provenance = 'service-worker';
    } else {
      rec.state = 'completed';
    }
    const budget = new MetaBudget(this.metaTimeoutMs);
    this.budgets.add(budget);
    try {
      const within = <T>(p: Promise<T>) => this.within(p, budget);
      const headers = await within(resp.headersArray());
      if (budget.expired) return;
      if (headers.status === 'ok') {
        const lines = headers.value.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
        const names = splitSetCookieNames(lines);
        if (names.length > 0) {
          rec.setCookieNames = names;
          const defaultPath = defaultCookiePath(req.url());
          for (const c of parseSetCookies(lines)) {
            const verdict = cookieDomainVerdict(rec.host, c.domain);
            const origin: SetCookieOrigin = {
              name: c.name,
              host: rec.host,
              url: rec.url,
              ...(c.domain && verdict === 'domain' ? { domain: c.domain } : {}),
              path: c.path ?? defaultPath,
              partitioned: c.partitioned,
              at: performance.now(),
              ...(verdict === 'rejected' ? { rejected: true as const } : {}),
            };
            const key = setCookieKey(origin);
            let stored = this.setCookieOrigins.get(key);
            if (!stored) {
              stored = rec.afterClick ? { ...origin, afterClick: true } : origin;
              this.setCookieOrigins.set(key, stored);
            } else if (rec.afterClick) stored.afterClick = true;
            // Not yet after the click: a `markClickAt` that arrives late (the press was before the adapter returned)
            // re-times this request and must flag the origin as well.
            if (!rec.afterClick) {
              const written = this.originsOfRequest.get(rec);
              if (written) written.push(stored);
              else this.originsOfRequest.set(rec, [stored]);
            }
          }
        }
      }
      const addr = await within(resp.serverAddr());
      if (budget.expired) return;
      if (addr.status === 'ok' && addr.value?.ipAddress) {
        rec.connectedIp = {
          value: addr.value.ipAddress,
          origin: this.proxied ? 'upstream' : 'resolvedLocally',
        };
        if (!resp.fromServiceWorker()) rec.provenance = 'network';
      }
      if (this.thirdParty(rec.host)) {
        const all = await within(req.allHeaders());
        if (budget.expired) return;
        if (all.status === 'ok') {
          const cookieHeader = all.value.cookie ?? '';
          const sent = cookieHeader
            .split(';')
            .map((p) => p.split('=')[0]?.trim() ?? '')
            .filter((n) => n && IDENTIFIER_COOKIES.some((re) => re.test(n)));
          if (sent.length > 0) {
            rec.sentCookieNames = [...new Set(sent)].sort();
            rec.identifierPresent = true;
            rec.identifierNames = [...new Set([...(rec.identifierNames ?? []), ...sent])].sort();
          }
        }
      }
    } finally {
      this.budgets.delete(budget);
    }
  }

  /** Bounded wait on a response metadata read: the budget of the response and the scan signal. */
  private async within<T>(p: Promise<T>, budget: MetaBudget): Promise<Settled<T>> {
    const r = await settleWithin(p, budget.remaining(), this.signal);
    if (r.status === 'expired') budget.expired = true;
    return r;
  }

  private onDone(r: Request, failure: string | null): void {
    this.inflightSet.delete(r);
    const rec = this.entries.get(r)?.record;
    if (!rec) return;
    if (failure === null) {
      if (rec.state === 'attempted') {
        rec.state = 'completed';
        rec.delivery = 'sent';
      }
      return;
    }
    rec.failureText = truncate(failure, 200);
    if (rec.result?.kind === 'response') {
      // The response arrived; only reading the body failed. Delivery and result stay as observed (S-17), the body
      // error is kept in `failureText` and the legacy `state`.
      rec.state = 'failed';
      return;
    }
    if (/ERR_BLOCKED_BY_CLIENT/.test(failure) && this.guardBlocked.has(r.url())) rec.blockedByGuard = true;
    if (BLOCKED_RE.test(failure) || rec.blockedByGuard) {
      rec.state = 'blocked-by-browser';
      rec.delivery = 'blocked-by-browser';
      rec.result = { kind: 'failed', errorText: rec.failureText };
    } else if (ABORTED_RE.test(failure)) {
      rec.state = 'failed';
      rec.result = { kind: 'aborted' };
    } else {
      rec.state = 'failed';
      rec.result = { kind: 'failed', errorText: rec.failureText };
    }
  }

  private frameIdOf(frame: object): string {
    let id = this.frameIds.get(frame);
    if (!id) {
      id = `${this.phase}-f${++this.frameSeq}`;
      this.frameIds.set(frame, id);
    }
    return id;
  }
}
