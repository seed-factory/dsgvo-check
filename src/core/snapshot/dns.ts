/** DNS collector output: queries with rcode, records (`mailto:` masked), resolver and Tree Walk path. */
import type { CollectorError, IsoTimestamp, SanitizedUrl } from './common.ts';

export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'NODATA' | 'SERVFAIL' | 'TIMEOUT' | 'REFUSED' | 'ERROR';
export type DnsRecordType = 'TXT' | 'MX' | 'A' | 'AAAA' | 'CNAME' | 'CAA' | 'NS' | 'SOA';

export interface DnsAnswer {
  type: DnsRecordType;
  /** TXT: chunks joined; DMARC/security mailto: masked to the domain. */
  value: string;
  /** TXT: character-strings as received, re-cut from the redacted `value` (`chunks.join('') === value`), so a split `mailto:` is masked too. */
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
   * `mx`, `dmarc`, `dmarc-tree-walk`, `dmarc-mail-domain`, `spf`, `spf-include`, `spf-redirect`, `spf-void-check`,
   * `dkim` (`<selector>._domainkey.<domain>`).
   */
  purpose: string;
  /** Position in the DMARC Tree Walk (RFC 9989), 0 = the host itself. */
  treeWalkStep?: number;
  error?: CollectorError;
  /** TXT answers dropped because they are not relevant to `purpose` (e.g. site-verification tokens); count only. */
  filteredAnswers?: number;
}

/** Why a DKIM selector is queried: set by the operator, named by a recognised mail provider, or a common name. */
export type DkimSelectorReason = 'operator' | `provider:${string}` | 'common';

/** One DKIM selector queried for a mail domain; its query is `TXT <selector>._domainkey.<domain>`. */
export interface DkimPlanEntry {
  domain: string;
  selector: string;
  reason: DkimSelectorReason;
  /**
   * A key is expected here: the operator set the selector, or the recognised provider always signs with it. Common
   * names and selectors a provider lets the customer change are probes only.
   */
  given: boolean;
  /**
   * Over `dns.dkimMaxSelectors`, so not queried. Only given selectors are kept this way: MAIL-03 must not read a given
   * selector it never asked as one without a key.
   */
  capped?: true;
}

/** Why a further mail domain is checked: the site's domain after a redirect, or an address seen in the Impressum. */
export type MailDomainRole = 'final' | 'contact';

export interface MailDomainSource {
  /** `impressum-text`: a masked address in the Impressum text; `impressum-mailto`: a mailto link on an Impressum page. */
  kind: 'impressum-text' | 'impressum-mailto';
  url: SanitizedUrl;
}

/** A mail domain checked after the browser, besides the scanned domain; its queries are in `DnsSection.queries`. */
export interface MailDomainTarget {
  /** Domain whose MX and SPF are queried: the registrable domain of the final host, or the exact address domain. */
  domain: string;
  /** Where the DMARC Tree Walk starts: the final host, or the address domain. */
  host: string;
  /** Registrable domain of `domain`: the walk below it counts as the domain's own policy, above it as a PSD policy. */
  orgDomain: string;
  roles: MailDomainRole[];
  /** Impressum pages that showed the address (contact role). */
  sources: MailDomainSource[];
  /** `checked`: all lookups made; `partial`: stopped early (`reason`); `skipped`: not queried at all (`reason`). */
  status: 'checked' | 'partial' | 'skipped';
  reason?: 'free-mail' | 'limit' | 'dns-budget-exhausted' | 'aborted' | 'resolver-unresponsive';
  /** Queries of this domain against its own budget (`dns.mailDomainQueryBudget`). */
  budget: { limit: number; used: number };
}

/** The DNS stage after the browser, which knows the final host and the Impressum. Absent in older snapshots. */
export interface MailDomainStage {
  /**
   * Whether Impressum addresses could be read: `impressum` (an Impressum document or page was read), `not-collected`
   * (no browser run, or no Impressum read in it), `off` (`dns.maxMailDomains` is 0).
   */
  contacts: 'impressum' | 'not-collected' | 'off';
  durationMs: number;
  /** The stage failed; the further domains are then unknown. */
  error?: CollectorError;
}

export interface DnsSection {
  resolver: { kind: 'system' | 'custom'; servers: string[] };
  /** Mail domain of the scanned host (its registrable domain), whose MX and SPF are queried. */
  domain: string;
  queries: DnsQueryRecord[];
  budget: { limit: number; used: number };
  errors: CollectorError[];
  /** Host where the DMARC Tree Walk starts (the scanned host). Absent in old snapshots: use `target.host`. */
  host?: string;
  /** Set when mail checks cannot apply to the target (e.g. `ip-target`, `no-registrable-domain`). */
  notApplicable?: string;
  /** Further mail domains in the order they were found: the final site's domain first, then Impressum addresses. */
  mailDomains?: MailDomainTarget[];
  mailDomainStage?: MailDomainStage;
  /**
   * DKIM selectors per checked mail domain, in query order (MAIL-03). A domain without entries was not probed: Null MX,
   * or neither MX nor SPF. Absent in older snapshots.
   */
  dkimPlan?: DkimPlanEntry[];
}
