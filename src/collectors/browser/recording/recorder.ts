// Per-phase network recorder: subscribes before the first navigation and builds redacted `RequestRecord`s. Identifier
// values stay in memory only for correlation and are cleared by `dispose()`.
import { isIP } from 'node:net';
import type { BrowserContext, Request, Response } from 'playwright-core';
import type { RequestRecord } from '../../../core/snapshot/browser.ts';
import type { BrowserPhase } from '../../../core/snapshot/common.ts';
import { registrableDomain } from '../../../core/url/url.ts';
import { LONG_LIVED_RESOURCE_TYPES } from '../config.ts';
import { requestMethod } from '../page-values.ts';
import { loadIdentifierRules } from '../rules.ts';
import { truncate } from '../util.ts';
import {
  extractRequestFeatures,
  parseSetCookies,
  REQUEST_FEATURES_VERSION,
  type RequestFeatures,
  type SetCookieAttrs,
  sanitizeRequestUrl,
  splitSetCookieNames,
} from './features.ts';
import type { ActivitySource } from './quiet.ts';

export interface RequestCounter {
  limit: number;
  issued: number;
  truncated: boolean;
}

// One `Set-Cookie` of a response (no value): the setter candidate for the jar cookie with the same name, domain, path
// and partition.
export interface SetCookieOrigin {
  name: string;
  host: string;
  url: string;
  /** `Domain=` (lower case, no leading dot) that `host` may set; absent for a host-only cookie. */
  domain?: string;
  path: string;
  partitioned: boolean;
  /** A `Domain=` the host may not set: the browser ignores the cookie, so this origin only records the attempt. */
  rejected?: true;
  /** Monotonic ms (performance.now). */
  at: number;
  /** Written again after the B/C click. Set on the first origin of the key, so first-writer attribution is unchanged. */
  afterClick?: boolean;
}

export function setCookieKey(
  o: Pick<SetCookieOrigin, 'name' | 'host' | 'domain' | 'path' | 'partitioned' | 'rejected'>,
): string {
  // A rejected attempt must not share the key of a cookie the host really set.
  return `${o.name}|${o.domain ?? o.host}|${o.path}|${o.partitioned ? 'P' : ''}${o.rejected ? '|rejected' : ''}`;
}

function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return isIP(host.replace(/^\[|\]$/g, '')) === 0 && host.endsWith(`.${domain}`);
}

export type CookieDomainVerdict = 'host-only' | 'domain' | 'rejected';

// RFC 6265 5.3 steps 5-6. `host-only`: no attribute, or a public suffix equal to the host (attribute dropped);
// `domain`: the host domain-matches and it is no public suffix; `rejected`: the browser ignores the cookie.
export function cookieDomainVerdict(host: string, domain: string | undefined): CookieDomainVerdict {
  if (!domain) return 'host-only';
  // `registrableDomain` is null for a public suffix, an IP address and a non-host.
  const suffixOrIp = registrableDomain(domain) === null;
  if (domain === host) return suffixOrIp ? 'host-only' : 'domain';
  if (suffixOrIp) return 'rejected';
  return domainMatches(host, domain) ? 'domain' : 'rejected';
}

/** Default path of a cookie without `Path=` (RFC 6265 5.1.4). */
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

/** A rejection is `error` (data not available); only `expired` ends the budget. */
export type Settled<T> = { status: 'ok'; value: T } | { status: 'error' } | { status: 'expired' };

/** Largest delay `setTimeout` accepts (a larger one fires after 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

// Waits for `p` at most `ms` and not beyond `signal`. `p` keeps running, so callers must not change stored facts on
// `expired`. An already settled promise wins over an expired budget.
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

    // `Infinity` would overflow `setTimeout` into a 1 ms timer, so only the signal can end the wait.
    if (Number.isFinite(ms)) timer = setTimeout(onAbort, Math.min(ms, MAX_TIMER_MS));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RecorderOptions {
  /** Budget per response for the header and server-address reads together. Default 5 s. */
  metaTimeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_META_TIMEOUT_MS = 5_000;

/** After expiry the handler no longer changes the stored record. */
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

interface FrameFacts {
  frameId?: string;
  isMainFrame: boolean;
  /** Only for a subframe request with an http(s) document. */
  frameUrl?: string;
}

const BLOCKED_RE = /ERR_BLOCKED_BY_(CLIENT|RESPONSE|CSP|ORB|ADMINISTRATOR)|ERR_BLOCKED_BY/;
const ABORTED_RE = /ERR_ABORTED/;

export type ScanClock = () => number;

/** A clock starting now, for collectors run without the orchestrator. */
export function localScanClock(): ScanClock {
  const origin = performance.now();
  return () => performance.now() - origin;
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function postDataOf(r: Request): string | null {
  try {
    return r.postData();
  } catch {
    return null;
  }
}

/** Third-party request that carries identifier cookies: records their names (sorted), never the values. */
function recordSentIdentifierCookies(rec: RequestRecord, cookieHeader: string): void {
  const names = cookieHeader
    .split(';')
    .map((p) => p.split('=')[0]?.trim() ?? '')
    .filter((n) => n && loadIdentifierRules().cookies.some((re) => re.test(n)));
  if (names.length === 0) return;

  const sent = [...new Set(names)].sort();
  rec.sentCookieNames = sent;
  rec.identifierPresent = true;
  rec.identifierNames = [...new Set([...(rec.identifierNames ?? []), ...sent])].sort();
}

export class NetworkRecorder implements ActivitySource {
  readonly records: RequestRecord[] = [];
  dropped = 0;
  readonly setCookieOrigins = new Map<string, SetCookieOrigin>();
  /** Abandoned by a flush that gave up and by `dispose()`. */
  private readonly budgets = new Set<MetaBudget>();
  private readonly entries = new Map<Request, Entry>();
  // Only for the quiet decision. Requests of an earlier page or document are dropped: Chromium does not always report
  // the end of a cancelled request, and it would hold every later page until HARD_CAP.
  private readonly inflightSet = new Set<Request>();
  /** Frame of the first document request; its new documents end the old one's requests. */
  private mainFrame: object | null = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly guardBlocked = new Set<string>();
  /** performance.now start of every record, in memory only, for re-timing at the actual click. */
  private readonly starts = new Map<RequestRecord, number>();
  // Origins written by responses not yet known to be after the click: a late `markClickAt` flags them too. Keys only,
  // no values.
  private readonly originsOfRequest = new Map<RequestRecord, SetCookieOrigin[]>();
  private seq = 0;
  private pageUrl = '';
  private navStart = 0;
  private refAt = performance.now();
  private tRef: 'navigation' | 'click' = 'navigation';
  private afterClick = false;
  /** Set by `markReveal` for the rest of the current navigation. */
  private afterReveal = false;
  private lastStart: number | null = null;
  private navSeq = 0;
  private navId = '';
  private actionSeq = 0;
  private currentAction: string | undefined;
  private frameSeq = 0;
  /** The frame object stays the same across its navigations. */
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

  now(): number {
    return Math.max(0, Math.round(this.clock()));
  }

  get navigationId(): string {
    return this.navId;
  }

  get actionId(): string | undefined {
    return this.currentAction;
  }

  attach(context: BrowserContext): void {
    context.on('request', (r) => this.onRequest(r));
    context.on('response', (r) => this.track(this.onResponse(r)));
    context.on('requestfinished', (r) => this.onDone(r, null));
    context.on('requestfailed', (r) => this.onDone(r, r.failure()?.errorText ?? 'failed'));
  }

  /** A new top-level page (also a reload): request times are relative to it from now on. */
  beginNavigation(pageUrl: string): string {
    this.inflightSet.clear();
    this.pageUrl = pageUrl;
    this.navStart = this.records.length;
    this.refAt = performance.now();
    this.tRef = 'navigation';
    this.afterReveal = false;
    this.navId = `${this.phase}-n${++this.navSeq}`;
    return this.navId;
  }

  // Requests started from now until the next navigation are `afterReveal`: the viewport now shows the content below
  // the first screen. Their timing against the click is unchanged.
  markReveal(): void {
    this.afterReveal = true;
  }

  get isAfterReveal(): boolean {
    return this.afterReveal;
  }

  /** Rebinds the navigation to its final URL (HTTP, JS or meta redirect), the one the other phases use. */
  rebindNavigation(finalUrl: string): void {
    if (finalUrl === this.pageUrl) return;
    for (let i = this.navStart; i < this.records.length; i++) {
      const r = this.records[i] as RequestRecord;
      if (r.pageUrl === this.pageUrl) r.pageUrl = finalUrl;
    }
    this.pageUrl = finalUrl;
  }

  // Requests started at or after `at` (performance.now) are `afterClick` and timed from it, including those recorded
  // while the adapter call was still returning.
  markClickAt(at: number): void {
    const actionId = `${this.phase}-a${++this.actionSeq}`;

    for (const [rec, start] of this.starts) {
      if (start < at) continue;
      rec.afterClick = true;
      rec.tRef = 'click';
      rec.tStartMs = Math.max(0, Math.round(start - at));
      rec.actionId = actionId;
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

  /** Flagged before the failure event arrives. */
  flagGuardBlocked(url: string): void {
    this.guardBlocked.add(url);
  }

  lastRequestStart(): number | null {
    return this.lastStart;
  }

  /** Long-lived request types are excluded. */
  inflight(): number {
    let n = 0;
    for (const r of this.inflightSet) if (this.entries.get(r)?.countsForQuiet !== false) n++;
    return n;
  }

  // Waits for async response handlers. Each is bounded by its own metadata budget; `timeoutMs` / `signal` end the wait
  // earlier and abandon the pending ones. Returns whether everything settled.
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

  /** Compares identifier values with stored cookie values, in memory only; sets `matchesStoredIdentifier`. */
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
    // A new document replaces the old one together with its requests.
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
    const features = extractRequestFeatures(raw, postDataOf(r));
    const record = this.buildRecord(r, raw, features);

    this.records.push(record);
    this.starts.set(record, performance.now());
    this.entries.set(r, { record, identifierValues: features.identifierValues, countsForQuiet });
  }

  private buildRecord(r: Request, raw: string, features: RequestFeatures): RequestRecord {
    const sw = r.serviceWorker();
    const { frameId, isMainFrame, frameUrl } = sw ? { isMainFrame: false } : this.frameFacts(r, raw);
    const redirectedFrom = r.redirectedFrom();
    const parentRequestId = redirectedFrom ? this.entries.get(redirectedFrom)?.record?.id : undefined;

    return {
      id: `${this.phase}-${String(++this.seq).padStart(4, '0')}`,
      phase: this.phase,
      pageUrl: this.pageUrl,
      ...(frameUrl ? { frameUrl } : {}),
      isNavigation: r.isNavigationRequest(),
      isMainFrame,
      url: sanitizeRequestUrl(raw),
      host: hostnameOf(raw),
      // `fetch` takes any token as a method from the page's script.
      method: requestMethod(r.method()),
      resourceType: r.resourceType(),
      tStartMs: this.relative(),
      tRef: this.tRef,
      atMs: this.now(),
      ...(this.navId ? { navigationId: this.navId } : {}),
      ...(this.currentAction ? { actionId: this.currentAction } : {}),
      ...(frameId ? { frameId } : {}),
      ...(parentRequestId ? { parentRequestId } : {}),
      afterClick: this.afterClick,
      ...(this.afterReveal ? { afterReveal: true as const } : {}),
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
  }

  /** Frame ids of a request that has a frame; whatever is known when the frame is already detached. */
  private frameFacts(r: Request, raw: string): FrameFacts {
    const facts: FrameFacts = { isMainFrame: false };
    try {
      const frame = r.frame();
      facts.frameId = this.frameIdOf(frame);
      facts.isMainFrame = frame.parentFrame() === null;
      if (!facts.isMainFrame) {
        // A subframe's own navigation: the frame is the requested document.
        const frameUrl = r.isNavigationRequest() ? raw : frame.url();
        if (/^https?:/.test(frameUrl)) facts.frameUrl = sanitizeRequestUrl(frameUrl);
      }
    } catch {
      // frame detached
    }
    return facts;
  }

  /** A redirect hop, a subframe document and a popup document are not a new main-frame document. */
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
    const rec = this.entries.get(req)?.record;
    if (!rec) return;

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
      if (headers.status === 'ok') this.recordSetCookies(rec, req.url(), headers.value);

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
        if (all.status === 'ok') recordSentIdentifierCookies(rec, all.value.cookie ?? '');
      }
    } finally {
      this.budgets.delete(budget);
    }
  }

  /** Names and setter origins of the `Set-Cookie` headers of a response; the values are dropped by the parser. */
  private recordSetCookies(
    rec: RequestRecord,
    requestUrl: string,
    headers: readonly { name: string; value: string }[],
  ): void {
    const lines = headers.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    const names = splitSetCookieNames(lines);
    if (names.length === 0) return;

    rec.setCookieNames = names;
    const defaultPath = defaultCookiePath(requestUrl);
    for (const c of parseSetCookies(lines)) this.recordSetCookieOrigin(rec, c, defaultPath);
  }

  private recordSetCookieOrigin(rec: RequestRecord, c: SetCookieAttrs, defaultPath: string): void {
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

    // A late `markClickAt` re-times this request and must flag the origin too.
    if (!rec.afterClick) {
      const written = this.originsOfRequest.get(rec);
      if (written) written.push(stored);
      else this.originsOfRequest.set(rec, [stored]);
    }
  }

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
      // The response arrived and only reading the body failed: delivery and result stay, the error goes into
      // `failureText` and the legacy `state`.
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
