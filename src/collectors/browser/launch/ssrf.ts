// SSRF boundary: documents (top-level, frames, popups) whose host is or resolves to a private, loopback, link-local or
// metadata address, or does not resolve locally, are failed with `BlockedByClient`. CDP `Fetch` on a BROWSER-level
// session also covers popups and redirect hops. An unresolvable name fails closed (a proxy could resolve it
// internally). Subresources are not checked. Off with `allowPrivateAddresses`.
import { isIP } from 'node:net';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import {
  type AddressClass,
  classifyAddress,
  type Lookup,
  type NetworkConfig,
} from '../../../core/url/net.ts';
import { isHttpUrl } from '../../../core/url/url.ts';

export type GuardVerdict = AddressClass | 'unresolved';

export interface LookupError {
  host: string;
  code: string;
  attempt: number;
}

export interface ClassifierOptions {
  onLookupError?: (e: LookupError) => void;
  /** Pauses before the 2nd and 3rd attempt after a transient error. Default 250 and 750 ms. */
  backoffMs?: readonly number[];
  /** All attempts of one name together. Default 5 s. */
  budgetMs?: number;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [250, 750];
const DEFAULT_BUDGET_MS = 5_000;

// Resolver errors that say "try again". `ENOTFOUND` (or no code) is an answer: one immediate retry, then the name
// counts as unresolved.
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

const EXPIRED = Symbol('lookup-deadline');

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LookupAttempt = { verdict: GuardVerdict } | { code: string } | { timedOut: true };

interface LookupSettings {
  network: NetworkConfig;
  options: ClassifierOptions;
  backoff: readonly number[];
  budgetMs: number;
}

export function hostClassifier(
  network: NetworkConfig,
  options: ClassifierOptions = {},
): (host: string) => Promise<GuardVerdict> {
  const settings: LookupSettings = {
    network,
    options,
    backoff: options.backoffMs ?? DEFAULT_BACKOFF_MS,
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
  };
  const cache = new Map<string, Promise<GuardVerdict>>();

  return (host) => {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    let p = cache.get(h);
    if (!p) {
      p = (async (): Promise<GuardVerdict> => {
        if (isIP(h)) return classifyAddress(h);
        if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';

        // A failure is not cached (the next document asks again).
        const v = await resolveHost(settings, h);
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

// Up to 3 attempts within one `budgetMs` deadline. A transient error is retried after a backoff; a definitive answer
// (`ENOTFOUND`, no code) gets one immediate re-ask. At the deadline the name counts as unresolved (`null`).
async function resolveHost(l: LookupSettings, h: string): Promise<GuardVerdict | null> {
  const started = Date.now();
  const deadline = started + l.budgetMs;

  let r = await lookupOnce(l, h, 1, deadline);
  if ('verdict' in r) return r.verdict;
  if ('timedOut' in r) return null;
  if (!TRANSIENT_CODES.has(r.code)) {
    r = await lookupOnce(l, h, 2, deadline);
    return 'verdict' in r ? r.verdict : null;
  }

  for (let i = 0; i < l.backoff.length; i++) {
    const wait = l.backoff[i] as number;
    if (Date.now() - started + wait > l.budgetMs) break;
    await pause(wait);
    r = await lookupOnce(l, h, i + 2, deadline);
    if ('verdict' in r) return r.verdict;
    if ('timedOut' in r || !TRANSIENT_CODES.has(r.code)) break;
  }
  return null;
}

// One ask of the resolver, bounded by what is left of the shared deadline: on expiry it ends as `timedOut` and reports
// `ETIMEOUT`; a late answer is ignored. A spent budget asks nothing.
async function lookupOnce(
  l: LookupSettings,
  h: string,
  attempt: number,
  deadline: number,
): Promise<LookupAttempt> {
  try {
    const remaining = deadline - Date.now();
    const addrs = remaining > 0 ? await lookupWithin(l.network, h, remaining) : EXPIRED;
    if (addrs === EXPIRED) {
      l.options.onLookupError?.({ host: h, code: 'ETIMEOUT', attempt });
      return { timedOut: true };
    }
    if (addrs.length === 0) return { verdict: 'unresolved' };

    // Any non-public address is enough to refuse: the browser may pick it.
    const bad = addrs.map((a) => classifyAddress(a.address)).find((c) => c !== 'public');
    return { verdict: bad ?? 'public' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const known = typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
    l.options.onLookupError?.({ host: h, code: known, attempt });
    return { code: known }; // resolver error (ENOTFOUND, EAI_AGAIN, timeout)
  }
}

async function lookupWithin(
  network: NetworkConfig,
  host: string,
  ms: number,
): Promise<Awaited<ReturnType<Lookup>> | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<typeof EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(EXPIRED), ms);
    });
    return await Promise.race([network.lookup(host), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Verdict for a document URL: only http(s) hosts are classified; other schemes pass, unparsable URLs block. */
export async function urlVerdict(
  url: string,
  classify: (host: string) => Promise<GuardVerdict>,
): Promise<GuardVerdict | 'pass'> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unresolved';
  }
  if (!isHttpUrl(u)) return 'pass';
  return classify(u.hostname);
}

/** Fail closed: only non-http(s) documents and hosts that resolve to public addresses only are loaded. */
export const blocks = (v: GuardVerdict | 'pass'): boolean => v !== 'pass' && v !== 'public';

export interface GuardHandle {
  enabled: boolean;
  /** `page` is the fallback (popups not covered). */
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

  if (await interceptBrowserWide(context, classify, onBlocked)) return { enabled: true, scope: 'browser' };
  await interceptEachPage(context, classify, onBlocked);
  return { enabled: true, scope: 'page' };
}

/** One session on the browser sees popups and redirect hops too; false when the browser does not offer it. */
async function interceptBrowserWide(
  context: BrowserContext,
  classify: (host: string) => Promise<GuardVerdict>,
  onBlocked: (url: string, verdict: GuardVerdict) => void,
): Promise<boolean> {
  const browser = context.browser();
  if (!browser) return false;
  try {
    const cdp = await browser.newBrowserCDPSession();
    intercept(cdp, classify, onBlocked);
    await cdp.send('Fetch.enable', DOCUMENT_PATTERNS);
    return true;
  } catch {
    return false; // the caller falls back to page-level sessions
  }
}

/** Fallback with one session per page; popups are not covered. */
async function interceptEachPage(
  context: BrowserContext,
  classify: (host: string) => Promise<GuardVerdict>,
  onBlocked: (url: string, verdict: GuardVerdict) => void,
): Promise<void> {
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
}
