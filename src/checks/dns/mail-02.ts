/**
 * MAIL-02: SPF (RFC 7208) on the mail domain, evaluated together with DMARC (BSI TR-03182 accepts `~all` when
 * DMARC is enforced). Static analysis only: no statement about actual sending. Variant names: registry
 * docs/03-checks.md §2.1. A Null-MX domain (RFC 7505) is evaluated like any other domain (§3.11 has no Null-MX
 * exception; M3AAWG recommends `v=spf1 -all` for it), the texts mention the Null MX.
 */
import { defineCheck, type EvidenceInput, type Observation, subjects } from '../../core/api.ts';
import { analyzeDmarc, dmarcEnforcement } from './lib/dmarc.ts';
import { dnsEvidence } from './lib/evidence.ts';
import { lookupFromQueries, mxState, normalizeName } from './lib/records.ts';
import { analyzeSpf } from './lib/spf.ts';

const ID = 'MAIL-02';

export const mail02 = defineCheck({
  id: ID,
  module: 'dns',
  requires: ['dns'],
  variants: [
    { variant: 'record-not-found', variantGroup: 'policy' },
    { variant: 'permissive-qualifier', variantGroup: 'policy' },
    { variant: 'record-invalid', variantGroup: 'policy' },
    { variant: 'softfail-without-enforcement', variantGroup: 'policy' },
    { variant: 'softfail-with-enforcement', variantGroup: 'policy' },
    { variant: 'ptr-mechanism' },
  ],
  run(slice) {
    const dns = slice.dns;
    if (dns.notApplicable) return { status: 'not_applicable', reason: dns.notApplicable, observations: [] };
    const lookup = lookupFromQueries(dns.queries);
    const spf = analyzeSpf(dns.domain, lookup);
    if (spf.state === 'pending') throw new Error(`SPF lookup for ${spf.domain} was not performed`);
    if (spf.state === 'failed') {
      throw new Error(`SPF lookup for ${spf.domain} failed after retry (${spf.query?.rcode}); no conclusion`);
    }

    // S-23 (§4 MAIL-02: SERVFAIL → error): a nested lookup that failed or was not made leaves the result open
    // unless a fact of the resolved part already decides it (`+all` / `?all`, an established permerror).
    if (spf.state === 'found' && !spf.complete) {
      const decided = spf.permerrors.length > 0 || spf.all === '+' || spf.all === '?';
      if (!decided) {
        const open = [
          ...spf.failures.map((q) => `${q.qname} ${q.rcode}`),
          ...spf.pending.map((p) => `${p.qname} not queried`),
        ].join(', ');
        throw new Error(`SPF tree of ${spf.domain} incomplete (${open}); no conclusion about the policy`);
      }
    }

    const mxQuery = lookup(dns.domain, 'MX');
    const mx = mxState(mxQuery);
    const limitations: string[] = [];
    if (mx === 'unknown') limitations.push('mx-unknown');
    if (spf.state === 'found' && !spf.complete) limitations.push('spf-include-unresolved');

    const spfEvidence: EvidenceInput[] = spf.query ? [dnsEvidence(spf.query, dns)] : [];
    const mxEvidence: EvidenceInput[] = mx === 'null' && mxQuery ? [dnsEvidence(mxQuery, dns)] : [];
    const nullMx = mx === 'null' ? 'yes' : 'no';
    const observations: Observation[] = [];
    const emit = (
      variant: string,
      params: Observation['params'],
      extra: EvidenceInput[] = [],
      more: Partial<Observation> = {},
    ) =>
      observations.push({
        checkId: ID,
        variant,
        confidence: 'high',
        subject: subjects.record('spf'),
        phases: ['dns'],
        pages: [],
        params: { domain: spf.domain, nullMx, ...params },
        evidence: [...spfEvidence, ...mxEvidence, ...extra],
        ...more,
      });
    const offending = (domain: string): EvidenceInput[] =>
      spf.queries
        .filter((q) => q !== spf.query && normalizeName(q.qname) === domain)
        .map((q) => dnsEvidence(q, dns));
    const unknownAll = () => {
      throw new Error(`effective SPF all qualifier of ${spf.domain} unknown (redirect target not resolved)`);
    };

    if (spf.state === 'none') {
      emit('record-not-found', {});
    } else if (spf.state === 'multiple') {
      emit('record-invalid', { reason: 'multiple-records', count: spf.records.length, lookups: 0 });
    } else if (spf.permerrors.length > 0) {
      const first = spf.permerrors[0] as (typeof spf.permerrors)[number];
      emit(
        'record-invalid',
        { reason: first.reason, count: 1, lookups: spf.lookups },
        offending(first.domain),
      );
    } else {
      switch (spf.all) {
        case null:
          unknownAll();
          break;
        case '+':
          emit('permissive-qualifier', { qualifier: '+all' });
          break;
        case '?':
          emit('permissive-qualifier', { qualifier: spf.allSource === 'default' ? 'none' : '?all' });
          break;
        case '~': {
          // SPF is evaluated on the mail domain, so is the DMARC policy it is paired with.
          const dmarc = analyzeDmarc(dns.domain, dns.domain, lookup);
          const policy = dmarcEnforcement(dmarc);
          if (policy === 'unknown') {
            throw new Error('SPF ~all: DMARC policy unknown (lookup failed), the matrix cannot be evaluated');
          }
          const decisive = dmarc.steps.at(-1);
          const related = [
            { checkId: 'MAIL-01', subject: subjects.record('dmarc'), relation: 'dmarc-policy' },
          ];
          emit(
            policy === 'quarantine' || policy === 'reject'
              ? 'softfail-with-enforcement'
              : 'softfail-without-enforcement',
            { dmarcPolicy: policy },
            decisive ? [dnsEvidence(decisive.query, dns)] : [],
            { related },
          );
          break;
        }
        default:
          break;
      }
    }
    if (spf.state === 'found' && spf.ptr) emit('ptr-mechanism', {});

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations } : {}),
      observations,
    };
  },
});
