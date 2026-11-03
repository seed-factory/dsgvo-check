// Navigations under the overload policy (429/503 → pause and one retry, then throttled) and the coverage gaps they
// leave: pages the target host blocked, documents the SSRF guard refused.

import type { PageRole } from '../../../core/snapshot/browser.ts';
import type { BrowserPhase, SanitizedUrl } from '../../../core/snapshot/common.ts';
import type { DiagnosticInput } from '../../../core/snapshot/index.ts';
import { MAX_RETRY_AFTER_MS } from '../../http/client.ts';
import type { BrowserCollection, Session } from '../collector.ts';
import { sleep } from '../util.ts';
import { FALLBACK_PATHS } from './pages.ts';
import { type VisitResult, type VisitSpec, visitPage } from './visit.ts';

export interface BlockedPage {
  page: SanitizedUrl;
  phase: BrowserPhase;
  role: PageRole;
  kind: string;
  status: number | null;
  signals: string[];
  affects: string[];
}

/** Checks whose browser input is incomplete when the target host throttles. */
const BROWSER_CHECKS = [
  'CONSENT-01',
  'CONSENT-02',
  'CONSENT-03',
  'CONSENT-04',
  'CONSENT-05',
  'EMBED-01',
  'EMBED-02',
  'LEGAL-01',
  'PRIV-01',
  'TRACK-01',
];
export const THROTTLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);
const THROTTLE_RESPONSES = 3;

export async function visit(c: BrowserCollection, s: Session, spec: VisitSpec): Promise<VisitResult> {
  await c.pace();
  const r = await visitPage(
    {
      page: s.page,
      recorder: s.recorder,
      timing: c.deps.timing,
      phaseTiming: c.deps.timing.phases[s.phase],
      signal: c.ctx.signal,
      target: {
        etld1: c.scope.etld1 ?? c.ctx.target.etld1,
        host: c.scope.finalHost || c.ctx.target.host,
      },
      now: c.ctx.now,
    },
    spec,
  );
  c.lastNavigationEnd = Date.now();
  s.record.pages.push(r.visit);
  // Facts the page budget cut off stay visible as phase errors; what was gathered before the cut is kept.
  for (const l of r.limitations ?? []) {
    s.record.errors.push({ code: l.code, message: l.message, phase: s.phase, url: r.visit.url });
  }
  // Blocked is decided by the final outcome of the logical navigation (`navigate`), not by this attempt: a repeat may
  // still deliver the page.
  return r;
}

// Check ids that read a page by its role; a role not listed is read by none. The start page of B/C is read by the
// consent checks (phase A's start page is the fatal case, not a gap).
const CHECKS_READING_ROLE: ReadonlyMap<PageRole, readonly string[]> = new Map([
  ['impressum', ['LEGAL-01']],
  ['legal-hop', ['LEGAL-01']],
  ['privacy', ['LEGAL-01', 'PRIV-01']],
  ['contact', ['EMBED-02']],
]);
const CHECKS_READING_START_BC: readonly string[] = ['CONSENT-04', 'CONSENT-05'];

/** A fallback probe stands for the document its path names. */
function fallbackRole(rawUrl: string): PageRole {
  let path = '';
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    // an unparsable URL names no document
  }
  return path === FALLBACK_PATHS.privacy ? 'privacy' : 'impressum';
}

export function blockedAffects(spec: VisitSpec): string[] {
  const role = spec.role === 'fallback' ? fallbackRole(spec.rawUrl) : spec.role;
  if (role === 'start') return spec.phase === 'A' ? [] : [...CHECKS_READING_START_BC];
  return [...(CHECKS_READING_ROLE.get(role) ?? [])];
}

function noteBlocked(c: BrowserCollection, spec: VisitSpec, r: VisitResult): void {
  const v = r.visit;
  // One entry per page and phase, however often the page was navigated to.
  if (c.blockedPages.some((b) => b.page === v.url && b.phase === spec.phase)) return;
  c.blockedPages.push({
    page: v.url,
    phase: spec.phase,
    role: spec.role,
    kind: v.challenge.kind ?? 'other',
    status: v.navigation.status,
    signals: v.challenge.signals,
    affects: blockedAffects(spec),
  });
}

// 429/503 → pause by Retry-After (≤ 30 s) and one retry; still 429/503, or ≥ 3 such responses of the target host in
// this phase → throttled (SCAN-THROTTLED): the phase is partial and no new navigation to the host starts.
export async function navigate(c: BrowserCollection, s: Session, spec: VisitSpec): Promise<VisitResult> {
  let r = await visit(c, s, spec);
  const firstAttempt = r;
  const first = throttleStatus(r);
  let repeated = false;
  if (first !== null && c.timeLeft()) {
    await sleep(Math.min(MAX_RETRY_AFTER_MS, r.retryAfterMs ?? c.deps.timing.retryDelayMs), c.ctx.signal);
    s.record.pages.pop();
    r = await visit(c, s, spec);
    repeated = true;
    const second = throttleStatus(r);
    if (second !== null) markThrottled(c, s, 'navigation', r.visit.url, [first, second]);
  }
  settleBlocked(c, s, spec, repeated ? firstAttempt : null, r);
  checkThrottleResponses(c, s, r.visit.url);
  return r;
}

// SCAN-BLOCKED follows the final outcome of the logical navigation: a page whose final visit is a bot-protection page,
// or whose first attempt was and whose repeat gave no evaluable page, is blocked; one the repeat delivered is not. The
// first attempt's block stays a phase error. The phase-A start page is the fatal case, other pages a gap.
function settleBlocked(
  c: BrowserCollection,
  s: Session,
  spec: VisitSpec,
  firstAttempt: VisitResult | null,
  final: VisitResult,
): void {
  if (spec.role === 'start' && spec.phase === 'A') return;
  const first = firstAttempt?.visit.challenge.detected ? firstAttempt : null;
  if (final.visit.challenge.detected) noteBlocked(c, spec, final);
  else if (first && !final.visit.evaluable) noteBlocked(c, spec, first);
  if (!first) return;
  const v = first.visit;
  const outcome = final.visit.challenge.detected
    ? 'was blocked again'
    : final.visit.evaluable
      ? 'delivered the page'
      : 'gave no evaluable page';
  s.record.errors.push({
    code: `http-${v.navigation.status ?? 0}`,
    message:
      `${spec.role} page: attempt 1 of 2 was answered with a bot-protection page (${v.challenge.kind ?? 'other'}); ` +
      `repeated after the overload pause, attempt 2 ${outcome}`,
    phase: s.phase,
    url: v.url,
  });
}

export function throttleStatus(r: VisitResult): number | null {
  const status = r.visit.navigation.status;
  return !r.error && status !== null && THROTTLE_STATUSES.has(status) ? status : null;
}

function isTargetHost(c: BrowserCollection, host: string): boolean {
  const h = host.toLowerCase();
  const finalHost = c.scope.finalHost || c.ctx.target.host;
  return h === finalHost || h === c.ctx.target.host || h === `www.${finalHost}` || `www.${h}` === finalHost;
}

export function checkThrottleResponses(c: BrowserCollection, s: Session, url: SanitizedUrl): void {
  if (c.throttled) return;
  const statuses = s.recorder.records
    .filter((r) => r.status !== undefined && THROTTLE_STATUSES.has(r.status) && isTargetHost(c, r.host))
    .map((r) => r.status as number);
  if (statuses.length >= THROTTLE_RESPONSES) markThrottled(c, s, 'responses', url, statuses);
}

export function markThrottled(
  c: BrowserCollection,
  s: Session,
  scope: 'navigation' | 'responses',
  url: SanitizedUrl,
  statuses: number[],
): void {
  s.record.status = 'partial';
  s.record.reason = 'throttled';
  c.stoppedEarly ??= 'throttled';
  if (c.throttled) return;
  c.throttled = true;
  c.ctx.log.warn(`target host throttles (${statuses.join(', ')}); no further navigation to it`);
  c.diagnostics.push({
    code: 'SCAN-THROTTLED',
    affects: [...BROWSER_CHECKS],
    params: { phase: s.phase, scope, url, statuses: statuses.slice(0, 10).join(',') },
  });
}

/** One diagnostic for all pages the target host blocked (the phase-A start page is fatal instead). */
export function blockedDiagnostic(c: BrowserCollection): DiagnosticInput | null {
  if (c.blockedPages.length === 0) return null;
  const unique = (xs: readonly string[]) => [...new Set(xs)];
  const urls = unique(c.blockedPages.map((b) => b.page));
  return {
    code: 'SCAN-BLOCKED',
    affects: unique(c.blockedPages.flatMap((b) => b.affects)).sort(),
    params: {
      scope: 'subpage',
      count: urls.length,
      page: urls[0] as string,
      pages: urls.slice(0, 5).join(', '),
      phase: unique(c.blockedPages.map((b) => b.phase)).join(','),
      kind: unique(c.blockedPages.map((b) => b.kind)).join(','),
      signals: unique(c.blockedPages.flatMap((b) => b.signals))
        .slice(0, 10)
        .join(', '),
    },
  };
}

// Address classes, and the resolver error for names that did not resolve. Only refusals that left a document unfetched
// count; those a repeat made good are named in `recovered`, and give no diagnostic when all were made good.
export function privateBlockedDiagnostic(c: BrowserCollection): DiagnosticInput | null {
  const verdicts = [...c.guardVerdicts];
  for (const v of c.guardRecovered) {
    const i = verdicts.indexOf(v);
    if (i >= 0) verdicts.splice(i, 1);
  }
  const blocked = c.guard.blocked - c.guardRecovered.length;
  if (blocked <= 0) return null;
  const unresolved = verdicts.filter((v) => v === 'unresolved').length;
  const codes = [...new Set(c.lookupErrors.map((e) => e.code))].sort();
  const first = c.lookupErrors[0];
  return {
    code: 'SCAN-PRIVATE-REQUEST-BLOCKED',
    affects: [],
    params: {
      count: blocked,
      addressClass: [...new Set(verdicts)].sort().join(', '),
      unresolved,
      nonPublic: Math.max(0, blocked - unresolved),
      hasLookupCodes: codes.length > 0,
      ...(codes.length > 0 ? { lookupCodes: codes.join(', ') } : {}),
      ...(first ? { lookupFirstAtMs: first.atMs } : {}),
      ...(c.guardRecovered.length > 0 ? { recovered: c.guardRecovered.length } : {}),
    },
  };
}
