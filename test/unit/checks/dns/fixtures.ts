/**
 * Snapshot fixtures of the DNS checks, built in memory: one row per DNS query (type, name, purpose and what differs
 * from a NOERROR answer without records). Every fixture is run by the completeness test against its `$expect`.
 */
import type {
  DnsAnswer,
  DnsQueryRecord,
  DnsRcode,
  DnsRecordType,
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
}

const q = (
  type: DnsRecordType,
  qname: string,
  purpose: string,
  rest: { rcode?: DnsRcode; answers?: DnsAnswer[]; treeWalkStep?: number; attempts?: number } = {},
): Query => ({ type, qname, purpose, ...rest });

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
    },
  } as RawFixture;
}
