/** One top-level navigation with the quiet wait, response facts, DOM facts and challenge detection. */
import type { Page, Response } from 'playwright-core';
import { snapshotHeaderRecords } from '../../../core/redaction/headers.ts';
import type { PageRole, PageVisit } from '../../../core/snapshot/browser.ts';
import type { BrowserPhase, HeaderRecord } from '../../../core/snapshot/common.ts';
import { retryAfterMs } from '../../http/pacing.ts';
import type { BrowserTiming, PhaseTiming } from '../config.ts';
import { sanitizeRequestUrl, splitSetCookieNames } from '../recording/features.ts';
import { waitForQuiet } from '../recording/quiet.ts';
import { type NetworkRecorder, settleWithin } from '../recording/recorder.ts';
import { errorText, pageCallFailure, TimeoutError, truncate, withTimeout } from '../util.ts';
import { detectChallenge } from './challenge.ts';
import { collectDom } from './dom-facts.ts';
import { chromiumNetError } from './net-errors.ts';
import type { CandidateLink, LegalKind } from './pages.ts';

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
  /**
   * Legal documents phase A reads this page for: the kinds a legal page is queued for (a combined page keeps the role
   * of its first kind), and on the contact page and intermediate pages those still missing, whose links are looked for
   * there and whose Impressum the page itself may be while none was found.
   */
  legalKinds?: readonly LegalKind[];
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
/** One more read of the DOM when the page navigated itself while it was read. */
const DOM_READ_ATTEMPTS = 2;

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

/** The net error at the start of Playwright's message of a failed `goto`/`reload`, or the collector's own `net::<code>`. */
const NET_ERROR = /^(?:(?:page|frame)\.(?:goto|reload): )?net::(ERR_[A-Z0-9_]+)(?=$|[\s;])/;
/** Playwright names both URLs; the second one is where the page sent itself. */
const INTERRUPTED =
  /^(?:page|frame)\.(?:goto|reload): Navigation to ".*" is interrupted by another navigation to/s;

// The code of a failed navigation, from the start of the message only and only as one of Chromium's net errors: the
// rest of the message can name a URL the page chose (`… interrupted by another navigation to "/?x=net::ERR_…"`).
export function navigationErrorCode(message: string): string {
  const m = NET_ERROR.exec(message);
  if (m) return chromiumNetError(m[1] as string) ?? 'navigation-error';
  if (INTERRUPTED.test(message)) return 'navigation-interrupted';
  if (/Timeout .*exceeded|timed out/i.test(message)) return 'timeout';
  if (/Download is starting/i.test(message)) return 'download';
  return 'navigation-error';
}

/** The code Chromium's own error page (`chrome-error://`) shows; any other document is the page's own text. */
function errorCodeOfErrorPage(finalUrl: string, title: string, text: string): string {
  if (!finalUrl.startsWith('chrome-error://')) return 'ERR_FAILED';
  const code = /\b(ERR_[A-Z0-9_]+)\b/.exec(`${title}\n${text}`)?.[1];
  return (code && chromiumNetError(code)) ?? 'ERR_FAILED';
}

/** Awaits response metadata within the page budget; on a cut the fallback is used and the limitation recorded. */
type Bounded = <T>(code: string, what: string, p: Promise<T>, fallback: T) => Promise<T>;

type CommittedResponse = Promise<Response | null>;
interface DocumentNavigation {
  response: CommittedResponse | null;
}

const navigations = new WeakMap<Page, DocumentNavigation>();

function documentNavigation(page: Page): DocumentNavigation {
  const existing = navigations.get(page);
  if (existing) return existing;

  const navigation: DocumentNavigation = { response: null };
  navigations.set(page, navigation);
  let stopped = false;
  let pending: CommittedResponse;

  const arm = () => {
    const waiting = page.waitForNavigation({ waitUntil: 'commit', timeout: 0 });
    pending = waiting;
    void waiting.catch(() => {
      if (pending === waiting && !stopped && !page.isClosed()) arm();
    });
  };

  const stop = () => {
    stopped = true;
  };
  page.once('close', stop);
  page.once('crash', stop);
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || stopped) return;
    const previous = /^https?:/i.test(frame.url()) ? navigation.response : null;
    navigation.response = pending.then(
      (response) => response ?? previous,
      () => null,
    );
    arm();
  });
  arm();
  return navigation;
}

interface Loaded {
  resp: Response | null;
  error?: string;
  domContentLoadedMs?: number;
  loadMs?: number;
  pageLoadIncomplete: boolean;
}

/** The navigation itself: `goto` (or reload) until DOMContentLoaded, then the load event within its own timeout. */
async function loadPage(i: VisitInput, s: VisitSpec, t0: number): Promise<Loaded> {
  const loaded: Loaded = { resp: null, pageLoadIncomplete: false };
  try {
    loaded.resp = s.reload
      ? await i.page.reload({ waitUntil: 'domcontentloaded', timeout: i.timing.navigationTimeoutMs })
      : await i.page.goto(s.rawUrl, { waitUntil: 'domcontentloaded', timeout: i.timing.navigationTimeoutMs });
    loaded.domContentLoadedMs = Date.now() - t0;
  } catch (err) {
    loaded.error = firstLine(errorText(err));
  }

  if (!loaded.error) {
    try {
      await i.page.waitForLoadState('load', { timeout: i.timing.loadTimeoutMs });
      loaded.loadMs = Date.now() - t0;
    } catch {
      loaded.pageLoadIncomplete = true;
    }
  }
  return loaded;
}

interface ResponseFacts {
  setCookieNames: string[];
  /** In memory only: challenge detection, `Link` hints and Retry-After read the live values. */
  liveHeaders: HeaderRecord[];
  headers: HeaderRecord[];
  redirectChain: string[];
  serverIp: string | null;
  status: number | null;
  contentType: string;
}

async function readResponse(resp: Response | null, rawUrl: string, bounded: Bounded): Promise<ResponseFacts> {
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
  const liveHeaders: HeaderRecord[] = rawHeaders
    .filter((h) => h.name.toLowerCase() !== 'set-cookie')
    .map((h) => ({ name: h.name.toLowerCase(), value: truncate(h.value, MAX_HEADER_VALUE) }));
  const headers = snapshotResponseHeaders(rawHeaders, resp?.url() ?? rawUrl);

  const redirectChain: string[] = [];
  for (let r = resp?.request().redirectedFrom() ?? null; r; r = r.redirectedFrom()) {
    redirectChain.unshift(sanitizeRequestUrl(r.url()));
  }

  const serverIp = resp
    ? ((await bounded('server-address-timeout', 'server address', resp.serverAddr(), null))?.ipAddress ??
      null)
    : null;

  return {
    setCookieNames,
    liveHeaders,
    headers,
    redirectChain,
    serverIp,
    status: resp?.status() ?? null,
    contentType: liveHeaders.find((h) => h.name === 'content-type')?.value ?? '',
  };
}

interface PageContent {
  dom: PageVisit['dom'];
  candidates: CandidateLink[];
  title: string;
  text: string;
  scripts: string[];
  domError?: string;
  retry?: boolean;
}

function emptyContent(): PageContent {
  return { dom: null, candidates: [], title: '', text: '', scripts: [] };
}

/** DOM facts of the loaded document; a failed read leaves `dom` null and the reason in `domError`. */
async function readContent(
  i: VisitInput,
  liveHeaders: readonly HeaderRecord[],
  limitations: Array<{ code: string; message: string }>,
): Promise<PageContent> {
  try {
    const r = await withTimeout(
      collectDom(i.page, i.target, liveHeaders),
      i.timing.cmpCallTimeoutMs,
      'DOM facts',
    );
    return {
      dom: r.dom,
      candidates: r.candidates,
      title: r.raw.title,
      text: r.raw.textSample,
      scripts: r.raw.scripts.map((x) => x.src).filter(Boolean),
    };
  } catch (err) {
    const domError = pageCallFailure(err);
    if (err instanceof TimeoutError) {
      limitations.push({ code: 'dom-collect-timeout', message: domError });
      return { ...emptyContent(), domError };
    }
    return {
      ...emptyContent(),
      domError,
      retry: /context was destroyed|navigat/i.test(firstLine(errorText(err))),
    };
  }
}

async function readDocument(
  i: VisitInput,
  s: VisitSpec,
  loaded: Loaded,
  navigation: DocumentNavigation,
  bounded: Bounded,
  limitations: Array<{ code: string; message: string }>,
) {
  if (loaded.error) {
    return {
      response: await readResponse(loaded.resp, s.rawUrl, bounded),
      content: emptyContent(),
      rawFinalUrl: s.rawUrl,
    };
  }

  const responseOf = (commit: CommittedResponse) =>
    bounded('response-headers-timeout', 'document response', commit, null);
  for (let attempt = 0; attempt < DOM_READ_ATTEMPTS; attempt++) {
    const commit = navigation.response;
    const resp = commit ? await responseOf(commit) : loaded.resp;
    const response = await readResponse(resp, s.rawUrl, bounded);
    const content = /html|xml|^$/i.test(response.contentType)
      ? await readContent(i, response.liveHeaders, limitations)
      : emptyContent();
    const latest = navigation.response;
    const sameDocument =
      latest === commit ||
      (resp !== null &&
        latest !== null &&
        (await responseOf(latest)) === resp &&
        navigation.response === latest);
    if (sameDocument && (!content.retry || attempt + 1 === DOM_READ_ATTEMPTS)) {
      return { response, content, rawFinalUrl: i.page.url() };
    }
    if (attempt + 1 < DOM_READ_ATTEMPTS) {
      await i.page.waitForLoadState('load', { timeout: i.timing.loadTimeoutMs }).catch(() => undefined);
    }
  }
  return {
    response: await readResponse(null, s.rawUrl, bounded),
    content: { ...emptyContent(), domError: 'execution context destroyed' },
    rawFinalUrl: i.page.url(),
  };
}

function notEvaluableReasonOf(p: {
  error: string | undefined;
  challenge: boolean;
  status: number | null;
  content: PageContent;
}): string | undefined {
  if (p.error) return `navigation-failed:${navigationErrorCode(p.error)}`;
  if (p.challenge) return 'challenge';
  if (p.status !== null && p.status >= 400) return `http-${p.status}`;
  if (p.content.dom === null) return p.content.domError ? 'dom-unavailable' : 'not-html';
  return undefined;
}

export async function visitPage(i: VisitInput, s: VisitSpec): Promise<VisitResult> {
  const startedAt = i.now().toISOString();
  const navigationId = i.recorder.beginNavigation(sanitizeRequestUrl(s.rawUrl));
  const t0 = Date.now();
  const limitations: Array<{ code: string; message: string }> = [];
  /** What is left of HARD_CAP, with a floor: the budget for everything after the navigation. */
  const budgetLeft = () => Math.max(MIN_META_BUDGET_MS, i.phaseTiming.hardCapMs - (Date.now() - t0));
  const bounded: Bounded = async <T>(code: string, what: string, p: Promise<T>, fallback: T): Promise<T> => {
    const ms = budgetLeft();
    const r = await valueWithin(p, ms, i.signal, fallback);
    if (r.cut === 'timeout') limitations.push({ code, message: `${what} not completed within ${ms} ms` });
    return r.value;
  };

  const navigation = documentNavigation(i.page);
  const loaded = await loadPage(i, s, t0);
  let error = loaded.error;

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

  let { response, content, rawFinalUrl } = await readDocument(i, s, loaded, navigation, bounded, limitations);
  if (!error && !/^https?:/i.test(rawFinalUrl)) {
    // The browser ended on its own error page (`chrome-error://`) or left http(s) (a `blob:` or `data:` document the
    // page opened): a failed navigation, nothing read from the page belongs to the site.
    error = `net::${errorCodeOfErrorPage(rawFinalUrl, content.title, content.text)}`;
    rawFinalUrl = s.rawUrl;
    content = { ...emptyContent(), domError: content.domError };
  }
  // Requests of this navigation belong to the page as shown; later ones too until the next navigation.
  if (!error) i.recorder.rebindNavigation(sanitizeRequestUrl(rawFinalUrl));

  const { status } = response;
  const challenge = error
    ? { detected: false, signals: [] }
    : detectChallenge({
        status,
        headers: response.liveHeaders,
        title: content.title,
        text: content.text,
        scripts: content.scripts,
      });
  const notEvaluableReason = notEvaluableReasonOf({ error, challenge: challenge.detected, status, content });

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
      redirectChain: response.redirectChain,
      startedAt,
      ...(loaded.domContentLoadedMs !== undefined ? { domContentLoadedMs: loaded.domContentLoadedMs } : {}),
      ...(loaded.loadMs !== undefined ? { loadMs: loaded.loadMs } : {}),
      quietReached: quiet.quietReached,
      dwellMs: quiet.dwellMs,
      ...(loaded.pageLoadIncomplete ? { pageLoadIncomplete: true } : {}),
      serverIp: response.serverIp,
    },
    responseHeaders: response.headers,
    setCookieNames: response.setCookieNames,
    challenge,
    evaluable: notEvaluableReason === undefined,
    ...(notEvaluableReason ? { notEvaluableReason } : {}),
    dom: content.dom,
  };

  const retry =
    retryAfterMs(response.liveHeaders.find((h) => h.name === 'retry-after')?.value ?? null, Date.now()) ??
    undefined;
  return {
    visit,
    candidates: content.candidates,
    rawFinalUrl,
    contentType: response.contentType,
    ...(error ? { error } : {}),
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
    ...(limitations.length > 0 ? { limitations } : {}),
  };
}
