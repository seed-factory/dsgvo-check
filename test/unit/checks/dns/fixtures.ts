/**
 * Snapshot fixtures of the DNS checks, built in memory: one row per DNS query (type, name, purpose and what differs
 * from a NOERROR answer without records). Every fixture is run by the completeness test against its `$expect`.
 */
import type {
  DnsAnswer,
  DnsQueryRecord,
  DnsRcode,
  DnsRecordType,
  MailDomainStage,
  MailDomainTarget,
} from '../../../../src/core/snapshot/dns.ts';
import type { FixtureExpect, RawFixture } from '../../../utils/snapshot-builder.ts';

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

/** www.example.de without a record of its own; `_dmarc.example.de` decides (null = no record there either). */
function siteDmarc(record: string | null): Query[] {
  return [
    q('MX', 'example.de', 'mx', { answers: [mxOf('mx.example.de')] }),
    q('TXT', '_dmarc.www.example.de', 'dmarc', { ...NX, treeWalkStep: 0 }),
    record
      ? q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { answers: [txt(record)], treeWalkStep: 1 })
      : q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { ...NX, treeWalkStep: 1 }),
    q('TXT', '_dmarc.de', 'dmarc-tree-walk', { ...NX, treeWalkStep: 2 }),
  ];
}

const REJECT = 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de';
const IMPRESSUM = 'https://www.example.de/impressum/';
const STAGE: MailDomainStage = { contacts: 'impressum', durationMs: 4 };

/** An address domain of the Impressum, checked with its own budget. */
function contact(domain: string, over: Partial<MailDomainTarget> = {}): MailDomainTarget {
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
  q('TXT', 'example.de', 'spf', { answers: [txt('v=spf1 include:_spf.provider.example -all')] }),
  q('TXT', '_spf.provider.example', 'spf-include', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
];

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
      q('TXT', 'example.de', 'spf', { answers: [txt('v=spf1 ip4:192.0.2.0/24 ~all')] }),
      q('MX', 'example-mail.de', 'mx', { answers: [mxOf('mx.example-mail.de')] }),
      q('TXT', '_dmarc.example-mail.de', 'dmarc', { answers: [txt(REJECT)], treeWalkStep: 0 }),
      q('TXT', 'example-mail.de', 'spf', { answers: [txt('v=spf1 ip4:192.0.2.0/24 -all')] }),
    ],
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
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=quarantine; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=quarantine; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
      ],
    },
    {
      file: 'clean-reject.json',
      description: 'Enforcing DMARC with reporting',
      expect: { status: 'completed', variants: [] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de; adkim=s',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de; adkim=s'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'counterexample-null-mx.json',
      description:
        'Counterexample: Null MX domain without DMARC is info weak-option (Null MX without p=reject), not warning record-not-found',
      expect: { status: 'completed', variants: ['weak-option'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: '.', priority: 0 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 1 }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'counterexample-sp-none-info.json',
      description: 'Counterexample: sp=none under p=reject is only info weak-option',
      expect: { status: 'completed', variants: ['weak-option'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; sp=none; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; sp=none; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'error-servfail.json',
      description: 'SERVFAIL after retry on _dmarc.example.de: error, never "no record"',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { rcode: 'SERVFAIL', treeWalkStep: 1, attempts: 2 }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'error-timeout.json',
      description: 'TIMEOUT after retry on _dmarc.example.de: error, never "no record"',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { rcode: 'TIMEOUT', treeWalkStep: 1, attempts: 2 }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
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
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            { type: 'TXT', value: 'v=DMARC1; p=reject', chunks: ['v=DMARC1; p=reject'] },
            {
              type: 'TXT',
              value: 'v=DMARC1; p=none; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=none; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'violation-legacy-pct.json',
      description: 'Enforcing DMARC (p=quarantine) applied to only half of the mail via the legacy pct tag',
      expect: { status: 'completed', variants: ['legacy-pct'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=quarantine; pct=50; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=quarantine; pct=50; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'violation-missing.json',
      description: 'No DMARC record on www, the organizational domain or the TLD',
      expect: { status: 'completed', variants: ['record-not-found'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 1 }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    {
      file: 'violation-p-none.json',
      description: 'DMARC in monitoring mode only (p=none) with reporting',
      expect: { status: 'completed', variants: ['policy-none'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=none; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=none; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
      ],
    },
    ...MAIL_01_FURTHER_DOMAINS,
  ],
  'MAIL-02': [
    {
      file: 'clean-fail-all.json',
      description: 'SPF with include and -all, DMARC reject',
      expect: { status: 'completed', variants: [] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 mx include:_spf.provider.example -all',
              chunks: ['v=spf1 mx include:_spf.provider.example -all'],
            },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
              chunks: ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'],
            },
          ],
        }),
      ],
    },
    {
      file: 'counterexample-softfail-dmarc-reject.json',
      description:
        'Counterexample: ~all with DMARC p=reject is info softfail-with-enforcement (BSI TR-03182), not warning',
      expect: { status: 'completed', variants: ['softfail-with-enforcement'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 include:_spf.provider.example ~all',
              chunks: ['v=spf1 include:_spf.provider.example ~all'],
            },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
              chunks: ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'],
            },
          ],
        }),
      ],
    },
    {
      file: 'error-dmarc-unknown.json',
      description: '~all while the DMARC lookup failed: the matrix cannot be evaluated',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', { rcode: 'TIMEOUT', treeWalkStep: 1, attempts: 2 }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 include:_spf.provider.example ~all',
              chunks: ['v=spf1 include:_spf.provider.example ~all'],
            },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
              chunks: ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'],
            },
          ],
        }),
      ],
    },
    {
      file: 'error-servfail.json',
      description: 'SERVFAIL after retry on the SPF lookup: error, not "missing"',
      expect: { status: 'error', variants: [], reason: 'exception' },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', { rcode: 'SERVFAIL', attempts: 2 }),
      ],
    },
    {
      file: 'other-include-timeout.json',
      description: 'Include lookup timed out: partial, the +all result stays',
      expect: { status: 'partial', variants: ['permissive-qualifier'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 include:_spf.provider.example +all',
              chunks: ['v=spf1 include:_spf.provider.example +all'],
            },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', { rcode: 'TIMEOUT', attempts: 2 }),
      ],
    },
    {
      file: 'violation-missing.json',
      description: 'No v=spf1 record at example.de',
      expect: { status: 'completed', variants: ['record-not-found'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', { rcode: 'NODATA' }),
      ],
    },
    {
      file: 'violation-multiple-records.json',
      description: 'Two v=spf1 records: permerror',
      expect: { status: 'completed', variants: ['record-invalid'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 include:_spf.provider.example -all',
              chunks: ['v=spf1 include:_spf.provider.example -all'],
            },
            { type: 'TXT', value: 'v=spf1 mx ~all', chunks: ['v=spf1 mx ~all'] },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
              chunks: ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'],
            },
          ],
        }),
      ],
    },
    {
      file: 'violation-permerror-lookups.json',
      description: '11 include lookups: more than the RFC 7208 limit of 10',
      expect: { status: 'completed', variants: ['record-invalid'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value:
                'v=spf1 include:s0.provider.example include:s1.provider.example include:s2.provider.example include:s3.provider.example include:s4.provider.example include:s5.provider.example include:s6.provider.example include:s7.provider.example include:s8.provider.example include:s9.provider.example include:s10.provider.example -all',
              chunks: [
                'v=spf1 include:s0.provider.example include:s1.provider.example include:s2.provider.example include:s3.provider.example include:s4.provider.example include:s5.provider.example include:s6.provider.example include:s7.provider.example include:s8.provider.example include:s9.provider.example include:s10.provider.example -all',
              ],
            },
          ],
        }),
        q('TXT', 's0.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's1.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's2.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's3.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's4.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's5.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's6.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's7.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's8.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's9.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
        q('TXT', 's10.provider.example', 'spf-include', {
          answers: [
            { type: 'TXT', value: 'v=spf1 ip4:192.0.2.1 -all', chunks: ['v=spf1 ip4:192.0.2.1 -all'] },
          ],
        }),
      ],
    },
    {
      file: 'violation-ptr-mechanism.json',
      description:
        'SPF with -all and DMARC reject, but the record still authorizes senders via the deprecated ptr mechanism',
      expect: { status: 'completed', variants: ['ptr-mechanism'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ptr include:_spf.provider.example -all',
              chunks: ['v=spf1 ptr include:_spf.provider.example -all'],
            },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
              chunks: ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'],
            },
          ],
        }),
      ],
    },
    {
      file: 'violation-softfail-no-dmarc.json',
      description: '~all while DMARC is p=none: softfail without enforcement',
      expect: { status: 'completed', variants: ['softfail-without-enforcement'] },
      queries: [
        q('MX', 'example.de', 'mx', { answers: [{ type: 'MX', value: 'mx.example.de', priority: 10 }] }),
        q('TXT', '_dmarc.www.example.de', 'dmarc', { rcode: 'NXDOMAIN', treeWalkStep: 0 }),
        q('TXT', '_dmarc.example.de', 'dmarc-tree-walk', {
          answers: [
            {
              type: 'TXT',
              value: 'v=DMARC1; p=none; rua=mailto:[redacted]@example.de',
              chunks: ['v=DMARC1; p=none; rua=mailto:[redacted]@example.de'],
            },
          ],
          treeWalkStep: 1,
        }),
        q('TXT', '_dmarc.de', 'dmarc-tree-walk', { rcode: 'NXDOMAIN', treeWalkStep: 2 }),
        q('TXT', 'example.de', 'spf', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 include:_spf.provider.example ~all',
              chunks: ['v=spf1 include:_spf.provider.example ~all'],
            },
          ],
        }),
        q('TXT', '_spf.provider.example', 'spf-include', {
          answers: [
            {
              type: 'TXT',
              value: 'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
              chunks: ['v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 -all'],
            },
          ],
        }),
      ],
    },
    ...MAIL_02_FURTHER_DOMAINS,
  ],
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
      errors: [],
      ...(f.notApplicable ? { notApplicable: f.notApplicable } : {}),
      ...(f.mailDomains ? { mailDomains: f.mailDomains } : {}),
      ...(f.mailDomainStage ? { mailDomainStage: f.mailDomainStage } : {}),
    },
  } as RawFixture;
}
