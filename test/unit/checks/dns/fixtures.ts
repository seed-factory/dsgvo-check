/**
 * Snapshot fixtures of the DNS checks, built in memory: one row per DNS query (type, name, purpose and what differs
 * from a NOERROR answer without records). Every fixture is run by the completeness test against its `$expect`.
 */
import type { CollectorError } from '../../../../src/core/snapshot/common.ts';
import type {
  DkimPlanEntry,
  DnsAnswer,
  DnsQueryRecord,
  DnsRcode,
  DnsRecordType,
  MailDomainStage,
  MailDomainTarget,
} from '../../../../src/core/snapshot/dns.ts';
import type { FixtureExpect, RawFixture } from '../../../utils/snapshot-builder.ts';
import { dkimRecord, ED25519_KEY, rsaKey } from './dkim-keys.ts';
import { contactDomain as contact, IMPRESSUM_STAGE } from './zone.ts';

type Query = Pick<DnsQueryRecord, 'type' | 'qname' | 'purpose'> &
  Partial<Pick<DnsQueryRecord, 'rcode' | 'answers' | 'treeWalkStep' | 'attempts'>>;

interface DnsFixture {
  file: string;
  description: string;
  expect: FixtureExpect;
  domain?: string;
  host?: string;
  notApplicable?: string;
  queries: Query[];
  /** Further mail domains of the stage after the browser; their queries are in `queries` too. */
  mailDomains?: MailDomainTarget[];
  mailDomainStage?: MailDomainStage;
  /** DKIM selectors the collector planned (MAIL-03); absent as in snapshots from before MAIL-03. */
  dkimPlan?: DkimPlanEntry[];
  /** Collector errors of the scanned domain, such as the used-up query budget. */
  errors?: CollectorError[];
}

const q = (
  type: DnsRecordType,
  qname: string,
  purpose: string,
  rest: { rcode?: DnsRcode; answers?: DnsAnswer[]; treeWalkStep?: number; attempts?: number } = {},
): Query => ({ type, qname, purpose, ...rest });

const txt = (value: string): DnsAnswer => ({ type: 'TXT', value, chunks: [value] });
const mxOf = (exchange: string): DnsAnswer => ({ type: 'MX', value: exchange, priority: 10 });
const NX = { rcode: 'NXDOMAIN' } as const;

/** The SPF lookup of example.de answered by these records. */
const spf = (...records: string[]): Query => q('TXT', 'example.de', 'spf', { answers: records.map(txt) });

/**
 * www.example.de without a record of its own; `_dmarc.example.de` decides: its record (several records as an array),
 * a lookup that failed (its rcode and attempts), or null for no record there either.
 */
function siteDmarc(org: string | string[] | { rcode: DnsRcode; attempts: number } | null): Query[] {
  const answer =
    org === null
      ? NX
      : typeof org === 'string'
        ? { answers: [txt(org)] }
        : Array.isArray(org)
          ? { answers: org.map(txt) }
          : org;
  return [
    q('MX', 'example.de', 'mx', { answers: [mxOf('mx.example.de')] }),
    q('TXT', '_dmarc.www.example.de', 'dmarc', { ...NX, treeWalkStep: 0 }),
    q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { ...answer, treeWalkStep: 1 }),
    q('TXT', '_dmarc.de', 'dmarc-tree-walk', { ...NX, treeWalkStep: 2 }),
  ];
}

const REJECT = 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de';
const STAGE: MailDomainStage = { ...IMPRESSUM_STAGE, durationMs: 4 };

/** The domain of the start page after a redirect to www.example.net. */
const FINAL: MailDomainTarget = {
  domain: 'example.net',
  host: 'www.example.net',
  orgDomain: 'example.net',
  roles: ['final'],
  sources: [],
  status: 'checked',
  budget: { limit: 30, used: 4 },
};

/** MX and the DMARC walk of example-mail.de: no record there, none at the TLD. */
const CONTACT_WITHOUT_DMARC: Query[] = [
  q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
  q('TXT', '_dmarc.example-mail.de', 'dmarc', { ...NX, treeWalkStep: 0 }),
];

/** MAIL-01 on the further mail domains: each domain on its own, the scanned domain's result unchanged. */
const MAIL_01_FURTHER_DOMAINS: DnsFixture[] = [
  {
    file: 'violation-contact-domain-missing.json',
    description:
      'The scanned domain enforces DMARC, the domain of an Impressum address has no record: record-not-found for that domain only',
    expect: { status: 'completed', variants: ['record-not-found'] },
    queries: [...siteDmarc(REJECT), ...CONTACT_WITHOUT_DMARC],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
  {
    file: 'clean-contact-domain-reject.json',
    description: 'The Impressum address domain publishes p=reject with rua: no finding for either domain',
    expect: { status: 'completed', variants: [] },
    queries: [
      ...siteDmarc(REJECT),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
      q('TXT', '_dmarc.example-mail.de', 'dmarc', {
        answers: [txt('v=DMARC1; p=reject; rua=mailto:[redacted]@example-mail.de')],
        treeWalkStep: 0,
      }),
    ],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
  {
    file: 'inconclusive-contact-domain-servfail.json',
    description:
      'SERVFAIL after retry on the Impressum address domain: partial (mail-domain-unresolved), no "no record" for it, the scanned domain still evaluated',
    expect: { status: 'partial', variants: [] },
    queries: [
      ...siteDmarc(REJECT),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
      q('TXT', '_dmarc.example-mail.de', 'dmarc', { rcode: 'SERVFAIL', attempts: 2, treeWalkStep: 0 }),
    ],
    mailDomains: [contact('example-mail.de', { status: 'checked' })],
    mailDomainStage: STAGE,
  },
  {
    file: 'counterexample-contact-subdomain-inherits.json',
    description:
      'Counterexample: the address domain mail.example.de has no record of its own, its organizational domain example.de has p=reject: no finding',
    expect: { status: 'completed', variants: [] },
    queries: [
      ...siteDmarc(REJECT),
      q('MX', 'mail.example.de', 'mx', { answers: [mxOf('mx.example.de')] }),
      q('TXT', '_dmarc.mail.example.de', 'dmarc', { ...NX, treeWalkStep: 0 }),
    ],
    mailDomains: [contact('mail.example.de', { orgDomain: 'example.de' })],
    mailDomainStage: STAGE,
  },
  {
    file: 'violation-final-domain-missing.json',
    description:
      'The redirect leads to www.example.net, whose domain has no DMARC record, while the scanned example.de has p=quarantine: one record-not-found for example.net',
    expect: { status: 'completed', variants: ['record-not-found'] },
    queries: [
      ...siteDmarc('v=DMARC1; p=quarantine; rua=mailto:[redacted]@example.de'),
      q('MX', 'example.net', 'mx', { answers: [mxOf('mx.example.net')] }),
      q('TXT', '_dmarc.www.example.net', 'dmarc', { ...NX, treeWalkStep: 0 }),
      q('TXT', '_dmarc.example.net', 'dmarc-tree-walk', { ...NX, treeWalkStep: 1 }),
      q('TXT', '_dmarc.net', 'dmarc-tree-walk', { ...NX, treeWalkStep: 2 }),
    ],
    mailDomains: [FINAL],
    mailDomainStage: STAGE,
  },
  {
    file: 'counterexample-final-enforced-entry-missing.json',
    description:
      'Counterexample: p=reject of the redirect target does not stand in for the scanned domain, which has no record: record-not-found for example.de only',
    expect: { status: 'completed', variants: ['record-not-found'] },
    queries: [
      ...siteDmarc(null),
      q('MX', 'example.net', 'mx', { answers: [mxOf('mx.example.net')] }),
      q('TXT', '_dmarc.www.example.net', 'dmarc', { ...NX, treeWalkStep: 0 }),
      q('TXT', '_dmarc.example.net', 'dmarc-tree-walk', {
        answers: [txt('v=DMARC1; p=reject; rua=mailto:[redacted]@example.net')],
        treeWalkStep: 1,
      }),
    ],
    mailDomains: [FINAL],
    mailDomainStage: STAGE,
  },
  {
    file: 'inconclusive-mail-domains-not-collected.json',
    description:
      'No Impressum was read in this run (browser not run): partial with mail-domains-not-collected, the scanned domain evaluated',
    expect: { status: 'partial', variants: [] },
    queries: siteDmarc(REJECT),
    mailDomains: [],
    mailDomainStage: { contacts: 'not-collected', durationMs: 0 },
  },
  {
    file: 'other-contact-domains-capped.json',
    description:
      'A free-mail domain is left out without a note; a domain over dns.maxMailDomains makes the result partial (mail-domains-capped)',
    expect: { status: 'partial', variants: [] },
    queries: [
      ...siteDmarc(REJECT),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
      q('TXT', '_dmarc.example-mail.de', 'dmarc', { answers: [txt(REJECT)], treeWalkStep: 0 }),
    ],
    mailDomains: [
      contact('gmx.de', { status: 'skipped', reason: 'free-mail', budget: { limit: 30, used: 0 } }),
      contact('example-mail.de'),
      contact('example-other.de', { status: 'skipped', reason: 'limit', budget: { limit: 30, used: 0 } }),
    ],
    mailDomainStage: STAGE,
  },
];

/** SPF of the scanned domain: -all with one include. */
const SITE_SPF_FAIL: Query[] = [
  spf('v=spf1 include:_spf.provider.example -all'),
  q('TXT', '_spf.provider.example', 'spf-include', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
];

/** The include the base MAIL-02 fixtures name: IPv4 and IPv6 ranges, -all. */
const PROVIDER_INCLUDE = q('TXT', '_spf.provider.example', 'spf-include', {
  answers: [txt('v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all')],
});

/** One more include than the 10 DNS lookups RFC 7208 allows. */
const ELEVEN_INCLUDES = Array.from({ length: 11 }, (_, i) => `s${i}.provider.example`);

/** MAIL-02 on the further mail domains: the DMARC matrix of each domain uses that domain's DMARC only. */
const MAIL_02_FURTHER_DOMAINS: DnsFixture[] = [
  {
    file: 'violation-contact-permissive.json',
    description:
      'The Impressum address domain ends its SPF with ?all: permissive-qualifier for that domain only',
    expect: { status: 'completed', variants: ['permissive-qualifier'] },
    queries: [
      ...siteDmarc(REJECT),
      ...SITE_SPF_FAIL,
      ...CONTACT_WITHOUT_DMARC,
      q('TXT', 'example-mail.de', 'spf', { answers: [txt('v=spf1 a mx ?all')] }),
      q('A', 'example-mail.de', 'spf-void-check', { answers: [{ type: 'A', value: '192.0.2.20' }] }),
    ],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
  {
    file: 'clean-contact-fail-all.json',
    description: 'The Impressum address domain ends its SPF with -all: no finding',
    expect: { status: 'completed', variants: [] },
    queries: [
      ...siteDmarc(REJECT),
      ...SITE_SPF_FAIL,
      ...CONTACT_WITHOUT_DMARC,
      q('TXT', 'example-mail.de', 'spf', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
    ],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
  {
    file: 'inconclusive-contact-spf-servfail.json',
    description:
      'SERVFAIL after retry on the SPF of the Impressum address domain: partial (mail-domain-unresolved), never record-not-found',
    expect: { status: 'partial', variants: [] },
    queries: [
      ...siteDmarc(REJECT),
      ...SITE_SPF_FAIL,
      ...CONTACT_WITHOUT_DMARC,
      q('TXT', 'example-mail.de', 'spf', { rcode: 'SERVFAIL', attempts: 2 }),
    ],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
  {
    file: 'violation-final-softfail.json',
    description:
      'The redirect target example.net ends its SPF with ~all and has no DMARC record: softfail-without-enforcement for example.net, the scanned domain stays clean',
    expect: { status: 'completed', variants: ['softfail-without-enforcement'] },
    queries: [
      ...siteDmarc(REJECT),
      ...SITE_SPF_FAIL,
      q('MX', 'example.net', 'mx', { answers: [mxOf('mx.example.net')] }),
      q('TXT', '_dmarc.www.example.net', 'dmarc', { ...NX, treeWalkStep: 0 }),
      q('TXT', '_dmarc.example.net', 'dmarc-tree-walk', { ...NX, treeWalkStep: 1 }),
      q('TXT', '_dmarc.net', 'dmarc-tree-walk', { ...NX, treeWalkStep: 2 }),
      q('TXT', 'example.net', 'spf', { answers: [txt('v=spf1 ip4:192.0.2.0/24 ~all')] }),
    ],
    mailDomains: [FINAL],
    mailDomainStage: STAGE,
  },
  {
    file: 'counterexample-softfail-other-domain-enforced.json',
    description:
      "Counterexample: the scanned domain's ~all without DMARC stays softfail-without-enforcement although the Impressum address domain enforces DMARC",
    expect: { status: 'completed', variants: ['softfail-without-enforcement'] },
    queries: [
      ...siteDmarc(null),
      spf('v=spf1 ip4:192.0.2.0/24 ~all'),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
      q('TXT', '_dmarc.example-mail.de', 'dmarc', { answers: [txt(REJECT)], treeWalkStep: 0 }),
      q('TXT', 'example-mail.de', 'spf', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
    ],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
];

/** The common selector names of test/data/dns/dkim.yaml, in query order. */
const COMMON_SELECTORS = ['default', 'dkim', 'mail', 's1', 's2', 'k1', 'key1'] as const;

type PlanRow = readonly [selector: string, reason: DkimPlanEntry['reason'], given?: boolean];

/** A DKIM plan of one domain; rows without a reason are common names. */
function dkimPlan(domain: string, rows: readonly (string | PlanRow)[]): DkimPlanEntry[] {
  return rows.map((r) => {
    const [selector, reason, given] = typeof r === 'string' ? ([r, 'common', false] as const) : r;
    return { domain, selector, reason, given: given ?? false };
  });
}

/** What the collector plans for a Microsoft 365 domain: the two fixed selectors, then common names up to 8. */
const M365_ROWS: (string | PlanRow)[] = [
  ['selector1', 'provider:microsoft-365', true],
  ['selector2', 'provider:microsoft-365', true],
  ...COMMON_SELECTORS.slice(0, 6),
];

const dkimQuery = (
  selector: string,
  rest: { rcode?: DnsRcode; answers?: DnsAnswer[]; attempts?: number } = NX,
  domain = 'example.de',
): Query => q('TXT', `${selector}._domainkey.${domain}`, 'dkim', rest);

/** One query per planned selector: `answers` names the selectors that answer, every other one is NXDOMAIN. */
function dkimQueries(
  rows: readonly (string | PlanRow)[],
  answers: Record<string, { rcode?: DnsRcode; answers?: DnsAnswer[]; attempts?: number }> = {},
  domain = 'example.de',
): Query[] {
  return rows.map((r) => {
    const selector = typeof r === 'string' ? r : r[0];
    return dkimQuery(selector, answers[selector] ?? NX, domain);
  });
}

const key = (record: string) => ({ answers: [txt(record)] });

/** Microsoft 365: its MX host and its SPF include, which together make selector1 and selector2 given. */
const M365_SITE: Query[] = [
  q('MX', 'example.de', 'mx', { answers: [mxOf('example-de.mail.protection.outlook.com')] }),
  spf('v=spf1 include:spf.protection.outlook.com -all'),
  q('TXT', 'spf.protection.outlook.com', 'spf-include', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
];

/** A domain with its own mail server: no provider recognised, the plan is the common names. */
const OWN_MX_SITE: Query[] = [
  q('MX', 'example.de', 'mx', { answers: [mxOf('mx.example.de')] }),
  spf('v=spf1 ip4:192.0.2.0/24 -all'),
];

const SITE_M365_PLAN = dkimPlan('example.de', M365_ROWS);
const SITE_COMMON_PLAN = dkimPlan('example.de', COMMON_SELECTORS);

const MAIL_03: DnsFixture[] = [
  {
    file: 'violation-given-selector-missing.json',
    description:
      'Microsoft 365 MX and SPF include; selector1, selector2 and every probed common name NXDOMAIN: given-selector-missing',
    expect: { status: 'completed', variants: ['given-selector-missing'] },
    queries: [...M365_SITE, ...dkimQueries(M365_ROWS)],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'clean-given-selector-key.json',
    description: 'Microsoft 365: selector1 publishes an RSA key of 2048 bits: no finding',
    expect: { status: 'completed', variants: [] },
    queries: [...M365_SITE, ...dkimQueries(M365_ROWS, { selector1: key(dkimRecord(rsaKey(2048))) })],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'error-given-selector-servfail.json',
    description: 'SERVFAIL after retry on selector1, no key elsewhere: error, never given-selector-missing',
    expect: { status: 'error', variants: [], reason: 'exception' },
    queries: [...M365_SITE, ...dkimQueries(M365_ROWS, { selector1: { rcode: 'SERVFAIL', attempts: 2 } })],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'counterexample-key-on-other-selector.json',
    description:
      'Counterexample: the Microsoft 365 selectors are NXDOMAIN, but the common name s1 publishes a key: the domain signs with another selector, no finding',
    expect: { status: 'completed', variants: [] },
    queries: [...M365_SITE, ...dkimQueries(M365_ROWS, { s1: key(dkimRecord(rsaKey(2048))) })],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'counterexample-m365-inbound-only.json',
    description:
      'Counterexample: Microsoft 365 MX without its SPF include (mail sent elsewhere): its selectors are not given, only selectors-not-found',
    expect: { status: 'completed', variants: ['selectors-not-found'] },
    queries: [
      q('MX', 'example.de', 'mx', { answers: [mxOf('example-de.mail.protection.outlook.com')] }),
      spf('v=spf1 ip4:192.0.2.0/24 -all'),
      ...dkimQueries(COMMON_SELECTORS),
    ],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'violation-operator-selector-missing.json',
    description:
      'The selector the operator configured is NXDOMAIN and no probed name has a key: given-selector-missing',
    expect: { status: 'completed', variants: ['given-selector-missing'] },
    queries: [...OWN_MX_SITE, ...dkimQueries([['mailing', 'operator', true], ...COMMON_SELECTORS])],
    dkimPlan: dkimPlan('example.de', [['mailing', 'operator', true], ...COMMON_SELECTORS]),
  },
  {
    file: 'inconclusive-given-selector-revoked.json',
    description:
      'Microsoft 365: both selectors publish a withdrawn key (empty p=), no other key: inconclusive (key-revoked), no finding',
    expect: { status: 'inconclusive', variants: [], reason: 'key-revoked' },
    queries: [
      ...M365_SITE,
      ...dkimQueries(M365_ROWS, {
        selector1: key('v=DKIM1; k=rsa; p='),
        selector2: key('v=DKIM1; k=rsa; p='),
      }),
    ],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'inconclusive-given-selector-capped.json',
    description:
      'DSGVO_CHECK_DNS_DKIM_MAX_SELECTORS=1 left selector2 unqueried, selector1 is NXDOMAIN: inconclusive (dkim-selectors-capped), never given-selector-missing',
    expect: { status: 'inconclusive', variants: [], reason: 'dkim-selectors-capped' },
    queries: [...M365_SITE, dkimQuery('selector1')],
    dkimPlan: [
      { domain: 'example.de', selector: 'selector1', reason: 'provider:microsoft-365', given: true },
      {
        domain: 'example.de',
        selector: 'selector2',
        reason: 'provider:microsoft-365',
        given: true,
        capped: true,
      },
    ],
  },
  {
    file: 'inconclusive-unknown-dkim-version.json',
    description:
      'selector1 publishes a record of another DKIM version, no other key: inconclusive (key-unparsable), never given-selector-missing',
    expect: { status: 'inconclusive', variants: [], reason: 'key-unparsable' },
    queries: [...M365_SITE, ...dkimQueries(M365_ROWS, { selector1: key(`v=DKIM2; p=${rsaKey(2048)}`) })],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'violation-key-rsa-768.json',
    description:
      'The selector default publishes an RSA key of 768 bits: key-too-short (RFC 8301 requires 1024)',
    expect: { status: 'completed', variants: ['key-too-short'] },
    queries: [...OWN_MX_SITE, ...dkimQueries(COMMON_SELECTORS, { default: key(dkimRecord(rsaKey(768))) })],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'clean-key-rsa-1024-boundary.json',
    description: 'An RSA key of exactly 1024 bits at the default threshold of 1024: no finding',
    expect: { status: 'completed', variants: [] },
    queries: [...OWN_MX_SITE, ...dkimQueries(COMMON_SELECTORS, { default: key(dkimRecord(rsaKey(1024))) })],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'counterexample-ed25519.json',
    description: 'Counterexample: an Ed25519 key (32 bytes) has no RSA length: no key-too-short',
    expect: { status: 'completed', variants: [] },
    queries: [
      ...OWN_MX_SITE,
      ...dkimQueries(COMMON_SELECTORS, { default: key(dkimRecord(ED25519_KEY, 'ed25519')) }),
    ],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'counterexample-revoked-and-valid.json',
    description:
      'Counterexample: selector2 is revoked (empty p=) while selector1 has a key of 2048 bits, the usual key rotation: no finding',
    expect: { status: 'completed', variants: [] },
    queries: [
      ...M365_SITE,
      ...dkimQueries(M365_ROWS, {
        selector1: key(dkimRecord(rsaKey(2048))),
        selector2: key('v=DKIM1; k=rsa; p='),
      }),
    ],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'inconclusive-key-unparsable.json',
    description:
      'A key record whose p= is not a readable key, no other key: inconclusive (key-unparsable), neither key-too-short nor a missing key',
    expect: { status: 'inconclusive', variants: [], reason: 'key-unparsable' },
    queries: [...M365_SITE, ...dkimQueries(M365_ROWS, { selector1: key('v=DKIM1; k=rsa; p=MIIBIjANBgkq') })],
    dkimPlan: SITE_M365_PLAN,
  },
  {
    file: 'violation-selectors-not-found.json',
    description: 'Own MX, no provider recognised, every probed selector NXDOMAIN: selectors-not-found (info)',
    expect: { status: 'completed', variants: ['selectors-not-found'] },
    queries: [...OWN_MX_SITE, ...dkimQueries(COMMON_SELECTORS)],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'clean-common-selector-key.json',
    description: 'The common name dkim publishes a key of 2048 bits: no finding',
    expect: { status: 'completed', variants: [] },
    queries: [...OWN_MX_SITE, ...dkimQueries(COMMON_SELECTORS, { dkim: key(dkimRecord(rsaKey(2048))) })],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'error-common-selector-timeout.json',
    description: 'TIMEOUT after retry on s2, no key elsewhere: error, never selectors-not-found',
    expect: { status: 'error', variants: [], reason: 'exception' },
    queries: [...OWN_MX_SITE, ...dkimQueries(COMMON_SELECTORS, { s2: { rcode: 'TIMEOUT', attempts: 2 } })],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'counterexample-google-not-fixed.json',
    description:
      'Counterexample: Google Workspace MX and SPF, selector google NXDOMAIN: the customer can change that prefix, so only selectors-not-found',
    expect: { status: 'completed', variants: ['selectors-not-found'] },
    queries: [
      q('MX', 'example.de', 'mx', { answers: [mxOf('smtp.google.com')] }),
      spf('v=spf1 include:_spf.google.com ~all'),
      q('TXT', '_spf.google.com', 'spf-include', { answers: [txt('v=spf1 ip4:192.0.2.0/24 ~all')] }),
      ...dkimQueries([['google', 'provider:google-workspace', false], ...COMMON_SELECTORS]),
    ],
    dkimPlan: dkimPlan('example.de', [['google', 'provider:google-workspace', false], ...COMMON_SELECTORS]),
  },
  {
    file: 'counterexample-non-dkim-txt.json',
    description:
      'Counterexample: a wildcard TXT answers every selector name with a verification token: no key, no key-too-short, no unparsable key',
    expect: { status: 'completed', variants: ['selectors-not-found'] },
    queries: [
      ...OWN_MX_SITE,
      ...COMMON_SELECTORS.map((s) => dkimQuery(s, key('site-verification=0123456789abcdef'))),
    ],
    dkimPlan: SITE_COMMON_PLAN,
  },
  {
    file: 'other-null-mx.json',
    description: 'Null MX (RFC 7505): the domain sends no mail, no selector was queried: not_applicable',
    expect: { status: 'not_applicable', variants: [], reason: 'null-mx' },
    queries: [
      q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: '.', priority: 0 }] }),
      spf('v=spf1 -all'),
    ],
    dkimPlan: [],
  },
  {
    file: 'inconclusive-dkim-not-collected.json',
    description: 'A snapshot from before DKIM was collected: inconclusive (dkim-not-collected)',
    expect: { status: 'inconclusive', variants: [], reason: 'dkim-not-collected' },
    queries: OWN_MX_SITE,
  },
  {
    file: 'inconclusive-dns-budget-exhausted.json',
    description:
      'The query budget ran out before the last three selectors: inconclusive (dns-budget-exhausted), never selectors-not-found',
    expect: { status: 'inconclusive', variants: [], reason: 'dns-budget-exhausted' },
    queries: [...OWN_MX_SITE, ...dkimQueries(COMMON_SELECTORS.slice(0, 4))],
    dkimPlan: SITE_COMMON_PLAN,
    errors: [{ code: 'dns-budget-exhausted', message: 'DNS query budget of 60 exhausted' }],
  },
  {
    file: 'counterexample-contact-domain-own-result.json',
    description:
      'Counterexample: the scanned domain has a key, the Impressum address domain on Microsoft 365 has none: given-selector-missing for that domain only',
    expect: { status: 'completed', variants: ['given-selector-missing'] },
    queries: [
      ...OWN_MX_SITE,
      ...dkimQueries(COMMON_SELECTORS, { default: key(dkimRecord(rsaKey(2048))) }),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('example-mail-de.mail.protection.outlook.com')] }),
      q('TXT', 'example-mail.de', 'spf', {
        answers: [txt('v=spf1 include:spf.protection.outlook.com -all')],
      }),
      q('TXT', 'spf.protection.outlook.com', 'spf-include', {
        answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')],
      }),
      ...dkimQueries(M365_ROWS, {}, 'example-mail.de'),
    ],
    dkimPlan: [...SITE_COMMON_PLAN, ...dkimPlan('example-mail.de', M365_ROWS)],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
  {
    file: 'inconclusive-contact-domain-servfail.json',
    description:
      'SERVFAIL on a selector of the Impressum address domain, no key there: partial (mail-domain-unresolved), the scanned domain still evaluated',
    expect: { status: 'partial', variants: [] },
    queries: [
      ...OWN_MX_SITE,
      ...dkimQueries(COMMON_SELECTORS, { default: key(dkimRecord(rsaKey(2048))) }),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
      q('TXT', 'example-mail.de', 'spf', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
      ...dkimQueries(COMMON_SELECTORS, { mail: { rcode: 'SERVFAIL', attempts: 2 } }, 'example-mail.de'),
    ],
    dkimPlan: [...SITE_COMMON_PLAN, ...dkimPlan('example-mail.de', COMMON_SELECTORS)],
    mailDomains: [contact('example-mail.de')],
    mailDomainStage: STAGE,
  },
];

export const DNS_FIXTURES: Record<string, DnsFixture[]> = {
  'MAIL-01': [
    {
      file: 'clean-org-record-via-tree-walk.json',
      description:
        'Counterexample: www has no own record (NXDOMAIN) but the organizational domain does, so no "record-not-found"',
      expect: { status: 'completed', variants: [] },
      queries: siteDmarc('v=DMARC1; p=quarantine; rua=mailto:[redacted]@example.de').slice(0, 3),
    },
    {
      file: 'clean-reject.json',
      description: 'Enforcing DMARC with reporting',
      expect: { status: 'completed', variants: [] },
      queries: siteDmarc('v=DMARC1; p=reject; rua=mailto:[redacted]@example.de; adkim=s'),
    },
    {
      file: 'counterexample-null-mx.json',
      description:
        'Counterexample: Null MX domain without DMARC is info weak-option (Null MX without p=reject), not warning record-not-found',
      expect: { status: 'completed', variants: ['weak-option'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: '.', priority: 0 }] }),
        ...siteDmarc(null).slice(1),
      ],
    },
    {
      file: 'counterexample-sp-none-info.json',
      description: 'Counterexample: sp=none under p=reject is only info weak-option',
      expect: { status: 'completed', variants: ['weak-option'] },
      queries: siteDmarc('v=DMARC1; p=reject; sp=none; rua=mailto:[redacted]@example.de'),
    },
    {
      file: 'error-servfail.json',
      description: 'SERVFAIL after retry on _dmarc.example.de: error, never "no record"',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: siteDmarc({ rcode: 'SERVFAIL', attempts: 2 }),
    },
    {
      file: 'error-timeout.json',
      description: 'TIMEOUT after retry on _dmarc.example.de: error, never "no record"',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: siteDmarc({ rcode: 'TIMEOUT', attempts: 2 }),
    },
    {
      file: 'other-not-applicable-ip.json',
      description: 'IP target: no mail domain',
      expect: { status: 'not_applicable', variants: [], reason: 'ip-target' },
      domain: '192.0.2.10',
      host: '192.0.2.10',
      notApplicable: 'ip-target',
      queries: [],
    },
    {
      file: 'violation-invalid-multiple.json',
      description: 'Two DMARC records at _dmarc.example.de: receivers discard both',
      expect: { status: 'completed', variants: ['record-invalid'] },
      queries: siteDmarc(['v=DMARC1; p=reject', 'v=DMARC1; p=none; rua=mailto:[redacted]@example.de']),
    },
    {
      file: 'violation-legacy-pct.json',
      description: 'Enforcing DMARC (p=quarantine) applied to only half of the mail via the legacy pct tag',
      expect: { status: 'completed', variants: ['legacy-pct'] },
      queries: siteDmarc('v=DMARC1; p=quarantine; pct=50; rua=mailto:[redacted]@example.de'),
    },
    {
      file: 'violation-missing.json',
      description: 'No DMARC record on www, the organizational domain or the TLD',
      expect: { status: 'completed', variants: ['record-not-found'] },
      queries: siteDmarc(null),
    },
    {
      file: 'violation-p-none.json',
      description: 'DMARC in monitoring mode only (p=none) with reporting',
      expect: { status: 'completed', variants: ['policy-none'] },
      queries: siteDmarc('v=DMARC1; p=none; rua=mailto:[redacted]@example.de'),
    },
    ...MAIL_01_FURTHER_DOMAINS,
  ],
  'MAIL-02': [
    {
      file: 'clean-fail-all.json',
      description: 'SPF with include and -all, DMARC reject',
      expect: { status: 'completed', variants: [] },
      queries: [...siteDmarc(REJECT), spf('v=spf1 mx include:_spf.provider.example -all'), PROVIDER_INCLUDE],
    },
    {
      file: 'counterexample-softfail-dmarc-reject.json',
      description:
        'Counterexample: ~all with DMARC p=reject is info softfail-with-enforcement (BSI TR-03182), not warning',
      expect: { status: 'completed', variants: ['softfail-with-enforcement'] },
      queries: [...siteDmarc(REJECT), spf('v=spf1 include:_spf.provider.example ~all'), PROVIDER_INCLUDE],
    },
    {
      file: 'error-dmarc-unknown.json',
      description: '~all while the DMARC lookup failed: the matrix cannot be evaluated',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: [
        ...siteDmarc({ rcode: 'TIMEOUT', attempts: 2 }),
        spf('v=spf1 include:_spf.provider.example ~all'),
        PROVIDER_INCLUDE,
      ],
    },
    {
      file: 'error-servfail.json',
      description: 'SERVFAIL after retry on the SPF lookup: error, not "missing"',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: [...siteDmarc(REJECT), q('TXT', 'example.de', 'spf', { rcode: 'SERVFAIL', attempts: 2 })],
    },
    {
      file: 'other-include-timeout.json',
      description: 'Include lookup timed out: partial, the +all result stays',
      expect: { status: 'partial', variants: ['permissive-qualifier'] },
      queries: [
        ...siteDmarc(REJECT),
        spf('v=spf1 include:_spf.provider.example +all'),
        q('TXT', '_spf.provider.example', 'spf-include', { rcode: 'TIMEOUT', attempts: 2 }),
      ],
    },
    {
      file: 'violation-missing.json',
      description: 'No v=spf1 record at example.de',
      expect: { status: 'completed', variants: ['record-not-found'] },
      queries: [...siteDmarc(REJECT), q('TXT', 'example.de', 'spf', { rcode: 'NODATA' })],
    },
    {
      file: 'violation-multiple-records.json',
      description: 'Two v=spf1 records: permerror',
      expect: { status: 'completed', variants: ['record-invalid'] },
      queries: [
        ...siteDmarc(REJECT),
        spf('v=spf1 include:_spf.provider.example -all', 'v=spf1 mx ~all'),
        PROVIDER_INCLUDE,
      ],
    },
    {
      file: 'violation-permerror-lookups.json',
      description: '11 include lookups: more than the RFC 7208 limit of 10',
      expect: { status: 'completed', variants: ['record-invalid'] },
      queries: [
        ...siteDmarc(REJECT),
        spf(`v=spf1 ${ELEVEN_INCLUDES.map((host) => `include:${host}`).join(' ')} -all`),
        ...ELEVEN_INCLUDES.map((host) =>
          q('TXT', host, 'spf-include', { answers: [txt('v=spf1 ip4:192.0.2.1 -all')] }),
        ),
      ],
    },
    {
      file: 'violation-ptr-mechanism.json',
      description:
        'SPF with -all and DMARC reject, but the record still authorizes senders via the deprecated ptr mechanism',
      expect: { status: 'completed', variants: ['ptr-mechanism'] },
      queries: [...siteDmarc(REJECT), spf('v=spf1 ptr include:_spf.provider.example -all'), PROVIDER_INCLUDE],
    },
    {
      file: 'violation-softfail-no-dmarc.json',
      description: '~all while DMARC is p=none: softfail without enforcement',
      expect: { status: 'completed', variants: ['softfail-without-enforcement'] },
      queries: [
        ...siteDmarc('v=DMARC1; p=none; rua=mailto:[redacted]@example.de'),
        spf('v=spf1 include:_spf.provider.example ~all'),
        PROVIDER_INCLUDE,
      ],
    },
    ...MAIL_02_FURTHER_DOMAINS,
  ],
  'MAIL-03': MAIL_03,
};

/** The fixture as the loader reads it: the queries with the fixed resolver, clock and budget of these fixtures. */
export function dnsFixture(f: DnsFixture): RawFixture {
  const queries = f.queries.map((r, i) => ({
    id: `dns-${String(i + 1).padStart(3, '0')}`,
    qname: r.qname,
    type: r.type,
    purpose: r.purpose,
    queriedAt: '2026-10-30T12:00:00.000Z',
    durationMs: 12,
    ...(r.treeWalkStep !== undefined ? { treeWalkStep: r.treeWalkStep } : {}),
    rcode: r.rcode ?? 'NOERROR',
    answers: r.answers ?? [],
    attempts: r.attempts ?? 1,
  }));
  return {
    $description: f.description,
    $expect: f.expect,
    dns: {
      resolver: { kind: 'system', servers: ['192.0.2.53'] },
      domain: f.domain ?? 'example.de',
      host: f.host ?? 'www.example.de',
      queries,
      budget: { limit: 60, used: queries.length },
      errors: f.errors ?? [],
      ...(f.notApplicable ? { notApplicable: f.notApplicable } : {}),
      ...(f.mailDomains ? { mailDomains: f.mailDomains } : {}),
      ...(f.mailDomainStage ? { mailDomainStage: f.mailDomainStage } : {}),
      ...(f.dkimPlan ? { dkimPlan: f.dkimPlan } : {}),
    },
  } as RawFixture;
}
