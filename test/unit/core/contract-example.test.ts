/**
 * The check example from docs/prototype/CONTRACTS.md §5, compiled and executed as an L1 test.
 * It is NOT registered (id EXAMPLE-01); it documents the pattern for module tests.
 */
import { describe, expect, it } from 'vitest';
import { defineCheck, subjects } from '../../../src/core/api.ts';
import {
  makeDns,
  makeDnsQuery,
  makeSnapshot,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../utils/snapshot-builder.ts';

const example01 = defineCheck({
  id: 'EXAMPLE-01',
  module: 'dns',
  requires: ['dns'],
  variants: [{ variant: 'missing' }],
  run(slice) {
    const q = slice.dns.queries.find((x) => x.purpose === 'dmarc');
    if (!q) throw new Error('no DMARC query in snapshot');
    if (q.rcode === 'SERVFAIL' || q.rcode === 'TIMEOUT') throw new Error(`DMARC lookup ${q.rcode}`);
    if (q.rcode === 'NXDOMAIN' || q.answers.length === 0) {
      return [
        {
          checkId: 'EXAMPLE-01',
          variant: 'missing',
          confidence: 'high',
          subject: subjects.record('dmarc'),
          phases: ['dns'],
          pages: [],
          params: { domain: slice.dns.domain },
          evidence: [{ type: 'dns', qname: q.qname, qtype: q.type, rcode: q.rcode, records: [] }],
        },
      ];
    }
    return [];
  },
});

const dmarc = (rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL', value?: string) =>
  makeSnapshot({
    dns: makeDns({
      queries: [
        makeDnsQuery({
          qname: '_dmarc.example.de',
          purpose: 'dmarc',
          rcode,
          answers: value ? [{ type: 'TXT', value }] : [],
        }),
      ],
    }),
  });

describe('contract example (L1 pattern)', () => {
  it('violation: no record', () => {
    const r = runCheck(example01, dmarc('NXDOMAIN'));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['missing']);
    expect(observationsOf(r)[0]?.subject).toBe('dmarc');
  });

  it('clean: record present', () => {
    expect(variantsOf(runCheck(example01, dmarc('NOERROR', 'v=DMARC1; p=reject')))).toEqual([]);
  });

  it('error: SERVFAIL is not "no record"', () => {
    expect(runCheck(example01, dmarc('SERVFAIL'))).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it('missing section: collector skipped → skipped with its reason', () => {
    const snap = makeSnapshot({
      collection: { dns: { status: 'skipped', reason: 'not-implemented', durationMs: 0 } },
    });
    expect(runCheck(example01, snap)).toMatchObject({ status: 'skipped', reason: 'not-implemented' });
  });
});
