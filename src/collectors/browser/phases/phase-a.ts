// Phase A: the start page (one repeat of a failed first navigation, fatal start-page conditions), then up to `maxPages`
// pages without interaction (legal documents, contact page, extras from links or the sitemap) and the choice of control
// pages for B and C.

import { TOOL_NAME } from '../../../core/runtime/version.ts';
import { registrableDomain } from '../../../core/url/url.ts';
import { MAX_RETRY_AFTER_MS } from '../../http/client.ts';
import type { AVisit, BrowserCollection, PhaseAOutcome, Session } from '../collector.ts';
import { fetchText } from '../launch/http-fetch.ts';
import { loadLegalLexicon } from '../legal/lexicon-file.ts';
import { PageQueue, type QueueItem, recordDocument } from '../legal/queue.ts';
import { checkThrottleResponses, markThrottled, navigate, throttleStatus, visit } from '../pages/navigate.ts';
import {
  chooseControlPages,
  findLegalLink,
  LEGAL_KINDS,
  type LegalKind,
  pageKey,
  selectPages,
} from '../pages/pages.ts';
import { parseRobots, parseSitemap, type Robots } from '../pages/robots.ts';
import { navigationErrorCode, type VisitResult, type VisitSpec } from '../pages/visit.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { sleep, withTimeout } from '../util.ts';

/** Only an upper bound: leaving a failed start navigation takes milliseconds. */
const LEAVE_NAVIGATION_TIMEOUT_MS = 3_000;

export async function phaseA(c: BrowserCollection): Promise<PhaseAOutcome> {
  const s = await c.openPhase('A');
  try {
    return await phaseABody(c, s);
  } finally {
    if (c.current === s.browser) await c.closePhase(s);
  }
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
  const status = r.visit.navigation.status;
  // A timeout or 5xx of the start page counts only when it happens twice, so the first failure gets one more attempt.
  // Not repeated: certificate errors and a request the scanner refused.
  const retryable = r.error
    ? !/^ERR_(CERT|SSL|BLOCKED)/.test(navigationErrorCode(r.error))
    : status !== null && (status >= 500 || status === 429);
  if (retryable && c.timeLeft()) {
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

// A navigation without a committed document still counts as the page's navigation for Chromium: a `goto` to the same
// URL ends at once with `ERR_ABORTED`. Leaving for `about:blank` makes the repeat a new navigation. Best effort.
async function leaveFailedNavigation(s: Session): Promise<void> {
  await withTimeout(
    s.page.goto('about:blank', { waitUntil: 'commit', timeout: LEAVE_NAVIGATION_TIMEOUT_MS }),
    LEAVE_NAVIGATION_TIMEOUT_MS + 1_000,
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
  const code = failed.error
    ? navigationErrorCode(failed.error) === 'timeout'
      ? 'navigation-timeout'
      : navigationErrorCode(failed.error)
    : `http-${failed.visit.navigation.status ?? 0}`;
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

function startFatal(c: BrowserCollection, r: VisitResult): PhaseAOutcome | null {
  if (r.error) {
    const code = navigationErrorCode(r.error);
    if (/^ERR_(CERT|SSL)/.test(code)) return { kind: 'tls-blocked' };
    if (code === 'ERR_BLOCKED_BY_CLIENT' && c.guard.blocked > 0) {
      // Word it by the facts: a redirect only when the refused document is on another host.
      const redirected = [...c.guardBlockedHosts].some((h) => h !== c.ctx.target.host.toLowerCase());
      // Refused because the name does not resolve locally: the target is unreachable, not "not public".
      if (c.guardVerdicts.every((v) => v === 'unresolved')) {
        return {
          kind: 'fatal',
          fatal: {
            reason: 'unreachable',
            code: 'start-page-unresolved',
            params: { redirected: redirected ? 'yes' : 'no' },
          },
        };
      }
      return {
        kind: 'fatal',
        fatal: {
          reason: 'invalid-input',
          code: 'start-page-not-public',
          params: { redirected: redirected ? 'yes' : 'no' },
        },
      };
    }
    return {
      kind: 'fatal',
      fatal: {
        reason: 'unreachable',
        code: 'start-page-unreachable',
        params: { reason: code },
      },
    };
  }
  // 429 after the retry is throttling, not a fatal.
  const status = r.visit.navigation.status ?? 0;
  if (status >= 500) {
    return {
      kind: 'fatal',
      fatal: {
        reason: 'unreachable',
        code: 'start-page-5xx',
        params: { status },
      },
    };
  }
  if (r.visit.challenge.detected) {
    return {
      kind: 'fatal',
      fatal: {
        reason: 'blocked',
        code: 'start-page-blocked',
        params: { signals: r.visit.challenge.signals.join(', ') },
      },
    };
  }
  return null;
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
  c.startRaw = start.rawFinalUrl;
  const finalHost = new URL(c.startRaw).hostname.toLowerCase();
  c.scope = { finalHost, etld1: registrableDomain(finalHost) };
  s.jar = c.newJar(s.recorder, { etld1: c.scope.etld1, host: finalHost }, s.record);
  await c.afterPage(s, start, 'first-screen');
  c.aVisits.push({ raw: c.startRaw, result: start, source: 'start' });
  const visited = new Set<string>([pageKey(c.ctx.target.url), pageKey(c.startRaw)]);
  c.plan.pages.push({
    url: sanitizeRequestUrl(c.startRaw),
    role: 'start',
    order: 0,
    reasons: start.visit.navigation.redirectChain.length > 0 ? ['start', 'after-redirects'] : ['start'],
    source: 'start',
  });
  if (throttleStatus(start) === 429) markThrottled(c, s, 'navigation', start.visit.url, startStatuses);
  checkThrottleResponses(c, s, start.visit.url);
  // Throttled start page: no probes, no subpages (no new request to the host); B and C are skipped.
  if (c.throttled) return { kind: 'ok' };

  const origin = new URL(c.startRaw).origin;
  const robots = await fetchRobots(c, origin);
  const scopeArgs = { startRaw: c.startRaw, finalHost, etld1: c.scope.etld1 };
  const selectArgs = {
    links: start.candidates,
    ...scopeArgs,
    maxPages: c.ctx.options.maxPages,
    robots,
    token: TOOL_NAME,
  };
  let sel = selectPages({ ...selectArgs, sitemapLocs: [] });
  if (sel.extras.length < sel.extrasWanted) {
    const locs = await fetchSitemapLocs(c, origin, robots);
    if (locs.length > 0) sel = selectPages({ ...selectArgs, sitemapLocs: locs });
  }

  const queue = new PageQueue(visited, c.documents, scopeArgs);
  queue.handleLink(sel.impressum, 'link', null, start.candidates);
  queue.handleLink(sel.privacy, 'link', null, start.candidates);
  if (sel.contact) queue.items.push({ choice: sel.contact });
  for (const h of sel.hops) queue.items.push({ choice: h, hop: true });
  for (const e of sel.extras) queue.items.push({ choice: e, extra: true });

  let order = 1;
  while (queue.items.length > 0) {
    const item = queue.items.shift() as QueueItem;
    if (c.throttled) break;
    if (!c.timeLeft()) {
      c.cutByTime(s.record);
      break;
    }
    if (c.counter.truncated) {
      s.record.status = 'partial';
      s.record.reason = 'request-cap';
      break;
    }
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
    if (item.docKind) {
      const doc = await recordDocument(c, s, r, item.docKind, item.choice.url, item.foundVia ?? 'link');
      if (doc === 'found') queue.found[item.docKind] = true;
      else if (doc === 'unconfirmed') queue.tryNextCandidate(item);
      for (const kind of item.alsoKinds ?? []) {
        const also = await recordDocument(c, s, r, kind, item.choice.url, item.foundVia ?? 'link');
        if (also === 'found') queue.found[kind] = true;
        else if (also === 'unconfirmed') queue.tryNextCandidate({ ...item, docKind: kind });
      }
    }
    if (item.choice.role === 'contact' || item.hop) {
      for (const kind of LEGAL_KINDS) {
        if (queue.found[kind] || queue.pending(kind)) continue;
        const lr = findLegalLink(r.candidates, kind, scopeArgs);
        if (lr.status === 'page' || lr.status === 'pdf')
          queue.handleLink(lr, 'hop', item.choice.role, r.candidates);
        else
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

  await probeFallbacks(c, s, origin, visited, queue.found, order);
  chooseControl(c, s);
  return { kind: 'ok' };
}

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

/** Evaluable subpages of phase A, chosen by their third-party signals. */
function chooseControl(c: BrowserCollection, s: Session): void {
  c.control = chooseControlPages(
    c.aVisits
      .filter((v) => v.source !== 'start' && v.source !== 'fallback' && v.result.visit.evaluable)
      .map((v) => ({
        raw: v.raw,
        url: v.result.visit.url,
        role: v.result.visit.role,
        order: v.result.visit.order,
        signals: signalsOf(c, v, s),
      })),
  );
  c.plan.controlPages = c.control.map((page, i) => ({
    url: page.url,
    role: page.role,
    order: i + 1,
    reasons: page.reasons,
    source: c.aVisits.find((v) => v.raw === page.raw)?.source ?? 'link',
  }));
}

function signalsOf(c: BrowserCollection, v: AVisit, s: Session) {
  const etld1 = c.scope.etld1;
  const thirdParty = (url: string | null) => {
    if (!url) return false;
    try {
      return registrableDomain(new URL(url).hostname) !== etld1;
    } catch {
      return false;
    }
  };
  const dom = v.result.visit.dom;
  const startUrl = sanitizeRequestUrl(c.startRaw);
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

async function fetchRobots(c: BrowserCollection, origin: string): Promise<Robots | null> {
  const url = `${origin}/robots.txt`;
  c.probes.push({ kind: 'http', class: 'T', target: url, purpose: 'robots.txt' });
  const res = await fetchText(url, c.ctx.network, c.ctx.userAgent.http, {
    timeoutMs: c.ctx.config.browser.sourceFetchTimeoutMs,
    maxBytes: 256 * 1024,
    signal: c.ctx.signal,
  });
  if (!res || res.status >= 400 || /html/i.test(res.contentType)) return res ? parseRobots('') : null;
  return parseRobots(res.text);
}

async function fetchSitemapLocs(
  c: BrowserCollection,
  origin: string,
  robots: Robots | null,
): Promise<string[]> {
  const first = robots?.sitemaps.find((u) => u.startsWith(origin)) ?? `${origin}/sitemap.xml`;
  const get = async (url: string) => {
    c.probes.push({ kind: 'http', class: 'T', target: sanitizeRequestUrl(url), purpose: 'sitemap' });
    await sleep(c.ctx.config.http.minIntervalMs, c.ctx.signal);
    const res = await fetchText(url, c.ctx.network, c.ctx.userAgent.http, {
      timeoutMs: c.ctx.config.browser.sourceFetchTimeoutMs,
      maxBytes: 512 * 1024,
      signal: c.ctx.signal,
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
