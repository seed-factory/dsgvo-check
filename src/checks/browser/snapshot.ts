/** Lookups into the browser section: phases, pages, requests, and records joined with their classification. */
import type { BrowserPhase, CheckOutcome } from '../../core/api.ts';
import type {
  BrowserSection,
  CookieRecord,
  PageVisit,
  RequestRecord,
  StorageRecord,
} from '../../core/snapshot/browser.ts';
import type { ClassifiedCookie, ClassifiedStorage, DerivedSection } from '../../derive/types.ts';
import { sortedUniq } from './lists.ts';

export function phaseRecord(browser: BrowserSection, phase: BrowserPhase) {
  return browser.phases.find((p) => p.phase === phase);
}

/** Phase A has an evaluable page; a lone 429/503 or challenge page is no observation. */
export function hasPhaseA(browser: BrowserSection): boolean {
  const a = phaseRecord(browser, 'A');
  return !!a && a.status !== 'skipped' && a.pages.some((p) => p.evaluable);
}

/** Reason for a missing phase-A basis: `throttled` when the collector stopped on 429/503, else `fallback`. */
export function noPhaseAReason(browser: BrowserSection, fallback: string): string {
  return phaseRecord(browser, 'A')?.reason === 'throttled' ? 'throttled' : fallback;
}

/** Throttling stopped navigations in one of `phases`: `completed` becomes `partial` with limitation `throttled`. */
export function throttleAware(
  browser: BrowserSection,
  outcome: CheckOutcome,
  phases: readonly BrowserPhase[] = ['A', 'B', 'C'],
): CheckOutcome {
  const throttled = browser.phases.some((p) => phases.includes(p.phase) && p.reason === 'throttled');
  if (!throttled || outcome.status !== 'completed') return outcome;
  return {
    ...outcome,
    status: 'partial',
    limitations: sortedUniq([...(outcome.limitations ?? []), 'throttled']),
  };
}

/**
 * A page of `phases` was taller than the largest viewport the collector may set to show what lies below the first
 * screen: embeds further down may not have loaded.
 */
export function revealCapped(browser: BrowserSection, phases: readonly BrowserPhase[]): boolean {
  return browser.phases.some(
    (p) => phases.includes(p.phase) && p.pages.some((v) => v.reveal?.capped === true),
  );
}

/**
 * The request limit of the browser was reached, and possibly before phase C: the collector starts phase C only while
 * the limit is not reached, so only a phase C that started shows that phases A and B recorded every request. A skipped
 * phase C never started, whatever its reason: `cmp-not-recognized` is written after phase B, whose start page may have
 * reached the limit.
 */
export function requestCapBeforePhaseC(browser: BrowserSection): boolean {
  if (!browser.requestCap.truncated) return false;
  const c = phaseRecord(browser, 'C');
  return !c || c.status === 'skipped';
}

export function startPageUrl(browser: BrowserSection): string | null {
  const a = phaseRecord(browser, 'A');
  const start = a?.pages.find((p) => p.role === 'start') ?? a?.pages[0];
  return start?.finalUrl ?? start?.url ?? null;
}

/** Pages visited in phases A and B (deduplicated by final URL, phase A first). */
export function visitedPages(
  browser: BrowserSection,
  phases: readonly BrowserPhase[] = ['A', 'B'],
): PageVisit[] {
  const seen = new Set<string>();
  const out: PageVisit[] = [];
  for (const ph of phases) {
    for (const p of phaseRecord(browser, ph)?.pages ?? []) {
      const key = p.finalUrl || p.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * The page of a request. A request of a subframe belongs to the page its frame's document was loaded on: a player's
 * beacon sent while the browser already navigates is recorded with the next page.
 */
export function pageIndex(browser: BrowserSection): (r: RequestRecord) => string {
  const framePage = new Map<string, string>();
  for (const p of browser.phases) {
    for (const r of p.requests) {
      if (r.isMainFrame || !r.frameId || r.resourceType !== 'document' || framePage.has(r.frameId)) continue;
      framePage.set(r.frameId, r.pageUrl);
    }
  }
  return (r) => (!r.isMainFrame && r.frameId ? framePage.get(r.frameId) : undefined) ?? r.pageUrl;
}

export function requestIndex(browser: BrowserSection): Map<string, RequestRecord> {
  const out = new Map<string, RequestRecord>();
  for (const p of browser.phases) for (const r of p.requests) out.set(r.id, r);
  return out;
}

/** Cookie domain without the leading dot, lower case; shared by the join key and the cookie evidence so both match and render it the same way. */
export function normDomain(d: string): string {
  return d.replace(/^\./, '').toLowerCase();
}

function cookieKey(
  phase: string,
  name: string,
  domain: string,
  path: string,
  pk: string | null,
  state: string,
  after: boolean,
) {
  return [phase, name, normDomain(domain), path, pk ?? '', state, after].join('|');
}

/** Pairs cookie records with their classification (one per record). */
export function classifiedCookies(
  browser: BrowserSection,
  derived: DerivedSection,
): Array<{ record: CookieRecord; cls: ClassifiedCookie }> {
  const byKey = new Map<string, ClassifiedCookie>();
  for (const c of derived.cookies) {
    byKey.set(
      cookieKey(c.phase, c.key.name, c.key.domain, c.key.path, c.key.partitionKey, c.state, c.afterClick),
      c,
    );
  }

  const out: Array<{ record: CookieRecord; cls: ClassifiedCookie }> = [];
  for (const p of browser.phases) {
    for (const record of p.cookies) {
      const cls = byKey.get(
        cookieKey(
          record.phase,
          record.name,
          record.domain,
          record.path,
          record.partitionKey,
          record.state,
          record.afterClick,
        ),
      );
      if (cls) out.push({ record, cls });
    }
  }
  return out;
}

export function classifiedStorage(
  browser: BrowserSection,
  derived: DerivedSection,
): Array<{ record: StorageRecord; cls: ClassifiedStorage }> {
  const key = (phase: string, type: string, origin: string, k: string, after: boolean) =>
    [phase, type, origin, k, after].join('|');
  const byKey = new Map<string, ClassifiedStorage>();
  for (const s of derived.storage) byKey.set(key(s.phase, s.storageType, s.origin, s.key, s.afterClick), s);

  const out: Array<{ record: StorageRecord; cls: ClassifiedStorage }> = [];
  for (const p of browser.phases) {
    for (const record of p.storage) {
      const cls = byKey.get(
        key(record.phase, record.storageType, record.origin, record.key, record.afterClick),
      );
      if (cls) out.push({ record, cls });
    }
  }
  return out;
}
