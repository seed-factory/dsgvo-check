/** One top-level navigation with the quiet wait, response facts, DOM facts and challenge detection. */
import type { Page, Response } from 'playwright-core';
import { snapshotHeaderRecords } from '../../../core/redaction/headers.ts';
import type { PageRole, PageVisit } from '../../../core/snapshot/browser.ts';
import type { BrowserPhase, HeaderRecord } from '../../../core/snapshot/common.ts';
import { retryAfterMs } from '../../http/client.ts';
import type { BrowserTiming, PhaseTiming } from '../config.ts';
import { sanitizeRequestUrl, splitSetCookieNames } from '../recording/features.ts';
import { waitForQuiet } from '../recording/quiet.ts';
import { type NetworkRecorder, settleWithin } from '../recording/recorder.ts';
import { errorText, TimeoutError, truncate, withTimeout } from '../util.ts';
import { detectChallenge } from './challenge.ts';
import { collectDom } from './dom-facts.ts';
import type { CandidateLink } from './pages.ts';

export interface VisitInput {
  page: Page;
  recorder: NetworkRecorder;
  timing: BrowserTiming;
  phaseTiming: PhaseTiming;
  signal: AbortSignal;
  target: { etld1: string | null; host: string };
  now: () => Date;
}

export interface VisitSpec {
  rawUrl: string;
  role: PageRole;
  order: number;
  phase: BrowserPhase;
  firstVisit: boolean;
  reload?: boolean;
}

export interface VisitResult {
  visit: PageVisit;
  candidates: CandidateLink[];
  rawFinalUrl: string;
  contentType: string;
  error?: string;
  retryAfterMs?: number;
  /** Facts that could not be completed within the page budget; the collector keeps them as phase errors. */
  limitations?: Array<{ code: string; message: string }>;
}

const MAX_HEADER_VALUE = 2048;
/** Floor of the page budget left for response metadata after the quiet wait. */
const MIN_META_BUDGET_MS = 500;

export interface SettledValue<T> {
  value: T;
  /** `timeout`: the budget ran out; `aborted`: the scan deadline passed; absent: `p` settled (value or error). */
  cut?: 'timeout' | 'aborted';
}

// Waits for `p` but not past `ms` or the abort; never rejects (a rejection and a cut both give `fallback`). The pending
// promise keeps running and its later result is not used.
export async function valueWithin<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal,
  fallback: T,
): Promise<SettledValue<T>> {
  const r = await settleWithin(p, ms, signal);
  if (r.status === 'ok') return { value: r.value };
  if (r.status === 'error') return { value: fallback };
  return { value: fallback, cut: signal.aborted ? 'aborted' : 'timeout' };
}

// The core normalizer shared with the HTTP collector, with the browser's URL allowlist. Live values (challenge
// detection, `Link`, Retry-After) are read from the raw headers in memory.
export function snapshotResponseHeaders(
  raw: ReadonlyArray<{ name: string; value: string }>,
  base: string,
): HeaderRecord[] {
  return snapshotHeaderRecords(raw, base, sanitizeRequestUrl);
}

function firstLine(s: string): string {
  return truncate(s.split('\n')[0] ?? s, 300);
}

export function navigationErrorCode(message: string): string {
  const m = /net::(ERR_[A-Z0-9_]+)/.exec(message);
  if (m) return m[1] as string;
  if (/Timeout .*exceeded|timed out/i.test(message)) return 'timeout';
  if (/Download is starting/i.test(message)) return 'download';
  return 'navigation-error';
}

function errorCodeOfErrorPage(title: string, text: string): string | null {
  return /\b(ERR_[A-Z0-9_]+)\b/.exec(`${title}\n${text}`)?.[1] ?? null;
}

export async function visitPage(i: VisitInput, s: VisitSpec): Promise<VisitResult> {
  const startedAt = i.now().toISOString();
  const navigationId = i.recorder.beginNavigation(sanitizeRequestUrl(s.rawUrl));
  const t0 = Date.now();
  let resp: Response | null = null;
  let error: string | undefined;
  let domContentLoadedMs: number | undefined;
  let loadMs: number | undefined;
  let pageLoadIncomplete = false;
  const limitations: Array<{ code: string; message: string }> = [];
  /** What is left of HARD_CAP, with a floor: the budget for everything after the navigation. */
  const budgetLeft = () => Math.max(MIN_META_BUDGET_MS, i.phaseTiming.hardCapMs - (Date.now() - t0));
  /** Await response metadata within the page budget; on a cut keep what is known and record the limitation. */
  const bounded = async <T>(code: string, what: string, p: Promise<T>, fallback: T): Promise<T> => {
    const ms = budgetLeft();
    const r = await valueWithin(p, ms, i.signal, fallback);
    if (r.cut === 'timeout') limitations.push({ code, message: `${what} not completed within ${ms} ms` });
    return r.value;
  };
  try {
    resp = s.reload
      ? await i.page.reload({ waitUntil: 'domcontentloaded', timeout: i.timing.navigationTimeoutMs })
      : await i.page.goto(s.rawUrl, { waitUntil: 'domcontentloaded', timeout: i.timing.navigationTimeoutMs });
    domContentLoadedMs = Date.now() - t0;
  } catch (err) {
    error = firstLine(errorText(err));
  }
  if (!error) {
    try {
      await i.page.waitForLoadState('load', { timeout: i.timing.loadTimeoutMs });
      loadMs = Date.now() - t0;
    } catch {
      pageLoadIncomplete = true;
    }
  }
  const quiet = await waitForQuiet(
    i.recorder,
    t0,
    { ...i.phaseTiming, quietWindowMs: i.timing.quietWindowMs, maxInflight: i.timing.maxInflight },
    i.signal,
  );
  // The wait for the recorder's handlers is the page's, not theirs: a `timeoutMs` here would make the recorder abandon
  // every pending handler, and a late `Set-Cookie`, address or identifier would be lost although the handler's own
  // budget allows it. The phase end and `dispose()` abandon what is left.
  await bounded('recorder-flush-timeout', 'network records', i.recorder.flush({ signal: i.signal }), true);

  // `headers()` is the fallback when the raw headers do not arrive in time: it still tells the content type, so a PDF
  // viewer page is not read as HTML.
  const rawHeaders = resp
    ? await bounded(
        'response-headers-timeout',
        'response headers',
        resp.headersArray(),
        Object.entries(resp.headers()).map(([name, value]) => ({ name, value })),
      )
    : [];
  const setCookieNames = splitSetCookieNames(
    rawHeaders.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value),
  );
  // In memory only: challenge detection, `Link` hints and Retry-After read the live values.
  const liveHeaders: HeaderRecord[] = rawHeaders
    .filter((h) => h.name.toLowerCase() !== 'set-cookie')
    .map((h) => ({ name: h.name.toLowerCase(), value: truncate(h.value, MAX_HEADER_VALUE) }));
  const headers = snapshotResponseHeaders(rawHeaders, resp?.url() ?? s.rawUrl);
  const redirectChain: string[] = [];
  for (let r = resp?.request().redirectedFrom() ?? null; r; r = r.redirectedFrom()) {
    redirectChain.unshift(sanitizeRequestUrl(r.url()));
  }
  const serverIp = resp
    ? ((await bounded('server-address-timeout', 'server address', resp.serverAddr(), null))?.ipAddress ??
      null)
    : null;
  const status = resp?.status() ?? null;
  const contentType = liveHeaders.find((h) => h.name === 'content-type')?.value ?? '';

  let dom: PageVisit['dom'] = null;
  let candidates: CandidateLink[] = [];
  let title = '';
  let text = '';
  let scripts: string[] = [];
  let domError: string | undefined;
  if (!error && /html|xml|^$/i.test(contentType)) {
    for (let attempt = 0; attempt < 2 && !dom; attempt++) {
      try {
        const r = await withTimeout(
          collectDom(i.page, i.target, liveHeaders),
          i.timing.cmpCallTimeoutMs,
          'DOM facts',
        );
        dom = r.dom;
        candidates = r.candidates;
        title = r.raw.title;
        text = r.raw.textSample;
        scripts = r.raw.scripts.map((x) => x.src).filter(Boolean);
        domError = undefined;
      } catch (err) {
        domError = firstLine(errorText(err));
        if (err instanceof TimeoutError) {
          limitations.push({ code: 'dom-collect-timeout', message: domError });
          break;
        }
        // The page navigated itself (JS/meta redirect) while we read it: wait for the new document once.
        if (!/context was destroyed|navigat/i.test(domError)) break;
        await i.page.waitForLoadState('load', { timeout: i.timing.loadTimeoutMs }).catch(() => undefined);
      }
    }
  }
  // Read after the DOM: a JS/meta redirect during the quiet window changes the final URL.
  let rawFinalUrl = error ? s.rawUrl : i.page.url();
  if (!error && !/^https?:/i.test(rawFinalUrl)) {
    // The browser ended on its own error page (`chrome-error://`) or left http(s): a failed navigation, nothing read
    // from the page belongs to the site.
    error = `net::${errorCodeOfErrorPage(title, text) ?? 'ERR_FAILED'}`;
    rawFinalUrl = s.rawUrl;
    dom = null;
    candidates = [];
    title = '';
    text = '';
    scripts = [];
  }
  // Requests of this navigation belong to the page as shown; later ones too until the next navigation.
  if (!error) i.recorder.rebindNavigation(sanitizeRequestUrl(rawFinalUrl));
  const challenge = error
    ? { detected: false, signals: [] }
    : detectChallenge({ status, headers: liveHeaders, title, text, scripts });
  const notEvaluableReason = error
    ? `navigation-failed:${navigationErrorCode(error)}`
    : challenge.detected
      ? 'challenge'
      : status !== null && status >= 400
        ? `http-${status}`
        : dom === null
          ? domError
            ? 'dom-unavailable'
            : 'not-html'
          : undefined;

  const visit: PageVisit = {
    url: sanitizeRequestUrl(s.rawUrl),
    finalUrl: sanitizeRequestUrl(rawFinalUrl),
    role: s.role,
    order: s.order,
    phase: s.phase,
    navigationId,
    firstVisit: s.firstVisit,
    ...(s.reload ? { reload: true } : {}),
    navigation: {
      status,
      ok: !error && status !== null && status < 400,
      ...(error ? { error: navigationErrorCode(error) } : {}),
      redirectChain,
      startedAt,
      ...(domContentLoadedMs !== undefined ? { domContentLoadedMs } : {}),
      ...(loadMs !== undefined ? { loadMs } : {}),
      quietReached: quiet.quietReached,
      dwellMs: quiet.dwellMs,
      ...(pageLoadIncomplete ? { pageLoadIncomplete: true } : {}),
      serverIp,
    },
    responseHeaders: headers,
    setCookieNames,
    challenge,
    evaluable: notEvaluableReason === undefined,
    ...(notEvaluableReason ? { notEvaluableReason } : {}),
    dom,
  };
  const retry =
    retryAfterMs(liveHeaders.find((h) => h.name === 'retry-after')?.value ?? null, Date.now()) ?? undefined;
  return {
    visit,
    candidates,
    rawFinalUrl,
    contentType,
    ...(error ? { error } : {}),
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
    ...(limitations.length > 0 ? { limitations } : {}),
  };
}
