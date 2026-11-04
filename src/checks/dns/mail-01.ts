/**
 * MAIL-01: DMARC (RFC 9989, legacy RFC 7489 `pct`) on the scanned host via the DNS Tree Walk, with the Null-MX matrix
 * (RFC 7505). SERVFAIL/TIMEOUT after the retry is an error, never "no record", even when a parent publishes one.
 */
import { defineCheck, type EvidenceInput, type Observation, subjects } from '../../core/api.ts';
import { analyzeDmarc, type DmarcAnalysis, type DmarcRecord } from './lib/dmarc.ts';
import { dnsEvidence } from './lib/evidence.ts';
import { lookupFromQueries, mxState } from './lib/records.ts';

const ID = 'MAIL-01';

type PolicyState = 'missing' | 'invalid' | 'none' | 'quarantine' | 'reject';

/** The host's own policy; a PSD-only record (RFC 9989 `psd`) does not count as the domain's own. */
function policyState(a: DmarcAnalysis): PolicyState {
  const f = a.found;
  if (!f || f.scope === 'psd') return 'missing';
  if (f.invalid || !f.record?.p) return 'invalid';
  return f.record.p;
}

type Emit = (variant: string, params: Observation['params'], extra?: EvidenceInput[]) => void;

/** Collects the observations of this check; each carries the Tree Walk evidence and the domain of the record. */
function observationEmitter(
  domain: string,
  walkEvidence: EvidenceInput[],
): { observations: Observation[]; emit: Emit } {
  const observations: Observation[] = [];
  const emit: Emit = (variant, params, extra = []) => {
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
  };
  return { observations, emit };
}

/** An unfinished or failed Tree Walk is a check error: "no record" must never be claimed from an unknown answer. */
function requireConclusiveWalk(dmarc: DmarcAnalysis): void {
  if (dmarc.state === 'incomplete') {
    throw new Error(`DMARC Tree Walk incomplete: ${dmarc.next?.qname} was not queried`);
  }
  if (dmarc.state === 'failed') {
    const failed = dmarc.failures.map((s) => `${s.qname} ${s.query.rcode}`).join(', ');
    throw new Error(`DMARC lookup failed after retry (${failed}); no conclusion about the policy`);
  }
}

/** RFC 7505 domain without mail reception: only `p=reject` is expected (M3AAWG); one weak-option finding. */
function emitNullMxFindings(policy: PolicyState, mxEvidence: EvidenceInput[], emit: Emit): void {
  if (policy !== 'reject') emit('weak-option', { kind: 'null-mx', policy, count: 1 }, mxEvidence);
}

/** Findings for a record that is valid: policy `none`, weak options and the legacy `pct` below 100. */
function emitRecordFindings(rec: DmarcRecord, emit: Emit): void {
  if (rec.p === 'none') emit('policy-none', {});

  // `sp=none`, `t=y` (with p≠none) and a missing rua are one `weak-option` finding with a list.
  const enforcing = rec.p !== null && rec.p !== 'none';
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
    requireConclusiveWalk(dmarc);

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
    const { observations, emit } = observationEmitter(own ? own.step.domain : dns.domain, walkEvidence);

    if (mx === 'null') {
      emitNullMxFindings(policyState(dmarc), mxQuery ? [dnsEvidence(mxQuery, dns)] : [], emit);
    } else if (!own) {
      emit('record-not-found', { inherited: found ? 'psd' : 'none' });
    } else if (own.invalid || !own.record) {
      emit('record-invalid', { reason: own.invalid ?? 'syntax' });
    } else {
      emitRecordFindings(own.record, emit);
    }

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations } : {}),
      observations,
    };
  },
});
