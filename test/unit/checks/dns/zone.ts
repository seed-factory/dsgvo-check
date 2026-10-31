/**
 * Tiny zone DSL for DNS L1 tests: `{ 'TXT _dmarc.example.de': ['v=DMARC1; p=reject'], 'MX example.de': 'NXDOMAIN' }`.
 * A string array is a NOERROR answer (MX entries as "<priority> <exchange>"); `[]` is NOERROR without relevant
 * answers (filtered); a string is the rcode.
 */
import { lookupFromQueries } from '../../../../src/checks/dns/lib/records.ts';
import type {
  DnsAnswer,
  DnsQueryRecord,
  DnsRcode,
  DnsRecordType,
  DnsSection,
} from '../../../../src/collectors/dns/types.ts';
import type { Snapshot } from '../../../../src/core/snapshot.ts';
import { makeDns, makeDnsQuery, makeSnapshot, makeTarget } from '../../../utils/snapshot-builder.ts';

export type ZoneEntry = readonly string[] | Exclude<DnsRcode, 'NOERROR'>;
export type ZoneSpec = Record<string, ZoneEntry>;

function purposeOf(qname: string, type: DnsRecordType): string {
  if (type === 'MX') return 'mx';
  if (qname.startsWith('_dmarc.')) return 'dmarc';
  return type === 'TXT' ? 'spf' : 'spf-void-check';
}

export function zoneQuery(key: string, entry: ZoneEntry): DnsQueryRecord {
  const [type, qname] = key.split(' ') as [DnsRecordType, string];
  const purpose = purposeOf(qname, type);
  if (typeof entry === 'string') {
    const retried = entry === 'SERVFAIL' || entry === 'TIMEOUT';
    return makeDnsQuery({ qname, type, rcode: entry, answers: [], attempts: retried ? 2 : 1, purpose });
  }
  const answers: DnsAnswer[] = entry.map((v) => {
    if (type !== 'MX') return { type, value: v };
    const [prio, exchange] = v.split(' ') as [string, string];
    return { type, value: exchange, priority: Number(prio) };
  });
  return makeDnsQuery({ qname, type, rcode: 'NOERROR', answers, purpose });
}

export function zoneQueries(spec: ZoneSpec): DnsQueryRecord[] {
  return Object.entries(spec).map(([k, v]) => zoneQuery(k, v));
}

export function zone(spec: ZoneSpec) {
  return lookupFromQueries(zoneQueries(spec));
}

export function dnsSection(spec: ZoneSpec, p: Partial<DnsSection> = {}): DnsSection {
  const queries = zoneQueries(spec);
  return makeDns({
    domain: 'example.de',
    host: 'www.example.de',
    queries,
    budget: { limit: 60, used: queries.length },
    ...p,
  });
}

export function dnsSnapshot(spec: ZoneSpec, p: Partial<DnsSection> = {}, url?: string): Snapshot {
  return makeSnapshot({ dns: dnsSection(spec, p), ...(url ? { target: makeTarget(url) } : {}) });
}
