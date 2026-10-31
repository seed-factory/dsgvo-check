/**
 * DNS collection for MAIL-*: MX of the mail domain, the DMARC Tree Walk (RFC 9989) from the scanned host and
 * from the mail domain, and the SPF include/redirect tree (RFC 7208). The same pure analyses the checks use decide what to query next,
 * so the snapshot always contains what the checks need. Budget ≤ 60 queries (D18). Redaction happens here,
 * before anything is stored (D20): `mailto:` and bare addresses are masked by the shared `redactText`, unrelated TXT at SPF names is dropped (count only).
 */
import { analyzeDmarc, DMARC_MAX_WALK } from '../../checks/dns/lib/dmarc.ts';
import {
  type DnsLookup,
  isFailure,
  normalizeName,
  type PendingQuery,
  queryKey,
} from '../../checks/dns/lib/records.ts';
import { analyzeSpf, isSpfCandidate } from '../../checks/dns/lib/spf.ts';
import type { Logger } from '../../core/logger.ts';
import { redactText } from '../../core/redact.ts';
import type { CollectorError } from '../../core/snapshot-common.ts';
import type { DnsClient, RawDnsResult } from './resolver.ts';
import type { DnsAnswer, DnsQueryRecord, DnsSection } from './types.ts';

export const DNS_QUERY_BUDGET = 60;
/** TIMEOUT results (each already retried) after which the resolver is treated as unresponsive. */
export const MAX_TIMEOUT_RESULTS = 3;
const SPF_ROUNDS = 16;

export interface MailDnsOptions {
  /** Scanned host: start of the DMARC Tree Walk. */
  host: string;
  /** Mail domain (registrable domain of the host): MX and SPF. */
  domain: string;
  client: DnsClient;
  now: () => Date;
  budget?: number;
  concurrency?: number;
  signal?: AbortSignal;
  log?: Logger;
}

export interface MailDnsResult {
  status: 'ok' | 'partial';
  /** Why the collection stopped early: `dns-budget-exhausted`, `resolver-unresponsive`, `aborted`. */
  reason?: string;
  section: DnsSection;
}

interface Planned extends PendingQuery {
  step?: number;
}

/**
 * Chunks re-cut from the already redacted value at the original boundaries (the last chunk takes the rest), so
 * `chunks.join('') === value`. Masking each chunk on its own would miss a `mailto:` split across
 * character-strings (S-05).
 */
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

export async function collectMailDns(o: MailDnsOptions): Promise<MailDnsResult> {
  const host = normalizeName(o.host);
  const domain = normalizeName(o.domain);
  const budget = o.budget ?? DNS_QUERY_BUDGET;
  const concurrency = o.concurrency ?? 4;
  const queries: DnsQueryRecord[] = [];
  const cache = new Map<string, DnsQueryRecord>();
  const inflight = new Set<string>();
  const errors: CollectorError[] = [];
  // Mutated from async closures: kept in an object so control-flow narrowing does not freeze it.
  const st: { used: number; timeouts: number; stopped: string | null } = {
    used: 0,
    timeouts: 0,
    stopped: null,
  };
  const lookup: DnsLookup = (qname, type) => cache.get(queryKey(qname, type));

  const record = (p: Planned, id: string, queriedAt: Date, res: RawDnsResult): DnsQueryRecord => {
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
  };

  const run = async (p: Planned): Promise<void> => {
    const key = queryKey(p.qname, p.type);
    if (cache.has(key) || inflight.has(key) || st.stopped) return;
    if (o.signal?.aborted) {
      st.stopped = 'aborted';
      return;
    }
    if (st.used >= budget) {
      st.stopped = 'dns-budget-exhausted';
      return;
    }
    st.used++;
    inflight.add(key);
    const id = `dns-${String(st.used).padStart(3, '0')}`;
    const queriedAt = o.now();
    let res: RawDnsResult;
    try {
      res = await o.client.query(normalizeName(p.qname), p.type);
    } catch (err) {
      res = {
        rcode: 'ERROR',
        answers: [],
        attempts: 1,
        durationMs: 0,
        error: { code: 'dns-client-error', message: (err as Error).message },
      };
    }
    inflight.delete(key);
    if (o.signal?.aborted && res.rcode === 'ERROR') {
      st.stopped = 'aborted';
      return;
    }
    const rec = record(p, id, queriedAt, res);
    cache.set(key, rec);
    queries.push(rec);
    o.log?.debug(`dns: ${p.type} ${rec.qname} → ${rec.rcode} (${rec.attempts} attempt(s))`);
    if (isFailure(rec.rcode)) {
      errors.push({
        code: rec.rcode.toLowerCase(),
        message: `${p.type} ${rec.qname}: ${rec.rcode} after ${rec.attempts} attempt(s)`,
      });
    }
    if (rec.rcode === 'TIMEOUT' && ++st.timeouts >= MAX_TIMEOUT_RESULTS)
      st.stopped ??= 'resolver-unresponsive';
  };

  const runAll = async (list: readonly Planned[]): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const item = list[next++] as Planned;
        await run(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  };

  await run({ qname: domain, type: 'MX', purpose: 'mx' });

  // Walk from the scanned host (MAIL-01), then from the mail domain (MAIL-02 matrix); the second walk only
  // queries when the host has a record of its own, otherwise every name is already cached.
  for (const [start, purpose] of [
    [host, 'dmarc'],
    [domain, 'dmarc-mail-domain'],
  ] as const) {
    for (let i = 0; i < DMARC_MAX_WALK && !st.stopped; i++) {
      const a = analyzeDmarc(start, domain, lookup);
      if (a.state !== 'incomplete' || !a.next) break;
      await run({
        qname: a.next.qname,
        type: 'TXT',
        purpose: purpose === 'dmarc' && a.next.step > 0 ? 'dmarc-tree-walk' : purpose,
        step: a.next.step,
      });
    }
  }

  for (let i = 0; i < SPF_ROUNDS && !st.stopped; i++) {
    const need = analyzeSpf(domain, lookup).pending.filter((p) => !cache.has(queryKey(p.qname, p.type)));
    if (need.length === 0) break;
    await runAll(need);
  }

  const stopped = st.stopped;
  if (stopped) {
    const messages: Record<string, string> = {
      'dns-budget-exhausted': `DNS query budget of ${budget} exhausted; remaining lookups not performed`,
      'resolver-unresponsive': `resolver did not answer ${MAX_TIMEOUT_RESULTS} queries; remaining lookups not performed`,
      aborted: 'scan aborted (timeout); remaining lookups not performed',
    };
    errors.push({ code: stopped, message: messages[stopped] ?? stopped });
  }
  return {
    status: stopped ? 'partial' : 'ok',
    ...(stopped ? { reason: stopped } : {}),
    section: {
      resolver: o.client.resolver,
      domain,
      host,
      queries,
      budget: { limit: budget, used: st.used },
      errors,
    },
  };
}
