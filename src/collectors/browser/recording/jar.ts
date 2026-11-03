// Cookies and Web Storage per phase (names, flags and lengths; values only in memory for identifier correlation). A key
// seen before the B/C click gets a second `afterClick` record when a write event follows the click. A setter is never
// attributed by name alone: a `Set-Cookie` must match name, domain, path and partition, a script write must come from a
// document that can set the domain; otherwise the setter is `unknown`. Every in-page read is bounded.
import type { BrowserContext, Cookie, Frame, Page } from 'playwright-core';
import type { CookieRecord, StorageRecord } from '../../../core/snapshot/browser.ts';
import type { BrowserPhase } from '../../../core/snapshot/common.ts';
import { parseUrl, registrableDomain } from '../../../core/url/url.ts';
import {
  cookieWritesInPage,
  type RawStorage,
  storageInPage,
  storageWritesInPage,
} from '../in-page/storage.ts';
import { TimeoutError } from '../util.ts';
import { sanitizeRequestUrl } from './features.ts';
import { type SetCookieOrigin, settleWithin } from './recorder.ts';

export interface Moment {
  phase: BrowserPhase;
  pageUrl: string;
  tMs: number;
  tRef: 'navigation' | 'click';
  afterClick: boolean;
  atMs?: number;
  navigationId?: string;
  actionId?: string;
}

function momentIds(m: Moment): Pick<CookieRecord, 'atMs' | 'navigationId' | 'actionId'> {
  return {
    ...(m.atMs !== undefined ? { atMs: m.atMs } : {}),
    ...(m.navigationId ? { navigationId: m.navigationId } : {}),
    ...(m.actionId ? { actionId: m.actionId } : {}),
  };
}

export interface ScriptWrite {
  name: string;
  script: string | null;
  deletion: boolean;
  host?: string | null;
  domain?: string | null;
}

export interface JarOptions {
  /** Default 1 s: the reads are trivial, a slower frame is wedged (PDF viewer). */
  evalTimeoutMs?: number;
  signal?: AbortSignal;
  onError?: (what: string, err: unknown) => void;
}

const DEFAULT_EVAL_TIMEOUT_MS = 1_000;

type LoggedWrite = ScriptWrite & { t: number };

interface StoredWrite extends ScriptWrite {
  m: Moment;
  documentHost?: string;
  domainAttr?: string;
}

const normalizeDomain = (d: string | null | undefined): string | undefined => {
  const v = d?.trim().replace(/^\./, '').toLowerCase();
  return v ? v : undefined;
};

/** Iframes created by script use the origin of their creator. */
const INHERITS_ORIGIN = /^about:(?:blank|srcdoc)(?:[#?].*)?$/i;

// A frame without a host of its own (`about:blank`, `about:srcdoc`) takes the nearest http(s) ancestor's host; other
// hostless URLs (`data:`, `blob:`, opaque origin) stay unknown.
function documentHostOf(frame: Frame): string | undefined {
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    const url = f.url();
    const host = normalizeDomain(hostOf(url));
    if (host) return host;
    if (!INHERITS_ORIGIN.test(url)) return undefined;
  }
  return undefined;
}

const writeDomain = (w: StoredWrite): string | undefined => w.domainAttr ?? w.documentHost;

/** A document cannot set cookies for a foreign domain; a write of unknown context cannot be verified. */
function scriptCanSet(w: StoredWrite, domain: string): boolean {
  if (w.domainAttr) return w.domainAttr === domain;
  const host = w.documentHost;
  return host !== undefined && (host === domain || host.endsWith(`.${domain}`));
}

/** Without `Domain=` the response host is the target (also for a `rejected` origin). */
const originDomain = (o: SetCookieOrigin): string => o.domain ?? o.host;

function isFirstParty(domain: string, targetEtld1: string | null, targetHost: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (targetEtld1 === null) return d === targetHost;
  return registrableDomain(d) === targetEtld1;
}

export function mapCookie(
  c: Pick<Cookie, 'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'> & {
    partitionKey?: string;
  },
  m: Moment,
  target: { etld1: string | null; host: string },
  nowSec: number,
  setter: Pick<CookieRecord, 'setter' | 'setterHost' | 'setterUrl'>,
): CookieRecord {
  const domain = c.domain.replace(/^\./, '').toLowerCase();
  const persistent = typeof c.expires === 'number' && c.expires > 0;
  return {
    name: c.name,
    domain,
    firstParty: isFirstParty(domain, target.etld1, target.host),
    path: c.path || '/',
    partitionKey: c.partitionKey ?? null,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite:
      c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None' ? c.sameSite : 'unknown',
    lifetime: persistent
      ? { kind: 'persistent', days: Math.max(0, Math.round(((c.expires - nowSec) / 86_400) * 10) / 10) }
      : { kind: 'session' },
    length: c.value.length,
    ...cleanSetter(setter),
    state: 'accepted',
    phase: m.phase,
    pageUrl: m.pageUrl,
    tMs: m.tMs,
    tRef: m.tRef,
    afterClick: m.afterClick,
    ...momentIds(m),
  };
}

/** One sanitizing point for every setter (no query values of script URLs). */
function cleanSetter(
  s: Pick<CookieRecord, 'setter' | 'setterHost' | 'setterUrl'>,
): Pick<CookieRecord, 'setter' | 'setterHost' | 'setterUrl'> {
  return s.setterUrl ? { ...s, setterUrl: sanitizeRequestUrl(s.setterUrl) } : s;
}

const cookieKey = (r: Pick<CookieRecord, 'name' | 'domain' | 'path' | 'partitionKey' | 'state'>) =>
  `${r.name}|${r.domain}|${r.path}|${r.partitionKey ?? ''}|${r.state}`;

const AFTER = '|after-click';

export class JarTracker {
  readonly cookies: CookieRecord[] = [];
  readonly storage: StorageRecord[] = [];
  private readonly cookieKeys = new Set<string>();
  private readonly storageKeys = new Set<string>();
  /** Cookie name → domains seen in the jar (an `attempted` record needs a missing pair). */
  private readonly jarDomains = new Map<string, Set<string>>();
  /** First script write per `name|cookie domain`, for setter attribution. */
  private readonly scriptWrites = new Map<string, StoredWrite>();
  /** Script writes after the click, with the moment of the snapshot that saw them. */
  private readonly scriptWritesAfterClick = new Map<string, StoredWrite>();
  private readonly storageWriteAt = new Map<string, number>();
  private clickAt: number | null = null;

  private readonly target: { etld1: string | null; host: string };
  private readonly setCookieOrigins: ReadonlyMap<string, SetCookieOrigin>;
  private readonly evalTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onError: ((what: string, err: unknown) => void) | undefined;

  constructor(
    target: { etld1: string | null; host: string },
    setCookieOrigins: ReadonlyMap<string, SetCookieOrigin>,
    options: JarOptions = {},
  ) {
    this.target = target;
    this.setCookieOrigins = setCookieOrigins;
    this.evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this.signal = options.signal;
    this.onError = options.onError;
  }

  markClick(epochMs: number): void {
    this.clickAt = epochMs;
  }

  // Returns cookie VALUES for the in-memory identifier correlation only: the caller must not keep or log them. A frame
  // that does not answer within the budget is skipped.
  async snapshot(context: BrowserContext, page: Page, m: Moment): Promise<string[]> {
    const dead = new Set<Frame>();
    await this.readScriptWrites(page, m, dead);
    const cookies = (await this.bounded(context.cookies(), 'jar.cookies')) ?? ([] as Cookie[]);
    const nowSec = Date.now() / 1000;
    for (const c of cookies) {
      const domainOf = normalizeDomain(c.domain) ?? c.domain;
      const seen = this.jarDomains.get(c.name) ?? new Set<string>();
      seen.add(domainOf);
      this.jarDomains.set(c.name, seen);
      const rec = mapCookie(c, m, this.target, nowSec, this.setterOf(c));
      const key = cookieKey(rec);
      if (!this.cookieKeys.has(key)) {
        this.cookieKeys.add(key);
        this.cookies.push(rec);
      } else if (
        m.afterClick &&
        this.writtenAfterClick(rec.name, rec.domain, rec.path, rec.partitionKey !== null) &&
        !this.cookieKeys.has(key + AFTER)
      ) {
        this.cookieKeys.add(key + AFTER);
        this.cookies.push(rec);
      }
    }
    await this.readStorage(page, m, dead);
    return cookies.map((c) => c.value);
  }

  /** Writes seen that never reached the jar become `attempted`. */
  finalize(defaultMoment: Moment): void {
    for (const [key, w] of this.scriptWrites) {
      if (w.deletion || this.jarHas(w.name, (d) => scriptCanSet(w, d))) continue;
      // Unknown document and no Domain=: cannot be placed on a domain.
      const domain = writeDomain(w);
      if (!domain) continue;
      const where = {
        domain,
        ...(w.script && hostOf(w.script) ? { setterHost: hostOf(w.script) as string } : {}),
        ...(w.script ? { setterUrl: w.script } : {}),
      };
      this.pushAttempted(w.name, 'script', where, w.m);
      const later = this.scriptWritesAfterClick.get(key);
      if (later && !w.m.afterClick) this.pushAttempted(w.name, 'script', where, later.m, AFTER);
    }
    for (const o of this.setCookieOrigins.values()) {
      const domain = originDomain(o);
      if (this.jarHas(o.name, (d) => d === domain)) continue;
      if ([...this.scriptWrites.values()].some((w) => w.name === o.name && writeDomain(w) === domain))
        continue;
      this.pushAttempted(
        o.name,
        'http-response',
        { domain, path: o.path, setterHost: o.host, setterUrl: o.url },
        defaultMoment,
      );
    }
  }

  private jarHas(name: string, canSet: (domain: string) => boolean): boolean {
    for (const d of this.jarDomains.get(name) ?? []) if (canSet(d)) return true;
    return false;
  }

  private writtenAfterClick(name: string, domain: string, path: string, partitioned: boolean): boolean {
    if (this.clickAt === null) return false;
    for (const w of this.scriptWritesAfterClick.values()) {
      if (w.name === name && scriptCanSet(w, domain)) return true;
    }
    for (const o of this.setCookieOrigins.values()) {
      // A rejected `Domain=` wrote no cookie.
      if (o.rejected || !o.afterClick || o.name !== name || originDomain(o) !== domain) continue;
      if (o.path === path && o.partitioned === partitioned) return true;
    }
    return false;
  }

  private pushAttempted(
    name: string,
    setter: CookieRecord['setter'],
    where: { domain: string; path?: string; setterHost?: string; setterUrl?: string },
    m: Moment,
    suffix = '',
  ): void {
    const rec: CookieRecord = {
      name,
      domain: where.domain,
      firstParty: isFirstParty(where.domain, this.target.etld1, this.target.host),
      path: where.path ?? '/',
      partitionKey: null,
      secure: false,
      httpOnly: false,
      sameSite: 'unknown',
      lifetime: { kind: 'session' },
      length: 0,
      ...cleanSetter({
        setter,
        ...(where.setterHost ? { setterHost: where.setterHost } : {}),
        ...(where.setterUrl ? { setterUrl: where.setterUrl } : {}),
      }),
      state: 'attempted',
      phase: m.phase,
      pageUrl: m.pageUrl,
      tMs: m.tMs,
      tRef: m.tRef,
      afterClick: m.afterClick,
      ...momentIds(m),
    };
    const key = cookieKey(rec) + suffix;
    if (this.cookieKeys.has(key)) return;
    this.cookieKeys.add(key);
    this.cookies.push(rec);
  }

  // The earliest candidate wins: a matching `Set-Cookie` response, else a script write whose document can set the
  // domain, else `unknown`.
  private setterOf(
    c: Pick<Cookie, 'name' | 'domain' | 'path'> & { partitionKey?: string },
  ): Pick<CookieRecord, 'setter' | 'setterHost' | 'setterUrl'> {
    const domain = normalizeDomain(c.domain) ?? c.domain;
    const path = c.path || '/';
    const partitioned = !!c.partitionKey;
    for (const o of this.setCookieOrigins.values()) {
      if (o.rejected || o.name !== c.name || originDomain(o) !== domain || o.path !== path) continue;
      if (o.partitioned !== partitioned) continue;
      return { setter: 'http-response', setterHost: o.host, setterUrl: o.url };
    }
    for (const w of this.scriptWrites.values()) {
      if (w.name !== c.name || !scriptCanSet(w, domain)) continue;
      return w.script
        ? { setter: 'script', setterHost: hostOf(w.script), setterUrl: w.script }
        : { setter: 'script' };
    }
    return { setter: 'unknown' };
  }

  /** `null` = no answer (error, timeout, abort). */
  private async bounded<T>(p: Promise<T>, what: string, frame?: Frame, dead?: Set<Frame>): Promise<T | null> {
    const r = await settleWithin(p, this.evalTimeoutMs, this.signal);
    if (r.status === 'ok') return r.value;
    if (r.status === 'expired') {
      // Not asked again in this snapshot (PDF viewer, wedged frame).
      if (frame) dead?.add(frame);
      if (!this.signal?.aborted) this.onError?.(what, new TimeoutError(what, this.evalTimeoutMs));
    }
    return null;
  }

  private async readScriptWrites(page: Page, m: Moment, dead: Set<Frame>): Promise<void> {
    for (const frame of page.frames()) {
      if (dead.has(frame)) continue;
      const logged = await this.bounded(frame.evaluate(cookieWritesInPage), 'jar.cookie-writes', frame, dead);
      if (!logged) continue;
      const frameHost = documentHostOf(frame);
      for (const raw of logged as LoggedWrite[]) {
        const documentHost = normalizeDomain(raw.host) ?? frameHost;
        const domainAttr = normalizeDomain(raw.domain);
        const w: StoredWrite = {
          name: raw.name,
          script: raw.script,
          deletion: raw.deletion,
          m,
          ...(documentHost ? { documentHost } : {}),
          ...(domainAttr ? { domainAttr } : {}),
        };
        const key = `${w.name}|${writeDomain(w) ?? ''}`;
        if (!this.scriptWrites.has(key)) this.scriptWrites.set(key, w);
        if (
          this.clickAt !== null &&
          raw.t >= this.clickAt &&
          m.afterClick &&
          !this.scriptWritesAfterClick.has(key)
        )
          this.scriptWritesAfterClick.set(key, w);
      }
    }
  }

  private async readStorage(page: Page, m: Moment, dead: Set<Frame>): Promise<void> {
    const seenOrigins = new Set<string>();
    for (const frame of page.frames()) {
      if (dead.has(frame)) continue;
      const url = frame.url();
      if (!/^https?:/.test(url)) continue;
      const origin = parseUrl(url)?.origin;
      if (origin === undefined) continue;
      if (seenOrigins.has(origin)) continue;
      seenOrigins.add(origin);
      const raw: RawStorage | null = await this.bounded(
        frame.evaluate(storageInPage, { maxKeys: 200 }),
        'jar.storage',
        frame,
        dead,
      );
      if (!raw) continue;
      const host = hostOf(raw.origin);
      if (!host) continue; // opaque origin (sandboxed frame): no storage of its own
      const writes =
        (await this.bounded(frame.evaluate(storageWritesInPage), 'jar.storage-writes', frame, dead)) ?? [];
      for (const w of writes) {
        const k = `${w.type}|${raw.origin}|${w.key}`;
        if (w.t > (this.storageWriteAt.get(k) ?? Number.NEGATIVE_INFINITY)) this.storageWriteAt.set(k, w.t);
      }
      const firstParty = isFirstParty(host, this.target.etld1, this.target.host);
      const add = (storageType: StorageRecord['storageType'], key: string, length?: number) => {
        const k = `${storageType}|${raw.origin}|${key}`;
        if (this.storageKeys.has(k)) {
          const at = this.storageWriteAt.get(k);
          const again = m.afterClick && this.clickAt !== null && at !== undefined && at >= this.clickAt;
          if (!again || this.storageKeys.has(k + AFTER)) return;
          this.storageKeys.add(k + AFTER);
        } else {
          this.storageKeys.add(k);
        }
        this.storage.push({
          storageType,
          origin: raw.origin,
          key,
          firstParty,
          ...(length !== undefined ? { length } : {}),
          phase: m.phase,
          pageUrl: m.pageUrl,
          tMs: m.tMs,
          afterClick: m.afterClick,
          ...momentIds(m),
        });
      };
      for (const e of raw.local) add('localStorage', e.key, e.length);
      for (const e of raw.session) add('sessionStorage', e.key, e.length);
      for (const name of raw.idb) add('indexedDB', name);
    }
  }
}

function hostOf(url: string): string | undefined {
  return parseUrl(url)?.hostname.toLowerCase();
}
