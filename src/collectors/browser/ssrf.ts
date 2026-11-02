/**
 * SSRF boundary of the prototype (BRIEF "Упрощения"): documents (top-level, frames, popups) whose host is or resolves
 * to a private / loopback / link-local / metadata address — or does not resolve locally at all — are failed with
 * `BlockedByClient`. Implemented with CDP `Fetch` (resource type Document only) on a BROWSER-level session, so that
 * every target is covered from its first request: popups opened by `window.open` / `target=_blank`, out-of-process
 * frames and redirect hops (Playwright routes are not invoked for redirects; a page-level session attached on
 * `context.on('page')` misses a popup's first navigation). A name that does not resolve locally fails closed: behind
 * `--proxy` the proxy could resolve it to an internal address, and without a proxy the browser could not load it
 * anyway. Subresources are not checked (documented gap); the egress proxy of the release (5.7) replaces this. Off
 * when `allowPrivateAddresses` (tests).
 */
import { isIP } from 'node:net';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { type AddressClass, classifyAddress, type Lookup, type NetworkConfig } from '../../core/net.ts';

export type GuardVerdict = AddressClass | 'unresolved';

/** A resolver error seen by the classifier: the Node error code and the attempt it happened on. */
export interface LookupError {
  host: string;
  /** `ENOTFOUND`, `EAI_AGAIN`, `ETIMEOUT`, `ESERVFAIL`, …; `UNKNOWN` when the error carries no code. */
  code: string;
  attempt: number;
}

export interface ClassifierOptions {
  /** Reports every resolver error (also those a later attempt recovers from). */
  onLookupError?: (e: LookupError) => void;
  /** Pauses before the 2nd and 3rd attempt after a transient resolver error. Default 250 and 750 ms. */
  backoffMs?: readonly number[];
  /** All attempts of one name together, every wait for the resolver included. Default 5 s. */
  budgetMs?: number;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [250, 750];
const DEFAULT_BUDGET_MS = 5_000;

/**
 * Resolver errors that say "try again": a name that exists may resolve a moment later. `ENOTFOUND` (and an error
 * without a code) is an answer, not a hiccup: one immediate retry, then the name counts as unresolved.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ESERVFAIL',
  'SERVFAIL',
  'ECONNREFUSED',
  'ECANCELLED',
  'EAI_FAIL',
]);

/** Marks a wait for the resolver that ran into the deadline. */
const EXPIRED = Symbol('lookup-deadline');

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function hostClassifier(
  network: NetworkConfig,
  options: ClassifierOptions = {},
): (host: string) => Promise<GuardVerdict> {
  const cache = new Map<string, Promise<GuardVerdict>>();
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  /**
   * One ask of the resolver. The wait is bounded by what is left of the shared deadline: when it runs
   * out the ask ends as `timedOut` and an `ETIMEOUT` is reported; an answer that comes later is not applied (nothing
   * listens to it any more), and the timer is cleared on every way out. A budget that is spent already asks nothing.
   */
  const lookupOnce = async (
    h: string,
    attempt: number,
    deadline: number,
  ): Promise<{ verdict: GuardVerdict } | { code: string } | { timedOut: true }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = deadline - Date.now();
      let addrs: Awaited<ReturnType<Lookup>> | typeof EXPIRED = EXPIRED;
      if (remaining > 0) {
        const expired = new Promise<typeof EXPIRED>((resolve) => {
          timer = setTimeout(() => resolve(EXPIRED), remaining);
        });
        addrs = await Promise.race([network.lookup(h), expired]);
      }
      if (addrs === EXPIRED) {
        options.onLookupError?.({ host: h, code: 'ETIMEOUT', attempt });
        return { timedOut: true };
      }
      if (addrs.length === 0) return { verdict: 'unresolved' };
      // Any non-public address is enough to refuse: the browser may pick it.
      const bad = addrs.map((a) => classifyAddress(a.address)).find((c) => c !== 'public');
      return { verdict: bad ?? 'public' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const known = typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
      options.onLookupError?.({ host: h, code: known, attempt });
      return { code: known }; // resolver error (ENOTFOUND, EAI_AGAIN, timeout)
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  /**
   * Up to 3 attempts, all within one deadline of `budgetMs` (every wait for the resolver included, the first ask and
   * the immediate re-ask too). A transient error is retried after a backoff; a definitive answer (`ENOTFOUND`, no
   * code) gets one immediate re-ask, as before. When the deadline passes the name counts as unresolved.
   */
  const resolve = async (h: string): Promise<GuardVerdict | null> => {
    const started = Date.now();
    const deadline = started + budgetMs;
    let r = await lookupOnce(h, 1, deadline);
    if ('verdict' in r) return r.verdict;
    if ('timedOut' in r) return null;
    if (!TRANSIENT_CODES.has(r.code)) {
      r = await lookupOnce(h, 2, deadline);
      return 'verdict' in r ? r.verdict : null;
    }
    for (let i = 0; i < backoff.length; i++) {
      const wait = backoff[i] as number;
      if (Date.now() - started + wait > budgetMs) break;
      await pause(wait);
      r = await lookupOnce(h, i + 2, deadline);
      if ('verdict' in r) return r.verdict;
      if ('timedOut' in r || !TRANSIENT_CODES.has(r.code)) break;
    }
    return null;
  };
  return (host) => {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    let p = cache.get(h);
    if (!p) {
      p = (async (): Promise<GuardVerdict> => {
        if (isIP(h)) return classifyAddress(h);
        if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
        // A failure is not cached (the next document asks again).
        const v = await resolve(h);
        if (v === null) {
          cache.delete(h);
          return 'unresolved';
        }
        return v;
      })();
      cache.set(h, p);
    }
    return p;
  };
}

/** Verdict for a document URL: only http(s) hosts are classified; everything else passes. */
export async function urlVerdict(
  url: string,
  classify: (host: string) => Promise<GuardVerdict>,
): Promise<GuardVerdict | 'pass'> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'pass';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'pass';
  return classify(u.hostname);
}

/** Fail closed: only non-http(s) documents and hosts that resolve to public addresses only are loaded. */
export const blocks = (v: GuardVerdict | 'pass'): boolean => v !== 'pass' && v !== 'public';

export interface GuardHandle {
  enabled: boolean;
  /** `browser`: one browser-level session covers all targets; `page`: fallback per page (popups not covered). */
  scope?: 'browser' | 'page';
}

interface PausedEvent {
  requestId: string;
  request: { url: string };
}

const DOCUMENT_PATTERNS = {
  patterns: [{ urlPattern: '*', resourceType: 'Document' as const, requestStage: 'Request' as const }],
};

function intercept(
  cdp: CDPSession,
  classify: (host: string) => Promise<GuardVerdict>,
  onBlocked: (url: string, verdict: GuardVerdict) => void,
): void {
  cdp.on('Fetch.requestPaused', (e: PausedEvent) => {
    void (async () => {
      const verdict = await urlVerdict(e.request.url, classify);
      if (blocks(verdict)) {
        onBlocked(e.request.url, verdict as GuardVerdict);
        await cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
      } else {
        await cdp.send('Fetch.continueRequest', { requestId: e.requestId });
      }
    })().catch(() => undefined);
  });
}

export async function installSsrfGuard(
  context: BrowserContext,
  network: NetworkConfig,
  onBlocked: (url: string, verdict: GuardVerdict) => void,
  options: ClassifierOptions = {},
): Promise<GuardHandle> {
  if (network.allowPrivateAddresses) return { enabled: false };
  const classify = hostClassifier(network, options);
  const browser = context.browser();
  if (browser) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      intercept(cdp, classify, onBlocked);
      await cdp.send('Fetch.enable', DOCUMENT_PATTERNS);
      return { enabled: true, scope: 'browser' };
    } catch {
      // fall back to page-level sessions below
    }
  }
  const attach = async (page: Page): Promise<void> => {
    let cdp: CDPSession;
    try {
      cdp = await context.newCDPSession(page);
    } catch {
      return; // page already closed
    }
    intercept(cdp, classify, onBlocked);
    await cdp.send('Fetch.enable', DOCUMENT_PATTERNS).catch(() => undefined);
  };
  for (const page of context.pages()) await attach(page);
  context.on('page', (page) => {
    void attach(page);
  });
  return { enabled: true, scope: 'page' };
}
