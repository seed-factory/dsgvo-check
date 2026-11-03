/** Pure helpers over DNS query records, shared by the MAIL-* checks and the DNS collector. */
import type {
  DnsAnswer,
  DnsQueryRecord,
  DnsRcode,
  DnsRecordType,
  DnsSection,
} from '../../../core/snapshot/dns.ts';

/** Lookup of a recorded query by (name, type); `undefined` = not queried (yet). */
export type DnsLookup = (qname: string, type: DnsRecordType) => DnsQueryRecord | undefined;

export interface PendingQuery {
  qname: string;
  type: DnsRecordType;
  purpose: string;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

export function queryKey(qname: string, type: DnsRecordType): string {
  return `${type} ${normalizeName(qname)}`;
}

/** First record per (name, type) wins: the collector never queries the same key twice. */
export function lookupFromQueries(queries: readonly DnsQueryRecord[]): DnsLookup {
  const map = new Map<string, DnsQueryRecord>();
  for (const q of queries) {
    const key = queryKey(q.qname, q.type);
    if (!map.has(key)) map.set(key, q);
  }
  return (qname, type) => map.get(queryKey(qname, type));
}

const FAILURES: ReadonlySet<DnsRcode> = new Set(['SERVFAIL', 'TIMEOUT', 'REFUSED', 'ERROR']);

/** Temporary or resolver-side failure: the answer is unknown (never "no record"). */
export function isFailure(rcode: DnsRcode): boolean {
  return FAILURES.has(rcode);
}

/** RFC 7208 §4.6.4 void lookup: NXDOMAIN or NOERROR without any answer. */
export function isVoid(q: DnsQueryRecord): boolean {
  return q.rcode === 'NXDOMAIN' || q.rcode === 'NODATA';
}

export function txtValues(q: DnsQueryRecord | undefined): string[] {
  return (q?.answers ?? []).filter((a) => a.type === 'TXT').map((a) => a.value);
}

export function formatAnswer(a: DnsAnswer): string {
  return a.type === 'MX' ? `${a.priority ?? 0} ${a.value}` : a.value;
}

export type MxState = 'present' | 'null' | 'none' | 'unknown';

/** RFC 7505: exactly one MX with exchange "." (and preference 0) means "this domain accepts no mail". */
export function mxState(q: DnsQueryRecord | undefined): MxState {
  if (!q || isFailure(q.rcode)) return 'unknown';
  const mx = q.answers.filter((a) => a.type === 'MX');
  if (mx.length === 0) return 'none';
  const isNull = (a: DnsAnswer) => a.value === '.' || a.value === '';
  if (mx.length === 1 && mx[0] && isNull(mx[0])) return 'null';
  return mx.some((a) => !isNull(a)) ? 'present' : 'null';
}

export function resolverLabel(section: Pick<DnsSection, 'resolver'>): string {
  return section.resolver.kind === 'system' || section.resolver.servers.length === 0
    ? 'system'
    : section.resolver.servers.join(',');
}
