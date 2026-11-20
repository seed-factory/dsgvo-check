/**
 * Tiny zone DSL for DNS tests: `{ 'TXT _dmarc.example.de': ['v=DMARC1; p=reject'], 'MX example.de': 'NXDOMAIN' }`.
 * A string array is a NOERROR answer (MX as "<priority> <exchange>"), `[]` NOERROR without relevant answers, a string the rcode.
 * The same zone feeds a fake resolver client for the collector tests.
 */
import { lookupFromQueries } from '../../../../src/checks/dns/lib/records.ts';
import type { DnsClient, RawDnsResult } from '../../../../src/collectors/dns/resolver.ts';
import type {
  DnsAnswer,
  DnsQueryRecord,
  DnsRcode,
  DnsRecordType,
  DnsSection,
  MailDomainStage,
  MailDomainTarget,
} from '../../../../src/core/snapshot/dns.ts';
import type { Snapshot } from '../../../../src/core/snapshot/index.ts';
import { makeDns, makeDnsQuery, makeSnapshot, makeTarget } from '../../../utils/snapshot-builder.ts';

export type ZoneEntry = readonly string[] | Exclude<DnsRcode, 'NOERROR'>;
export type ZoneSpec = Record<string, ZoneEntry>;

function purposeOf(qname: string, type: DnsRecordType): string {
  if (type === 'MX') return 'mx';
  if (qname.startsWith('_dmarc.')) return 'dmarc';
  if (qname.includes('._domainkey.')) return 'dkim';
  return type === 'TXT' ? 'spf' : 'spf-void-check';
}

export function zoneQuery(key: string, entry: ZoneEntry): DnsQueryRecord {
  const [type, qname] = key.split(' ') as [DnsRecordType, string];
  const purpose = purposeOf(qname, type);

  // a string is an rcode without answers; failures are retried once, so they took two attempts
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

/** www.example.de without a DMARC record of its own: the walk reaches `_dmarc.example.de`, which decides. */
export function siteZone(dmarc: ZoneEntry, extra: ZoneSpec = {}): ZoneSpec {
  return {
    'MX example.de': ['10 mx.example.de'],
    'TXT _dmarc.www.example.de': 'NXDOMAIN',
    'TXT _dmarc.example.de': dmarc,
    'TXT _dmarc.de': 'NXDOMAIN',
    ...extra,
  };
}

export const IMPRESSUM = 'https://www.example.de/impressum/';
export const IMPRESSUM_STAGE: MailDomainStage = { contacts: 'impressum', durationMs: 3 };

/** An address domain of the Impressum, checked with its own budget. */
export function contactDomain(domain: string, over: Partial<MailDomainTarget> = {}): MailDomainTarget {
  return {
    domain,
    host: domain,
    orgDomain: domain,
    roles: ['contact'],
    sources: [{ kind: 'impressum-text', url: IMPRESSUM }],
    status: 'checked',
    budget: { limit: 30, used: 3 },
    ...over,
  };
}

export interface FakeDnsClient extends DnsClient {
  /** `<type> <qname>` of every query, in order. */
  calls: string[];
}

/**
 * A resolver that answers from the zone, NXDOMAIN for names it does not list. Like the node:dns client it retries
 * SERVFAIL and TIMEOUT once and attaches an error to every failure but NXDOMAIN and NODATA. `onQuery` runs after each
 * query is recorded.
 */
export function fakeDnsClient(spec: ZoneSpec, onQuery?: () => void): FakeDnsClient {
  const calls: string[] = [];
  return {
    calls,
    resolver: { kind: 'custom', servers: ['192.0.2.53'] },
    cancel() {},
    async query(qname: string, type: DnsRecordType): Promise<RawDnsResult> {
      const key = `${type} ${qname}`;
      calls.push(key);
      onQuery?.();
      const entry = spec[key] ?? 'NXDOMAIN';
      if (typeof entry === 'string') {
        const retried = entry === 'SERVFAIL' || entry === 'TIMEOUT';
        const failed = entry !== 'NXDOMAIN' && entry !== 'NODATA';
        return {
          rcode: entry,
          answers: [],
          attempts: retried ? 2 : 1,
          durationMs: 1,
          ...(failed ? { error: { code: `E${entry}`, message: entry } } : {}),
        };
      }
      const answers = entry.map((v) =>
        type === 'MX'
          ? { type, value: v.split(' ')[1] as string, priority: Number(v.split(' ')[0]) }
          : { type, value: v, chunks: [v] },
      );
      return { rcode: answers.length ? 'NOERROR' : 'NODATA', answers, attempts: 1, durationMs: 1 };
    },
  };
}
