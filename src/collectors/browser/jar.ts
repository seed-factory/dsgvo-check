/**
 * Cookies and Web Storage per phase (names, flags and lengths only). `context.cookies()` after every page;
 * Set-Cookie names attribute `http-response`; the `document.cookie` hook attributes `script` and reveals transient
 * cookies (`attempted`). Values are read only into memory for the identifier correlation and then dropped.
 * Records are deduplicated per key, but a key seen before the B/C click gets a second, `afterClick` record when a
 * write event follows the click (script write, `Set-Cookie` of a request started after it, `setItem`): a re-set
 * `_ga` after "Ablehnen" is a write after the reject even though the cookie already existed.
 *
 * Attribution never goes by the cookie name alone: a cookie is attributed to a `Set-Cookie` response only
 * when name, domain, path and partition match, and to a script write only when the document of the writing frame (or
 * the `Domain=` attribute of the write) can set a cookie of that domain; otherwise the setter is `unknown`. The same
 * identity decides the second, `afterClick` record: a `Set-Cookie` after the click marks only the cookie with that
 * name, domain, path and partition. A `Set-Cookie` whose `Domain=` the response host may not set is ignored by
 * the browser: it is no setter and no write after the click of an existing cookie. The domain of an
 * `attempted` script cookie is that Domain= attribute or the host of the frame's document — never the host of the
 * script, which is only the `setterHost`. An `about:blank` or `about:srcdoc` frame has the document host of the frame
 * that created it; a write whose document host stays unknown cannot be verified and creates no `attempted`
 * record. Every in-page read is bounded in time and by the scan signal.
 */
import type { BrowserContext, Cookie, Frame, Page } from 'playwright-core';
import type { BrowserPhase } from '../../core/snapshot-common.ts';
import { parseUrl, registrableDomain } from '../../core/url.ts';
import { sanitizeRequestUrl } from './features.ts';
import { cookieWritesInPage, type RawStorage, storageInPage, storageWritesInPage } from './in-page.ts';
import { type SetCookieOrigin, settleWithin } from './recorder.ts';
import type { CookieRecord, StorageRecord } from './types.ts';
import { TimeoutError } from './util.ts';

export interface Moment {
  phase: BrowserPhase;
  pageUrl: string;
  tMs: number;
  tRef: 'navigation' | 'click';
  afterClick: boolean;
  /** 5.3: ms since the scan start (one monotonic scale), navigation and click of this moment. */
  atMs?: number;
  navigationId?: string;
  actionId?: string;
}

/** The 5.3 time and context ids of a moment, for cookie and storage records. */
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
  /** Host of the document that wrote the cookie (the hook's `location.hostname`); null/absent in older hooks. */
  host?: string | null;
  /** Parsed `domain=` attribute of the write, without the cookie value; absent/null when none was given. */
  domain?: string | null;
}

/** Options that bound the in-page reads of the tracker. */
export interface JarOptions {
  /** Budget of one `frame.evaluate`. Default 1 s: the reads are trivial, a slower frame is wedged (PDF viewer). */
  evalTimeoutMs?: number;
  /** Scan abort: the reads are skipped at once. */
  signal?: AbortSignal;
  /** A read that ran out of time (`jar.cookie-writes`, `jar.storage`, …); the caller records it in the phase errors. */
  onError?: (what: string, err: unknown) => void;
}

const DEFAULT_EVAL_TIMEOUT_MS = 1_000;

/** An entry of the in-page cookie-write log. */
type LoggedWrite = ScriptWrite & { t: number };

/** A script write with the context it happened in. */
interface StoredWrite extends ScriptWrite {
  m: Moment;
  /** Normalised `host` (the frame's document host when the hook gave none). */
  documentHost?: string;
  /** Normalised `domain=` attribute. */
  domainAttr?: string;
}

const normalizeDomain = (d: string | null | undefined): string | undefined => {
  const v = d?.trim().replace(/^\./, '').toLowerCase();
  return v ? v : undefined;
};

/** `about:blank` and `about:srcdoc` documents (iframes created by script) use the origin of their creator. */
const INHERITS_ORIGIN = /^about:(?:blank|srcdoc)(?:[#?].*)?$/i;

/**
 * Host of the document of `frame`. A frame without a host of its own (`about:blank`, `about:srcdoc`) takes the host of
 * the nearest ancestor with an http(s) URL; any other hostless URL (`data:`, `blob:`, opaque origin) stays unknown.
 */
function documentHostOf(frame: Frame): string | undefined {
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    const url = f.url();
    const host = normalizeDomain(hostOf(url));
    if (host) return host;
    if (!INHERITS_ORIGIN.test(url)) return undefined;
  }
  return undefined;
}

/** The cookie domain a script write targets: its Domain= attribute, else the host of the writing document. */
const writeDomain = (w: StoredWrite): string | undefined => w.domainAttr ?? w.documentHost;

/**
 * Can this script write have created a cookie of `domain`? With an explicit Domain= attribute the domain must be
 * equal; otherwise the document host must be the domain itself or below it (a document cannot set cookies for a
 * foreign domain). A write of unknown context cannot be verified.
 */
function scriptCanSet(w: StoredWrite, domain: string): boolean {
  if (w.domainAttr) return w.domainAttr === domain;
  const host = w.documentHost;
  return host !== undefined && (host === domain || host.endsWith(`.${domain}`));
}

/**
 * The cookie domain a `Set-Cookie` response targets: its Domain= attribute (the recorder keeps only one the response
 * host may set, RFC 6265 5.3), else the response host (host-only; also what a `rejected` origin stands for).
 */
const originDomain = (o: SetCookieOrigin): string => o.domain ?? o.host;

function isFirstParty(domain: string, targetEtld1: string | null, targetHost: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (targetEtld1 === null) return d === targetHost;
  return registrableDomain(d) === targetEtld1;
}

/** Pure mapping of a Playwright cookie to a value-free record. */
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

/** One sanitizing point for the setter of every cookie record (no query values of script URLs). */
function cleanSetter(
  s: Pick<CookieRecord, 'setter' | 'setterHost' | 'setterUrl'>,
): Pick<CookieRecord, 'setter' | 'setterHost' | 'setterUrl'> {
  return s.setterUrl ? { ...s, setterUrl: sanitizeRequestUrl(s.setterUrl) } : s;
}

const cookieKey = (r: Pick<CookieRecord, 'name' | 'domain' | 'path' | 'partitionKey' | 'state'>) =>
  `${r.name}|${r.domain}|${r.path}|${r.partitionKey ?? ''}|${r.state}`;

/** Key of the second record of a key that was written again after the click. */
const AFTER = '|after-click';

export class JarTracker {
  readonly cookies: CookieRecord[] = [];
  readonly storage: StorageRecord[] = [];
  private readonly cookieKeys = new Set<string>();
  private readonly storageKeys = new Set<string>();
  /** Cookie name → domains of the jar cookies seen with that name (an `attempted` record needs a missing pair). */
  private readonly jarDomains = new Map<string, Set<string>>();
  /** First script write per `name|cookie domain` (setter attribution) with the moment it was first seen. */
  private readonly scriptWrites = new Map<string, StoredWrite>();
  /** Script writes after the click: `name|cookie domain` → the write and the moment of the snapshot that saw it. */
  private readonly scriptWritesAfterClick = new Map<string, StoredWrite>();
  /** Latest `setItem` time per `type|origin|key`. */
  private readonly storageWriteAt = new Map<string, number>();
  /** Epoch ms of the B/C click (null before it). */
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

  /** The B/C click happened at `epochMs`: later write events of known keys produce `afterClick` records. */
  markClick(epochMs: number): void {
    this.clickAt = epochMs;
  }

  /**
   * Snapshot cookies and storage after a page or a click. Returns cookie VALUES for the in-memory identifier
   * correlation only; the caller must not keep or log them. A frame that does not answer within the budget is
   * skipped for this snapshot (its facts stay as collected before).
   */
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

  /** Cookies seen being written (script or Set-Cookie) that never reached the jar: `attempted`. */
  finalize(defaultMoment: Moment): void {
    for (const [key, w] of this.scriptWrites) {
      if (w.deletion || this.jarHas(w.name, (d) => scriptCanSet(w, d))) continue;
      // A write of unknown document and without Domain= cannot be placed on any domain: not verifiable.
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

  /**
   * Was this jar cookie written again after the click? A script write must be able to set the domain; a `Set-Cookie`
   * counts only for the cookie with the same name, domain, path and partition.
   */
  private writtenAfterClick(name: string, domain: string, path: string, partitioned: boolean): boolean {
    if (this.clickAt === null) return false;
    for (const w of this.scriptWritesAfterClick.values()) {
      if (w.name === name && scriptCanSet(w, domain)) return true;
    }
    for (const o of this.setCookieOrigins.values()) {
      // A rejected `Domain=` wrote no cookie: the browser ignored the response's cookie entirely.
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

  /**
   * Who set this jar cookie. A `Set-Cookie` response counts only when name, domain (Domain= or the response host),
   * path and partition agree with the cookie; else a script write whose document can set that domain; else
   * `unknown`. The earliest candidate wins (the writer that created the cookie).
   */
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

  /** One in-page read, bounded by the budget and the scan signal. `null` = no answer (error, timeout, abort). */
  private async bounded<T>(p: Promise<T>, what: string, frame?: Frame, dead?: Set<Frame>): Promise<T | null> {
    const r = await settleWithin(p, this.evalTimeoutMs, this.signal);
    if (r.status === 'ok') return r.value;
    if (r.status === 'expired') {
      // A frame that did not answer once is not asked again in this snapshot (PDF viewer, wedged frame).
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
