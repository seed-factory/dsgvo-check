/**
 * DNS collector output.
 * 5.3 `dns` evidence: qname, type, rcode, records with masked `mailto:`, resolver, Tree Walk path.
 */
import type { CollectorError, IsoTimestamp } from '../../core/snapshot-common.ts';

export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'NODATA' | 'SERVFAIL' | 'TIMEOUT' | 'REFUSED' | 'ERROR';
export type DnsRecordType = 'TXT' | 'MX' | 'A' | 'AAAA' | 'CNAME' | 'CAA' | 'NS' | 'SOA';

export interface DnsAnswer {
  type: DnsRecordType;
  /** TXT: chunks joined; DMARC/security mailto: masked to the domain. */
  value: string;
  /**
   * TXT: character-strings at the boundaries as received, re-cut from the redacted `value`
   * (`chunks.join('') === value`), so a `mailto:` split across strings is masked too.
   */
  chunks?: string[];
  ttl?: number;
  priority?: number;
}

export interface DnsQueryRecord {
  id: string;
  qname: string;
  type: DnsRecordType;
  rcode: DnsRcode;
  answers: DnsAnswer[];
  /** Number of attempts (SERVFAIL/TIMEOUT are retried once before becoming an error). */
  attempts: number;
  durationMs: number;
  queriedAt: IsoTimestamp;
  /**
   * `mx`, `dmarc` (host, step 0), `dmarc-tree-walk` (host walk, step > 0), `dmarc-mail-domain` (walk from the
   * registrable domain), `spf`, `spf-include`, `spf-redirect`, `spf-void-check` (A/MX for a, mx, exists).
   */
  purpose: string;
  /** Position in the DMARC Tree Walk (RFC 9989), 0 = the host itself. */
  treeWalkStep?: number;
  error?: CollectorError;
  /** TXT answers dropped because they are not relevant to `purpose` (e.g. site-verification tokens); count only. */
  filteredAnswers?: number;
}

export interface DnsSection {
  resolver: { kind: 'system' | 'custom'; servers: string[] };
  /** Mail domain that was evaluated (final host or its registrable domain). */
  domain: string;
  queries: DnsQueryRecord[];
  budget: { limit: number; used: number };
  errors: CollectorError[];
  /** Host where the DMARC Tree Walk starts (the scanned host). Absent in old snapshots: use `target.host`. */
  host?: string;
  /** Set when mail checks cannot apply to the target (e.g. `ip-target`, `no-registrable-domain`). */
  notApplicable?: string;
}
