// Phase A: the start page (one repeat of a failed first navigation, fatal start-page conditions), then up to `maxPages`
// pages without interaction (legal documents, contact page, extras from links or the sitemap) and the choice of control
// pages for B and C.

import { TOOL_NAME } from '../../../core/runtime/version.ts';
import type { FatalSignal } from '../../../core/snapshot/collector.ts';
import { registrableDomain } from '../../../core/url/url.ts';
import { loadServiceCatalog } from '../../../derive/catalog.ts';
import { MAX_RETRY_AFTER_MS } from '../../http/pacing.ts';
import type { BrowserCollection, PhaseAOutcome, Session } from '../collector.ts';
import { fetchText } from '../launch/http-fetch.ts';
import { loadLegalLexicon } from '../legal/lexicon-file.ts';
import {
  dropCandidatesIfFound,
  PageQueue,
  type QueueItem,
  readImpressumDetails,
  recordDocument,
} from '../legal/queue.ts';
import { checkThrottleResponses, markThrottled, navigate, throttleStatus, visit } from '../pages/navigate.ts';
import {
  catalogCategoryOf,
  chooseControlPages,
  controlSignals,
  findLegalLink,
  LEGAL_KINDS,
  type LegalKind,
  type PageSelection,
  pageKey,
  type Scope,
  selectPages,
} from '../pages/pages.ts';
import { parseRobots, parseSitemap, type Robots } from '../pages/robots.ts';
import { navigationErrorCode, type VisitResult, type VisitSpec } from '../pages/visit.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { sleep, withTimeout } from '../util.ts';

/** Only an upper bound: leaving a failed start navigation takes milliseconds. */
const LEAVE_NAVIGATION_TIMEOUT_MS = 3_000;
/** The outer timer fires after Playwright's own, so it only catches a call that hangs. */
const LEAVE_NAVIGATION_GRACE_MS = 1_000;

/** Larger answers are cut off: both files are small text. */
const ROBOTS_MAX_BYTES = 256 * 1024;
const SITEMAP_MAX_BYTES = 512 * 1024;
/** Large sitemaps list thousands of URLs; page selection needs only a few of them. */
const SITEMAP_MAX_LOCS = 500;

export async function phaseA(c: BrowserCollection): Promise<PhaseAOutcome> {
  const s = await c.openPhase('A');
  try {
    return await phaseABody(c, s);
  } finally {
    if (c.current === s.browser) await c.closePhase(s);
  }
}

async function phaseABody(c: BrowserCollection, s: Session): Promise<PhaseAOutcome> {
  const { r: start, statuses: startStatuses } = await visitStart(c, s);
  if (c.ctx.signal.aborted) return { kind: 'ok' }; // run() reports the abort

  const fatal = startFatal(c, start);
  if (fatal) {
    if (fatal.kind === 'tls-blocked') {
      // Do not keep a phase record for a site the browser cannot open; the orchestrator skips checks.
      await s.browser.close();
      c.current = null;
      c.session = null;
    }
    return fatal;
  }

  const visited = await adoptStartPage(c, s, start, startStatuses);
  // Throttled start page: no probes, no subpages (no new request to the host); B and C are skipped.
  if (c.throttled) return { kind: 'ok' };

  const origin = new URL(c.startRaw).origin;
  const robots = await fetchRobots(c, origin);
  const scope: Scope = { startRaw: c.startRaw, finalHost: c.scope.finalHost, etld1: c.scope.etld1 };
  const selection = await selectSubpages(c, start, origin, robots, scope);
  const queue = queueSelection(c, selection, start, visited, scope);
  // The start page is still open: without an Impressum link it is read for Impressum details before the queue leaves it.
  if (selection.impressum.status === 'none') await readImpressumDetails(c, s, start, false);

  const order = await visitQueue(c, s, queue, visited, scope);
  await probeFallbacks(c, s, origin, visited, queue.found, order);
  dropCandidatesIfFound(c.documents);
  chooseControl(c, s);
  return { kind: 'ok' };
}

async function visitStart(c: BrowserCollection, s: Session): Promise<{ r: VisitResult; statuses: number[] }> {
  const spec: VisitSpec = {
    rawUrl: c.ctx.target.url,
    role: 'start',
    order: 0,
    phase: 'A',
    firstVisit: true,
  };

  const t0 = Date.now();
  let r = await visit(c, s, spec);
  const failedAfterMs = Date.now() - t0;
  const statuses = [r.visit.navigation.status ?? 0];

  if (isRetryableStartFailure(r) && c.timeLeft()) {
    const pauseMs = Math.min(MAX_RETRY_AFTER_MS, r.retryAfterMs ?? c.timing.retryDelayMs);
    // The repeat replaces the failed attempt's visit, so its trace is kept as a phase error before the pause (the pause
    // may hit the global deadline).
    noteStartRetry(c, s, r, failedAfterMs, pauseMs);
    await sleep(pauseMs, c.ctx.signal);
    if (r.error) await leaveFailedNavigation(s);
    s.record.pages.pop();
    r = await visit(c, s, spec);
    statuses.push(r.visit.navigation.status ?? 0);
  }
  return { r, statuses };
}

// A timeout or 5xx of the start page counts only when it happens twice, so the first failure gets one more attempt.
// Not repeated: certificate errors and a request the scanner refused.
function isRetryableStartFailure(r: VisitResult): boolean {
  if (r.error) return !/^ERR_(CERT|SSL|BLOCKED)/.test(navigationErrorCode(r.error));
  const status = r.visit.navigation.status;
  return status !== null && (status >= 500 || status === 429);
}

// A navigation without a committed document still counts as the page's navigation for Chromium: a `goto` to the same
// URL ends at once with `ERR_ABORTED`. Leaving for `about:blank` makes the repeat a new navigation. Best effort.
async function leaveFailedNavigation(s: Session): Promise<void> {
  await withTimeout(
    s.page.goto('about:blank', { waitUntil: 'commit', timeout: LEAVE_NAVIGATION_TIMEOUT_MS }),
    LEAVE_NAVIGATION_TIMEOUT_MS + LEAVE_NAVIGATION_GRACE_MS,
    'leave the failed navigation',
  ).catch(() => undefined);
}

// The failed first navigation is a fact of the scan: the phase entry carries the failure code, attempt, duration, pause
// and navigation id; the attempt's requests stay in the phase.
function noteStartRetry(
  c: BrowserCollection,
  s: Session,
  failed: VisitResult,
  afterMs: number,
  pauseMs: number,
): void {
  const code = startFailureCode(failed);
  const id = failed.visit.navigationId;

  c.ctx.log.warn(
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

function startFailureCode(failed: VisitResult): string {
  if (!failed.error) return `http-${failed.visit.navigation.status ?? 0}`;
  const code = navigationErrorCode(failed.error);
  return code === 'timeout' ? 'navigation-timeout' : code;
}

function startFatal(c: BrowserCollection, r: VisitResult): PhaseAOutcome | null {
  if (r.error) return failedStartNavigation(c, navigationErrorCode(r.error));

  // 429 after the retry is throttling, not a fatal.
  const status = r.visit.navigation.status ?? 0;
  if (status >= 500) return fatalStart('unreachable', 'start-page-5xx', { status });
  if (r.visit.challenge.detected) {
    return fatalStart('blocked', 'start-page-blocked', { signals: r.visit.challenge.signals.join(', ') });
  }
  return null;
}

function failedStartNavigation(c: BrowserCollection, code: string): PhaseAOutcome {
  if (/^ERR_(CERT|SSL)/.test(code)) return { kind: 'tls-blocked' };

  if (code === 'ERR_BLOCKED_BY_CLIENT' && c.guard.blocked > 0) {
    // Word it by the facts: a redirect only when the refused document is on another host.
    const redirected = [...c.guardBlockedHosts].some((h) => h !== c.ctx.target.host.toLowerCase());
    const params = { redirected: redirected ? 'yes' : 'no' };
    // Refused because the name does not resolve locally: the target is unreachable, not "not public".
    if (c.guardVerdicts.every((v) => v === 'unresolved')) {
      return fatalStart('unreachable', 'start-page-unresolved', params);
    }
    return fatalStart('invalid-input', 'start-page-not-public', params);
  }

  return fatalStart('unreachable', 'start-page-unreachable', { reason: code });
}

function fatalStart(
  reason: FatalSignal['reason'],
  code: string,
  params: NonNullable<FatalSignal['params']>,
): PhaseAOutcome {
  return { kind: 'fatal', fatal: { reason, code, params } };
}

/** The final start page becomes the reference of the scan: its host is the scope, its facts are recorded. */
async function adoptStartPage(
  c: BrowserCollection,
  s: Session,
  start: VisitResult,
  startStatuses: number[],
): Promise<Set<string>> {
  c.startRaw = start.rawFinalUrl;
  const finalHost = new URL(c.startRaw).hostname.toLowerCase();
  c.scope = { finalHost, etld1: registrableDomain(finalHost) };
  s.jar = c.newJar(s.recorder, { etld1: c.scope.etld1, host: finalHost }, s.record);

  await c.afterPage(s, start, 'first-screen');
  c.aVisits.push({ raw: c.startRaw, result: start, source: 'start' });
  c.plan.pages.push({
    url: sanitizeRequestUrl(c.startRaw),
    role: 'start',
    order: 0,
    reasons: start.visit.navigation.redirectChain.length > 0 ? ['start', 'after-redirects'] : ['start'],
    source: 'start',
  });

  if (throttleStatus(start) === 429) markThrottled(c, s, 'navigation', start.visit.url, startStatuses);
  checkThrottleResponses(c, s, start.visit.url);

  return new Set<string>([pageKey(c.ctx.target.url), pageKey(c.startRaw)]);
}

/** Pages to visit from the start page's links; the sitemap fills up when the links give too few extras. */
async function selectSubpages(
  c: BrowserCollection,
  start: VisitResult,
  origin: string,
  robots: Robots | null,
  scope: Scope,
): Promise<PageSelection> {
  const lang = start.visit.dom?.lang;
  const selectArgs = {
    links: start.candidates,
    ...scope,
    ...(lang ? { startLang: lang } : {}),
    maxPages: c.ctx.options.maxPages,
    robots,
    token: TOOL_NAME,
  };
  const fromLinks = selectPages({ ...selectArgs, sitemapLocs: [] });
  if (fromLinks.extras.length >= fromLinks.extrasWanted) return fromLinks;

  const locs = await fetchSitemapLocs(c, origin, robots);
  return locs.length > 0 ? selectPages({ ...selectArgs, sitemapLocs: locs }) : fromLinks;
}

function queueSelection(
  c: BrowserCollection,
  sel: PageSelection,
  start: VisitResult,
  visited: Set<string>,
  scope: Scope,
): PageQueue {
  const queue = new PageQueue(visited, c.documents, scope);
  queue.handleLink(sel.impressum, 'link', null, start.candidates);
  queue.handleLink(sel.privacy, 'link', null, start.candidates);
  if (sel.contact) queue.items.push({ choice: sel.contact });
  for (const h of sel.hops) queue.items.push({ choice: h, hop: true });
  for (const e of sel.extras) queue.items.push({ choice: e, extra: true });
  return queue;
}

/** Visits the queued pages until the queue is empty or a limit cuts it; returns the order number of the next page. */
async function visitQueue(
  c: BrowserCollection,
  s: Session,
  queue: PageQueue,
  visited: Set<string>,
  scope: Scope,
): Promise<number> {
  let order = 1;
  while (queue.items.length > 0) {
    const item = queue.items.shift() as QueueItem;
    if (queueCut(c, s)) break;

    // --max-pages counts every page of phase A; legal pages and legal hops are visited regardless.
    const budgeted = !item.docKind && !item.hop;
    if (budgeted && s.record.pages.length >= c.ctx.options.maxPages) continue;
    if (visited.has(pageKey(item.choice.raw))) continue;
    visited.add(pageKey(item.choice.raw));

    const r = await navigate(c, s, {
      rawUrl: item.choice.raw,
      role: item.choice.role,
      order,
      phase: 'A',
      firstVisit: false,
    });
    visited.add(pageKey(r.rawFinalUrl));
    c.plan.pages.push({
      url: item.choice.url,
      role: item.choice.role,
      order,
      reasons: item.choice.reasons,
      source: item.choice.source,
      ...(item.choice.robotsAllowed !== undefined ? { robotsAllowed: item.choice.robotsAllowed } : {}),
    });
    order++;
    await c.afterPage(s, r, 'first-screen');
    c.aVisits.push({ raw: item.choice.raw, result: r, source: item.choice.source });

    await recordQueuedDocuments(c, s, queue, item, r);
    if (item.choice.role === 'contact' || item.hop) await lookForLegalLinks(c, s, queue, item, r, scope);
  }
  return order;
}

/** A limit that ends the queue; the phase record says why it is incomplete. */
function queueCut(c: BrowserCollection, s: Session): boolean {
  if (c.throttled) return true;
  if (!c.timeLeft()) {
    c.cutByTime(s.record);
    return true;
  }
  if (c.counter.truncated) {
    s.record.status = 'partial';
    s.record.reason = 'request-cap';
    return true;
  }
  return false;
}

/** Reads the page for the legal kind it was queued for; a combined legal page is read once per kind. */
async function recordQueuedDocuments(
  c: BrowserCollection,
  s: Session,
  queue: PageQueue,
  item: QueueItem,
  r: VisitResult,
): Promise<void> {
  if (!item.docKind) return;
  const via = item.foundVia ?? 'link';

  const doc = await recordDocument(c, s, r, item.docKind, item.choice.url, via);
  if (doc === 'found') queue.found[item.docKind] = true;
  else if (doc === 'unconfirmed') queue.tryNextCandidate(item);

  for (const kind of item.alsoKinds ?? []) {
    const also = await recordDocument(c, s, r, kind, item.choice.url, via);
    if (also === 'found') queue.found[kind] = true;
    else if (also === 'unconfirmed') queue.tryNextCandidate({ ...item, docKind: kind });
  }
}

/**
 * On the contact page and on hops: the legal links not found yet are queued, a missing link is a recorded attempt.
 * Without an Impressum link the page itself is read for the Impressum, unless it was already read as one. It can only
 * become the Impressum while no link of the site was tried for it: a broken or unconfirmed link keeps its verdict.
 */
async function lookForLegalLinks(
  c: BrowserCollection,
  s: Session,
  queue: PageQueue,
  item: QueueItem,
  r: VisitResult,
  scope: Scope,
): Promise<void> {
  const readAsImpressum = item.docKind === 'impressum' || item.alsoKinds?.includes('impressum') === true;
  for (const kind of LEGAL_KINDS) {
    if (queue.found[kind] || queue.pending(kind)) continue;

    const lr = findLegalLink(r.candidates, kind, scope);
    if (lr.status === 'page' || lr.status === 'pdf') {
      queue.handleLink(lr, 'hop', item.choice.role, r.candidates);
    } else if (
      kind === 'impressum' &&
      lr.status === 'none' &&
      !readAsImpressum &&
      (await readImpressumDetails(c, s, r, !impressumLinkTried(c))) === 'found'
    ) {
      queue.found.impressum = true;
    } else {
      c.documents.attempts.push({
        kind,
        via: 'hop',
        url: r.visit.url,
        status: r.visit.navigation.status,
        outcome: 'not-found',
      });
    }
  }
}

const impressumLinkTried = (c: BrowserCollection): boolean =>
  c.documents.attempts.some((a) => a.kind === 'impressum' && a.via === 'link');

/** One GET of the conventional path per legal kind that was not found by link. */
async function probeFallbacks(
  c: BrowserCollection,
  s: Session,
  origin: string,
  visited: Set<string>,
  found: Record<LegalKind, boolean>,
  order: number,
): Promise<void> {
  for (const kind of LEGAL_KINDS) {
    if (found[kind] || c.throttled) continue;
    if (!c.timeLeft()) {
      // A fallback probe that was not made leaves phase A unfinished, like a cut queue.
      if (s.record.status === 'completed') c.cutByTime(s.record);
      break;
    }

    const path = loadLegalLexicon().fallbackPaths[kind];
    const raw = new URL(path, origin).toString();
    if (visited.has(pageKey(raw))) continue;
    visited.add(pageKey(raw));

    const r = await navigate(c, s, {
      rawUrl: raw,
      role: 'fallback',
      order,
      phase: 'A',
      firstVisit: false,
    });
    c.plan.pages.push({
      url: sanitizeRequestUrl(raw),
      role: 'fallback',
      order,
      reasons: [`fallback:${path}`],
      source: 'fallback',
    });
    order++;
    await c.afterPage(s, r, 'first-screen');
    c.aVisits.push({ raw, result: r, source: 'fallback' });
    await recordDocument(c, s, r, kind, sanitizeRequestUrl(raw), 'fallback');
  }
}

/**
 * Evaluable subpages of phase A, chosen by their third-party signals. B and C click on the start page, so pages of its
 * origin come first: a consent cookie set for that host does not reach another one.
 */
function chooseControl(c: BrowserCollection, s: Session): void {
  const categoryOf = catalogCategoryOf(loadServiceCatalog());
  const requestsOn = (pageUrl: string) =>
    s.recorder.records.filter((r) => r.pageUrl === pageUrl).map((r) => ({ url: r.url, host: r.host }));
  const startRequests = requestsOn(sanitizeRequestUrl(c.startRaw));

  c.control = chooseControlPages(
    c.aVisits
      .filter((v) => v.source !== 'start' && v.source !== 'fallback' && v.result.visit.evaluable)
      .map((v) => {
        const visit = v.result.visit;
        const facts = {
          iframes: visit.dom?.iframes ?? [],
          placeholders: visit.dom?.embedPlaceholders?.length ?? 0,
          requests: requestsOn(visit.finalUrl),
          startRequests,
        };
        return {
          raw: v.raw,
          url: visit.url,
          finalUrl: visit.finalUrl,
          role: visit.role,
          order: visit.order,
          signals: controlSignals(facts, c.scope.etld1, categoryOf),
        };
      }),
    { max: c.ctx.config.browser.maxControlPages, clickOrigin: new URL(c.startRaw).origin },
  );
  c.plan.controlPages = c.control.map((page, i) => ({
    url: page.url,
    role: page.role,
    order: i + 1,
    reasons: page.reasons,
    source: c.aVisits.find((v) => v.raw === page.raw)?.source ?? 'link',
  }));
}

async function fetchRobots(c: BrowserCollection, origin: string): Promise<Robots | null> {
  const url = `${origin}/robots.txt`;
  c.probes.push({ kind: 'http', class: 'T', target: url, purpose: 'robots.txt' });

  const res = await fetchText(url, c.ctx.network, c.ctx.userAgent.http, {
    timeoutMs: c.ctx.config.browser.sourceFetchTimeoutMs,
    maxBytes: ROBOTS_MAX_BYTES,
    signal: c.ctx.signal,
  });

  if (!res || res.status >= 400 || /html/i.test(res.contentType)) return res ? parseRobots('') : null;
  return parseRobots(res.text);
}

/** The sitemap named in robots.txt (else `/sitemap.xml`); an index is followed one level into its first child. */
async function fetchSitemapLocs(
  c: BrowserCollection,
  origin: string,
  robots: Robots | null,
): Promise<string[]> {
  const get = async (url: string) => {
    c.probes.push({ kind: 'http', class: 'T', target: sanitizeRequestUrl(url), purpose: 'sitemap' });
    await sleep(c.ctx.config.http.minIntervalMs, c.ctx.signal);
    const res = await fetchText(url, c.ctx.network, c.ctx.userAgent.http, {
      timeoutMs: c.ctx.config.browser.sourceFetchTimeoutMs,
      maxBytes: SITEMAP_MAX_BYTES,
      signal: c.ctx.signal,
    });
    return res && res.status < 400 ? parseSitemap(res.text) : null;
  };

  const first = robots?.sitemaps.find((u) => u.startsWith(origin)) ?? `${origin}/sitemap.xml`;
  const sm = await get(first);
  if (!sm) return [];
  if (sm.kind === 'urlset') return sm.locs.slice(0, SITEMAP_MAX_LOCS);

  const child = sm.locs.find((u) => u.startsWith(origin));
  if (!child) return [];
  const sub = await get(child);
  return sub?.kind === 'urlset' ? sub.locs.slice(0, SITEMAP_MAX_LOCS) : [];
}
