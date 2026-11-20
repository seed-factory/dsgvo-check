// DNS collection for MAIL-*: MX of the mail domain, the DMARC Tree Walk (RFC 9989) from the host and from the mail
// domain, the SPF include/redirect tree (RFC 7208), and last the DKIM selectors (RFC 6376); first for the scanned
// domain, after the browser for the further mail domains (`collectMailDomains`). The checks' own pure analyses decide
// what to query next, so the snapshot has what they need (each domain within its own budget). Redaction happens here
// before storing: addresses are masked by `redactText`, unrelated TXT at SPF and selector names is dropped (count only).
import {
  type DkimRules,
  dkimQname,
  dkimSignals,
  isDkimCandidate,
  planDkimSelectors,
} from '../../checks/dns/lib/dkim.ts';
import { analyzeDmarc, DMARC_MAX_WALK } from '../../checks/dns/lib/dmarc.ts';
import {
  type DnsLookup,
  isFailure,
  normalizeName,
  type PendingQuery,
  queryKey,
} from '../../checks/dns/lib/records.ts';
import { analyzeSpf, isSpfCandidate } from '../../checks/dns/lib/spf.ts';
import { DEFAULT_CONFIG } from '../../core/config/schema.ts';
import { redactText } from '../../core/redaction/redact.ts';
import type { Logger } from '../../core/runtime/logger.ts';
import type { CollectorError } from '../../core/snapshot/common.ts';
import type {
  DkimPlanEntry,
  DnsAnswer,
  DnsQueryRecord,
  DnsSection,
  MailDomainTarget,
} from '../../core/snapshot/dns.ts';
import type { MailTargetPlan } from './mail-targets.ts';
import type { DnsClient, RawDnsResult } from './resolver.ts';
import { loadDkimRules } from './rules.ts';

/** Queries per scan; the README's list of what the scanner sends quotes this number. */
export const DNS_QUERY_BUDGET = DEFAULT_CONFIG.dns.queryBudget;
/** Passes over the SPF include tree: one per nesting level, far above the 10 lookups RFC 7208 allows. */
const SPF_ROUNDS = 16;
/**
 * Purpose of the selector lookups. Their timeouts do not count for the circuit breaker: some name servers drop queries
 * for names under `_domainkey`, and that must not cost the next domain its MX, DMARC and SPF answers.
 */
const DKIM_PURPOSE = 'dkim';
const countsForBreaker = (purpose: string) => purpose !== DKIM_PURPOSE;

/** Which DKIM selectors are queried per mail domain (`dns.dkimSelectors`, `dns.dkimMaxSelectors`, dkim.yaml). */
export interface DkimOptions {
  selectors: readonly string[];
  maxSelectors: number;
  rules: DkimRules;
}

export interface MailDnsOptions {
  host: string;
  domain: string;
  client: DnsClient;
  now: () => Date;
  budget?: number;
  concurrency?: number;
  /** TIMEOUT results (each already retried) after which the resolver is treated as unresponsive. */
  maxTimeoutResults?: number;
  /** Defaults: the built-in settings and test/data/dns/dkim.yaml. */
  dkim?: DkimOptions;
  signal?: AbortSignal;
  log?: Logger;
}

function dkimDefaults(): DkimOptions {
  return {
    selectors: DEFAULT_CONFIG.dns.dkimSelectors,
    maxSelectors: DEFAULT_CONFIG.dns.dkimMaxSelectors,
    rules: loadDkimRules(),
  };
}

export interface MailDnsResult {
  status: 'ok' | 'partial';
  reason?: string;
  section: DnsSection;
}

interface Planned extends PendingQuery {
  step?: number;
}

// Chunks re-cut from the redacted value at the original boundaries, so `chunks.join('') === value`; masking each chunk
// on its own would miss a `mailto:` split across character-strings.
export function rechunk(value: string, original: readonly string[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const [i, c] of original.entries()) {
    if (at >= value.length) break;
    const end = i === original.length - 1 ? value.length : Math.min(value.length, at + c.length);
    out.push(value.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * TXT answers worth keeping at SPF and selector names; any other purpose keeps all. Both kinds stay at both, because a
 * name is asked once and its answer then serves the SPF and the DKIM analysis alike.
 */
function relevantTxt(purpose: string): ((txt: string) => boolean) | null {
  if (!purpose.startsWith('spf') && purpose !== DKIM_PURPOSE) return null;
  return (txt) => isSpfCandidate(txt) || isDkimCandidate(txt);
}

function redact(answers: DnsAnswer[], purpose: string): { answers: DnsAnswer[]; filtered: number } {
  const masked = answers.map((a) => {
    if (a.type !== 'TXT') return a;
    const value = redactText(a.value);
    return { ...a, value, ...(a.chunks ? { chunks: rechunk(value, a.chunks) } : {}) };
  });
  const relevant = relevantTxt(purpose);
  if (!relevant) return { answers: masked, filtered: 0 };
  const kept = masked.filter((a) => a.type !== 'TXT' || relevant(a.value));
  return { answers: kept, filtered: masked.length - kept.length };
}

/** A rejected query becomes an `ERROR` result, so one failing lookup cannot end the run. */
async function askResolver(client: DnsClient, p: Planned): Promise<RawDnsResult> {
  try {
    return await client.query(normalizeName(p.qname), p.type);
  } catch (err) {
    return {
      rcode: 'ERROR',
      answers: [],
      attempts: 1,
      durationMs: 0,
      error: { code: 'dns-client-error', message: (err as Error).message },
    };
  }
}

function toQueryRecord(p: Planned, id: string, queriedAt: Date, res: RawDnsResult): DnsQueryRecord {
  const { answers, filtered } = redact(res.answers, p.purpose);
  return {
    id,
    qname: normalizeName(p.qname),
    type: p.type,
    rcode: res.rcode,
    answers,
    attempts: res.attempts,
    durationMs: res.durationMs,
    queriedAt: queriedAt.toISOString(),
    purpose: p.purpose,
    ...(p.step !== undefined ? { treeWalkStep: p.step } : {}),
    ...(res.error ? { error: res.error } : {}),
    ...(filtered > 0 ? { filteredAnswers: filtered } : {}),
  };
}

interface Limits {
  budget: number;
  concurrency: number;
  maxTimeoutResults: number;
}

interface RunState {
  used: number;
  /** Why the run ended early (`aborted`, `dns-budget-exhausted`, `resolver-unresponsive`); null while it goes on. */
  stopped: string | null;
}

interface QueryRunner {
  readonly state: RunState;
  /** Answers collected so far, for the pure analyses that decide what to ask next. */
  readonly lookup: DnsLookup;
  isCached(q: PendingQuery): boolean;
  run(p: Planned): Promise<void>;
  /** Runs the list with at most `concurrency` queries at a time. */
  runAll(list: readonly Planned[]): Promise<void>;
}

/** Earlier queries of this scan: their answers are reused, their ids are not given again. */
interface PoolSeed {
  queries: readonly DnsQueryRecord[];
  issued: number;
  timeouts: number;
  halted: string | null;
}

/**
 * What every mail domain of a scan shares: one answer per query (cache and in-flight set), the query ids, the timeout
 * count of the circuit breaker and a stop that ends all domains (`aborted`, `resolver-unresponsive`). The budget is per
 * domain (`runner(limit)`), so a further domain never uses up the scanned domain's queries.
 */
interface QueryPool {
  /** Queries made through this pool (the seed's are not repeated here). */
  readonly queries: DnsQueryRecord[];
  readonly errors: CollectorError[];
  runner(limit: number): QueryRunner;
}

// Each query is asked once, counts against the budget of the domain that asked it first, and is stored redacted.
function createQueryPool(
  o: Pick<MailDnsOptions, 'client' | 'now' | 'signal' | 'log'>,
  limits: Omit<Limits, 'budget'>,
  seed?: PoolSeed,
): QueryPool {
  const cache = new Map<string, DnsQueryRecord>();
  for (const q of seed?.queries ?? []) {
    const key = queryKey(q.qname, q.type);
    if (!cache.has(key)) cache.set(key, q);
  }
  const inflight = new Set<string>();
  const queries: DnsQueryRecord[] = [];
  const errors: CollectorError[] = [];
  // Mutated from async closures: kept in an object so control-flow narrowing does not freeze it.
  const shared = { issued: seed?.issued ?? 0, timeouts: seed?.timeouts ?? 0, halted: seed?.halted ?? null };

  const runner = (limit: number): QueryRunner => {
    const state: RunState = { used: 0, stopped: null };

    const run = async (p: Planned): Promise<void> => {
      const key = queryKey(p.qname, p.type);
      if (cache.has(key) || inflight.has(key) || state.stopped) return;
      if (o.signal?.aborted) shared.halted ??= 'aborted';
      if (shared.halted) {
        state.stopped = shared.halted;
        return;
      }
      if (state.used >= limit) {
        state.stopped = 'dns-budget-exhausted';
        return;
      }

      state.used++;
      shared.issued++;
      inflight.add(key);
      const id = `dns-${String(shared.issued).padStart(3, '0')}`;
      const queriedAt = o.now();
      const res = await askResolver(o.client, p);
      inflight.delete(key);

      // A scan abort surfaces as a failed query: it is not recorded as an answer.
      if (o.signal?.aborted && res.rcode === 'ERROR') {
        shared.halted ??= 'aborted';
        state.stopped = 'aborted';
        return;
      }

      const rec = toQueryRecord(p, id, queriedAt, res);
      cache.set(key, rec);
      queries.push(rec);
      o.log?.debug(`dns: ${p.type} ${rec.qname} → ${rec.rcode} (${rec.attempts} attempt(s))`);
      if (isFailure(rec.rcode)) {
        errors.push({
          code: rec.rcode.toLowerCase(),
          message: `${p.type} ${rec.qname}: ${rec.rcode} after ${rec.attempts} attempt(s)`,
        });
      }
      if (
        rec.rcode === 'TIMEOUT' &&
        countsForBreaker(p.purpose) &&
        ++shared.timeouts >= limits.maxTimeoutResults
      ) {
        shared.halted ??= 'resolver-unresponsive';
        state.stopped ??= shared.halted;
      }
    };

    const runAll = async (list: readonly Planned[]): Promise<void> => {
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const item = list[next++] as Planned;
          await run(item);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limits.concurrency, list.length) }, worker));
    };

    return {
      state,
      lookup: (qname, type) => cache.get(queryKey(qname, type)),
      isCached: (q) => cache.has(queryKey(q.qname, q.type)),
      run,
      runAll,
    };
  };

  return { queries, errors, runner };
}

// Walk from the host (MAIL-01), then from the mail domain (MAIL-02 matrix); the second walk only queries when the
// host has a record of its own, otherwise every name is already cached. Below `orgDomain` a record is the domain's own.
async function walkDmarc(
  runner: QueryRunner,
  host: string,
  domain: string,
  orgDomain: string,
): Promise<void> {
  for (const [start, purpose] of [
    [host, 'dmarc'],
    [domain, 'dmarc-mail-domain'],
  ] as const) {
    for (let i = 0; i < DMARC_MAX_WALK && !runner.state.stopped; i++) {
      const a = analyzeDmarc(start, orgDomain, runner.lookup);
      if (a.state !== 'incomplete' || !a.next) break;
      await runner.run({
        qname: a.next.qname,
        type: 'TXT',
        purpose: purpose === 'dmarc' && a.next.step > 0 ? 'dmarc-tree-walk' : purpose,
        step: a.next.step,
      });
    }
  }
}

/** One round per level of the SPF include/redirect tree, until the analysis has nothing left to ask. */
async function walkSpf(runner: QueryRunner, domain: string): Promise<void> {
  for (let i = 0; i < SPF_ROUNDS && !runner.state.stopped; i++) {
    const need = analyzeSpf(domain, runner.lookup).pending.filter((p) => !runner.isCached(p));
    if (need.length === 0) break;
    await runner.runAll(need);
  }
}

/**
 * The DKIM selectors of one mail domain, planned from its MX and SPF answers. They run last, so a selector never takes
 * a query MAIL-01 or MAIL-02 needs. The plan is returned even when the budget stops the queries: MAIL-03 then knows
 * which selectors are open instead of reading them as absent.
 */
async function walkDkim(runner: QueryRunner, domain: string, o: DkimOptions): Promise<DkimPlanEntry[]> {
  const plan = planDkimSelectors({
    domain,
    signals: dkimSignals(domain, runner.lookup),
    operatorSelectors: o.selectors,
    maxSelectors: o.maxSelectors,
    rules: o.rules,
  });
  await runner.runAll(
    plan
      .filter((e) => !e.capped)
      .map((e) => ({ qname: dkimQname(e.selector, domain), type: 'TXT' as const, purpose: DKIM_PURPOSE })),
  );
  return plan;
}

/** MX, then the DMARC Tree Walk, then the SPF tree, then the DKIM selectors of one mail domain. */
async function collectDomain(
  runner: QueryRunner,
  host: string,
  domain: string,
  orgDomain: string,
  dkim: DkimOptions,
): Promise<DkimPlanEntry[]> {
  await runner.run({ qname: domain, type: 'MX', purpose: 'mx' });
  await walkDmarc(runner, host, domain, orgDomain);
  await walkSpf(runner, domain);
  return walkDkim(runner, domain, dkim);
}

function stopMessage(stopped: string, limits: Limits): string {
  const messages: Record<string, string> = {
    'dns-budget-exhausted': `DNS query budget of ${limits.budget} exhausted; remaining lookups not performed`,
    'resolver-unresponsive': `resolver did not answer ${limits.maxTimeoutResults} queries; remaining lookups not performed`,
    aborted: 'scan aborted (timeout); remaining lookups not performed',
  };
  return messages[stopped] ?? stopped;
}

export async function collectMailDns(o: MailDnsOptions): Promise<MailDnsResult> {
  const host = normalizeName(o.host);
  const domain = normalizeName(o.domain);
  const limits: Limits = {
    budget: o.budget ?? DNS_QUERY_BUDGET,
    concurrency: o.concurrency ?? DEFAULT_CONFIG.dns.concurrency,
    maxTimeoutResults: o.maxTimeoutResults ?? DEFAULT_CONFIG.dns.maxTimeoutResults,
  };
  const pool = createQueryPool(o, limits);
  const runner = pool.runner(limits.budget);

  const dkimPlan = await collectDomain(runner, host, domain, domain, o.dkim ?? dkimDefaults());

  const { queries, errors } = pool;
  const stopped = runner.state.stopped;
  if (stopped) errors.push({ code: stopped, message: stopMessage(stopped, limits) });

  return {
    status: stopped ? 'partial' : 'ok',
    ...(stopped ? { reason: stopped } : {}),
    section: {
      resolver: o.client.resolver,
      domain,
      host,
      queries,
      budget: { limit: limits.budget, used: runner.state.used },
      errors,
      dkimPlan,
    },
  };
}

export interface MailDomainsOptions extends Omit<MailDnsOptions, 'host' | 'domain' | 'budget'> {
  /** The section of the scanned domain: its answers are reused and its query ids continue. */
  section: DnsSection;
  plan: MailTargetPlan;
  /** Queries per further domain (`dns.mailDomainQueryBudget`). */
  budget?: number;
}

/** The first stage's stop that ends every further domain too; a used-up budget is the scanned domain's own. */
function haltOf(section: DnsSection): string | null {
  return section.errors.some((e) => e.code === 'resolver-unresponsive') ? 'resolver-unresponsive' : null;
}

/**
 * The further mail domains of the plan, one after another with the scanned domain's cache, ids and circuit breaker.
 * The new queries and errors are appended to the section, so the report counts them with the others.
 */
export async function collectMailDomains(o: MailDomainsOptions): Promise<DnsSection> {
  const budget = o.budget ?? DEFAULT_CONFIG.dns.mailDomainQueryBudget;
  const limits = {
    concurrency: o.concurrency ?? DEFAULT_CONFIG.dns.concurrency,
    maxTimeoutResults: o.maxTimeoutResults ?? DEFAULT_CONFIG.dns.maxTimeoutResults,
  };
  const pool = createQueryPool(o, limits, {
    queries: o.section.queries,
    issued: o.section.budget.used,
    timeouts: o.section.queries.filter((q) => q.rcode === 'TIMEOUT' && countsForBreaker(q.purpose)).length,
    halted: haltOf(o.section),
  });

  const dkim = o.dkim ?? dkimDefaults();
  const mailDomains: MailDomainTarget[] = [];
  const dkimPlan: DkimPlanEntry[] = [...(o.section.dkimPlan ?? [])];
  for (const { skip, ...t } of o.plan.targets) {
    if (skip) {
      mailDomains.push({ ...t, status: 'skipped', reason: skip, budget: { limit: budget, used: 0 } });
      continue;
    }
    const runner = pool.runner(budget);
    const host = normalizeName(t.host);
    dkimPlan.push(
      ...(await collectDomain(runner, host, normalizeName(t.domain), normalizeName(t.orgDomain), dkim)),
    );
    const stopped = runner.state.stopped as MailDomainTarget['reason'] | null;
    const used = runner.state.used;
    mailDomains.push({
      ...t,
      status: stopped ? (used > 0 ? 'partial' : 'skipped') : 'checked',
      ...(stopped ? { reason: stopped } : {}),
      budget: { limit: budget, used },
    });
  }

  return {
    ...o.section,
    queries: [...o.section.queries, ...pool.queries],
    errors: [...o.section.errors, ...pool.errors],
    mailDomains,
    dkimPlan,
  };
}
