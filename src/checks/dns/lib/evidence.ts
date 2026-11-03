/** `dns` evidence (5.3) built from recorded queries: qname, type, rcode, masked records, resolver, Tree Walk path. */

import type { EvidenceInput } from '../../../core/api.ts';
import type { DnsQueryRecord, DnsSection } from '../../../core/snapshot-dns.ts';
import { formatAnswer, resolverLabel } from './records.ts';

export function dnsEvidence(
  q: DnsQueryRecord,
  section: Pick<DnsSection, 'resolver'>,
  extra: { treeWalk?: string[] } = {},
): EvidenceInput {
  return {
    type: 'dns',
    phase: 'dns',
    qname: q.qname,
    qtype: q.type,
    rcode: q.rcode,
    records: q.answers.map(formatAnswer),
    resolver: resolverLabel(section),
    ...(extra.treeWalk ? { treeWalk: extra.treeWalk } : {}),
  };
}
