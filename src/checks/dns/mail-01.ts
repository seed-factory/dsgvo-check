/**
 * MAIL-01: DMARC (RFC 9989, legacy RFC 7489 `pct`) on the scanned host via the DNS Tree Walk, with the Null-MX
 * matrix (RFC 7505). SERVFAIL/TIMEOUT after the retry is an error, never "no record" — also when a parent name
 * publishes a record. Variant names: registry docs/03-checks.md §2.1.
 */
import { defineCheck, type EvidenceInput, type Observation, subjects } from '../../core/api.ts';
import { analyzeDmarc, type DmarcAnalysis } from './lib/dmarc.ts';
import { dnsEvidence } from './lib/evidence.ts';
import { lookupFromQueries, mxState } from './lib/records.ts';

const ID = 'MAIL-01';

/** The host's own policy; a PSD-only record (RFC 9989 `psd`) does not count as the domain's own. */
function policyState(a: DmarcAnalysis): 'missing' | 'invalid' | 'none' | 'quarantine' | 'reject' {
  const f = a.found;
  if (!f || f.scope === 'psd') return 'missing';
  if (f.invalid || !f.record?.p) return 'invalid';
  return f.record.p;
}

export const mail01 = defineCheck({
  id: ID,
  module: 'dns',
  requires: ['dns'],
  variants: [
    { variant: 'record-not-found', variantGroup: 'policy' },
    { variant: 'policy-none', variantGroup: 'policy' },
    { variant: 'record-invalid', variantGroup: 'policy' },
    { variant: 'weak-option' },
    { variant: 'legacy-pct' },
  ],
  run(slice) {
    const dns = slice.dns;
    if (dns.notApplicable) return { status: 'not_applicable', reason: dns.notApplicable, observations: [] };
    const lookup = lookupFromQueries(dns.queries);
    const dmarc = analyzeDmarc(dns.host ?? slice.target.host, dns.domain, lookup);
    if (dmarc.state === 'incomplete') {
      throw new Error(`DMARC Tree Walk incomplete: ${dmarc.next?.qname} was not queried`);
    }
    if (dmarc.state === 'failed') {
      const failed = dmarc.failures.map((s) => `${s.qname} ${s.query.rcode}`).join(', ');
      throw new Error(`DMARC lookup failed after retry (${failed}); no conclusion about the policy`);
    }

    const mxQuery = lookup(dns.domain, 'MX');
    const mx = mxState(mxQuery);
    const limitations: string[] = [];
    if (mx === 'unknown') limitations.push('mx-unknown');

    const treeWalk = dmarc.steps.map((s) => s.qname);
    const walkEvidence: EvidenceInput[] = dmarc.steps.map((s, i) =>
      dnsEvidence(s.query, dns, i === dmarc.steps.length - 1 ? { treeWalk } : {}),
    );
    const found = dmarc.found;
    const own = found && found.scope !== 'psd' ? found : null;
    const domain = own ? own.step.domain : dns.domain;
    const observations: Observation[] = [];
    const emit = (variant: string, params: Observation['params'], extra: EvidenceInput[] = []) =>
      observations.push({
        checkId: ID,
        variant,
        confidence: 'high',
        subject: subjects.record('dmarc'),
        phases: ['dns'],
        pages: [],
        params: { domain, ...params },
        evidence: [...walkEvidence, ...extra],
      });

    if (mx === 'null') {
      // RFC 7505 domain without mail reception: only `p=reject` is expected (M3AAWG); one weak-option finding.
      const policy = policyState(dmarc);
      if (policy !== 'reject') {
        emit(
          'weak-option',
          { kind: 'null-mx', policy, count: 1 },
          mxQuery ? [dnsEvidence(mxQuery, dns)] : [],
        );
      }
    } else if (!own) {
      emit('record-not-found', { inherited: found ? 'psd' : 'none' });
    } else if (own.invalid || !own.record) {
      emit('record-invalid', { reason: own.invalid ?? 'syntax' });
    } else {
      const rec = own.record;
      if (rec.p === 'none') emit('policy-none', {});
      const enforcing = rec.p !== null && rec.p !== 'none';
      // §3.10 step 7: sp=none and t=y (with p≠none) and a missing rua are one `weak-option` finding with a list.
      const options = {
        spNone: enforcing && rec.sp === 'none',
        testing: enforcing && rec.t === 'y',
        noRua: rec.rua.length === 0,
      };
      const count = Object.values(options).filter(Boolean).length;
      if (count > 0) {
        const yn = (b: boolean) => (b ? 'yes' : 'no');
        emit('weak-option', {
          kind: 'options',
          policy: rec.p ?? 'none',
          count,
          spNone: yn(options.spNone),
          testing: yn(options.testing),
          noRua: yn(options.noRua),
        });
      }
      if (enforcing && rec.pct !== null && rec.pct < 100) {
        emit('legacy-pct', { policy: rec.p ?? 'none', pct: rec.pct });
      }
    }

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations } : {}),
      observations,
    };
  },
});
