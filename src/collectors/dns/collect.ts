// DNS collection for MAIL-*: MX of the mail domain, the DMARC Tree Walk (RFC 9989) from the scanned host and from the
// mail domain, and the SPF include/redirect tree (RFC 7208). The checks' own pure analyses decide what to query next,
// so the snapshot has what they need (≤ 60 queries). Redaction happens here before storing: addresses are masked by
// `redactText`, unrelated TXT at SPF names is dropped (count only).
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
import type { DnsAnswer, DnsQueryRecord, DnsSection } from '../../core/snapshot/dns.ts';
import type { DnsClient, RawDnsResult } from './resolver.ts';

/** Queries per scan; the README's list of what the scanner sends quotes this number. */
export const DNS_QUERY_BUDGET = DEFAULT_CONFIG.dns.queryBudget;
/** Passes over the SPF include tree: one per nesting level, far above the 10 lookups RFC 7208 allows. */
const SPF_ROUNDS = 16;

export interface MailDnsOptions {
  host: string;
  domain: string;
  client: DnsClient;
  now: () => Date;
  budget?: number;
  concurrency?: number;
  /** TIMEOUT results (each already retried) after which the resolver is treated as unresponsive. */
  maxTimeoutResults?: number;
  signal?: AbortSignal;
  log?: Logger;
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

function redact(answers: DnsAnswer[], purpose: string): { answers: DnsAnswer[]; filtered: number } {
  const masked = answers.map((a) => {
    if (a.type !== 'TXT') return a;
    const value = redactText(a.value);
    return { ...a, value, ...(a.chunks ? { chunks: rechunk(value, a.chunks) } : {}) };
  });
  if (!purpose.startsWith('spf')) return { answers: masked, filtered: 0 };
  const kept = masked.filter((a) => a.type !== 'TXT' || isSpfCandidate(a.value));
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
  timeouts: number;
  /** Why the run ended early (`aborted`, `dns-budget-exhausted`, `resolver-unresponsive`); null while it goes on. */
  stopped: string | null;
}

interface QueryRunner {
  readonly state: RunState;
  readonly queries: DnsQueryRecord[];
  readonly errors: CollectorError[];
  /** Answers collected so far, for the pure analyses that decide what to ask next. */
  readonly lookup: DnsLookup;
  isCached(q: PendingQuery): boolean;
  run(p: Planned): Promise<void>;
  /** Runs the list with at most `concurrency` queries at a time. */
  runAll(list: readonly Planned[]): Promise<void>;
}

// Each query is asked once (cache and in-flight set), counts against the budget, and is stored redacted.
function createQueryRunner(o: MailDnsOptions, limits: Limits): QueryRunner {
  const cache = new Map<string, DnsQueryRecord>();
  const inflight = new Set<string>();
  const queries: DnsQueryRecord[] = [];
  const errors: CollectorError[] = [];
  // Mutated from async closures: kept in an object so control-flow narrowing does not freeze it.
  const state: RunState = { used: 0, timeouts: 0, stopped: null };

  const run = async (p: Planned): Promise<void> => {
    const key = queryKey(p.qname, p.type);
    if (cache.has(key) || inflight.has(key) || state.stopped) return;
    if (o.signal?.aborted) {
      state.stopped = 'aborted';
      return;
    }
    if (state.used >= limits.budget) {
      state.stopped = 'dns-budget-exhausted';
      return;
    }

    state.used++;
    inflight.add(key);
    const id = `dns-${String(state.used).padStart(3, '0')}`;
    const queriedAt = o.now();
    const res = await askResolver(o.client, p);
    inflight.delete(key);

    // A scan abort surfaces as a failed query: it is not recorded as an answer.
    if (o.signal?.aborted && res.rcode === 'ERROR') {
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
    if (rec.rcode === 'TIMEOUT' && ++state.timeouts >= limits.maxTimeoutResults) {
      state.stopped ??= 'resolver-unresponsive';
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
    queries,
    errors,
    lookup: (qname, type) => cache.get(queryKey(qname, type)),
    isCached: (q) => cache.has(queryKey(q.qname, q.type)),
    run,
    runAll,
  };
}

// Walk from the scanned host (MAIL-01), then from the mail domain (MAIL-02 matrix); the second walk only
// queries when the host has a record of its own, otherwise every name is already cached.
async function walkDmarc(runner: QueryRunner, host: string, domain: string): Promise<void> {
  for (const [start, purpose] of [
    [host, 'dmarc'],
    [domain, 'dmarc-mail-domain'],
  ] as const) {
    for (let i = 0; i < DMARC_MAX_WALK && !runner.state.stopped; i++) {
      const a = analyzeDmarc(start, domain, runner.lookup);
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
  const runner = createQueryRunner(o, limits);

  await runner.run({ qname: domain, type: 'MX', purpose: 'mx' });
  await walkDmarc(runner, host, domain);
  await walkSpf(runner, domain);

  const { state, queries, errors } = runner;
  const stopped = state.stopped;
  if (stopped) errors.push({ code: stopped, message: stopMessage(stopped, limits) });

  return {
    status: stopped ? 'partial' : 'ok',
    ...(stopped ? { reason: stopped } : {}),
    section: {
      resolver: o.client.resolver,
      domain,
      host,
      queries,
      budget: { limit: limits.budget, used: state.used },
      errors,
    },
  };
}
