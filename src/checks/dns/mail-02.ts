/**
 * MAIL-02: SPF (RFC 7208) on the mail domain, evaluated together with DMARC (BSI TR-03182 accepts `~all` when DMARC is
 * enforced). Static analysis only. A Null-MX domain is evaluated like any other (M3AAWG recommends `v=spf1 -all`).
 * Each further mail domain is evaluated with its own DMARC: one domain's policy never enforces another's SPF.
 */
import { defineCheck, type EvidenceInput, type Observation, subjects } from '../../core/api.ts';
import type { DnsSection } from '../../core/snapshot/dns.ts';
import { analyzeDmarc, dmarcEnforcement } from './lib/dmarc.ts';
import { dnsEvidence } from './lib/evidence.ts';
import { type DnsLookup, lookupFromQueries, mxState, normalizeName } from './lib/records.ts';
import { analyzeSpf, type SpfAnalysis } from './lib/spf.ts';
import { evaluateTargets, InconclusiveDnsError, type MailTarget, scopeParams } from './lib/targets.ts';

const ID = 'MAIL-02';

type Emit = (
  variant: string,
  params: Observation['params'],
  extra?: EvidenceInput[],
  more?: Partial<Observation>,
) => void;

/** Collects the observations of one mail domain; each carries the SPF and Null-MX evidence and the mail domain. */
function observationEmitter(
  target: MailTarget,
  spf: SpfAnalysis,
  evidence: EvidenceInput[],
  nullMx: 'yes' | 'no',
): { observations: Observation[]; emit: Emit } {
  const observations: Observation[] = [];
  const emit: Emit = (variant, params, extra = [], more = {}) => {
    observations.push({
      checkId: ID,
      variant,
      confidence: 'high',
      subject: subjects.record('spf', target.subjectScope ?? undefined),
      phases: ['dns'],
      pages: target.pages,
      params: { domain: spf.domain, ...scopeParams(target), nullMx, ...params },
      evidence: [...evidence, ...extra],
      ...more,
    });
  };
  return { observations, emit };
}

/** Failed, missing or unfinished lookups are check errors, not findings: the result would be a guess. */
function requireConclusiveSpf(spf: SpfAnalysis): void {
  if (spf.state === 'pending')
    throw new InconclusiveDnsError(`SPF lookup for ${spf.domain} was not performed`);
  if (spf.state === 'failed') {
    throw new InconclusiveDnsError(
      `SPF lookup for ${spf.domain} failed after retry (${spf.query?.rcode}); no conclusion`,
    );
  }

  // A nested lookup that failed or was not made leaves the result open (SERVFAIL → error):
  // unless a fact of the resolved part already decides it (`+all` / `?all`, an established permerror).
  if (spf.state !== 'found' || spf.complete) return;
  const decided = spf.permerrors.length > 0 || spf.all === '+' || spf.all === '?';
  if (decided) return;

  const open = [
    ...spf.failures.map((q) => `${q.qname} ${q.rcode}`),
    ...spf.pending.map((p) => `${p.qname} not queried`),
  ].join(', ');
  throw new InconclusiveDnsError(
    `SPF tree of ${spf.domain} incomplete (${open}); no conclusion about the policy`,
  );
}

/** Queries made for `domain` inside the SPF tree (not the top-level TXT query): the evidence of a permerror there. */
function offendingEvidence(spf: SpfAnalysis, dns: DnsSection, domain: string): EvidenceInput[] {
  return spf.queries
    .filter((q) => q !== spf.query && normalizeName(q.qname) === domain)
    .map((q) => dnsEvidence(q, dns));
}

/** `~all` is acceptable when DMARC is enforced; DMARC is evaluated on the mail domain, like the SPF record. */
function emitSoftfail(t: MailTarget, dns: DnsSection, lookup: DnsLookup, emit: Emit): void {
  const dmarc = analyzeDmarc(t.domain, t.orgDomain, lookup);
  const policy = dmarcEnforcement(dmarc);
  if (policy === 'unknown') {
    throw new InconclusiveDnsError(
      'SPF ~all: DMARC policy unknown (lookup failed), the matrix cannot be evaluated',
    );
  }

  const decisive = dmarc.steps.at(-1);
  const dmarcSubject = subjects.record('dmarc', t.subjectScope ?? undefined);
  const related = [{ checkId: 'MAIL-01', subject: dmarcSubject, relation: 'dmarc-policy' }];
  const enforced = policy === 'quarantine' || policy === 'reject';
  emit(
    enforced ? 'softfail-with-enforcement' : 'softfail-without-enforcement',
    { dmarcPolicy: policy },
    decisive ? [dnsEvidence(decisive.query, dns)] : [],
    { related },
  );
}

/** The finding for the effective `all` qualifier; `-all` is the wanted state and reports nothing. */
function emitAllQualifierFinding(
  t: MailTarget,
  spf: SpfAnalysis,
  dns: DnsSection,
  lookup: DnsLookup,
  emit: Emit,
): void {
  switch (spf.all) {
    case null:
      throw new InconclusiveDnsError(
        `effective SPF all qualifier of ${spf.domain} unknown (redirect target not resolved)`,
      );
    case '+':
      emit('permissive-qualifier', { qualifier: '+all' });
      break;
    case '?':
      emit('permissive-qualifier', { qualifier: spf.allSource === 'default' ? 'none' : '?all' });
      break;
    case '~':
      emitSoftfail(t, dns, lookup, emit);
      break;
    default:
      break;
  }
}

/** The findings of one mail domain, with its limitations (MX unknown, SPF include tree not resolved). */
function evaluateDomain(
  t: MailTarget,
  dns: DnsSection,
  lookup: DnsLookup,
): { observations: Observation[]; limitations: string[] } {
  const spf = analyzeSpf(t.domain, lookup);
  requireConclusiveSpf(spf);

  const mxQuery = lookup(t.domain, 'MX');
  const mx = mxState(mxQuery);
  const site = t.scope === 'site';
  const limitations: string[] = [];
  if (mx === 'unknown') limitations.push(site ? 'mx-unknown' : `mail-domain-mx-unknown:${t.domain}`);
  if (spf.state === 'found' && !spf.complete) {
    limitations.push(site ? 'spf-include-unresolved' : `mail-domain-spf-incomplete:${t.domain}`);
  }

  const spfEvidence: EvidenceInput[] = spf.query ? [dnsEvidence(spf.query, dns)] : [];
  const mxEvidence: EvidenceInput[] = mx === 'null' && mxQuery ? [dnsEvidence(mxQuery, dns)] : [];
  const { observations, emit } = observationEmitter(
    t,
    spf,
    [...spfEvidence, ...mxEvidence],
    mx === 'null' ? 'yes' : 'no',
  );

  if (spf.state === 'none') {
    emit('record-not-found', {});
  } else if (spf.state === 'multiple') {
    emit('record-invalid', { reason: 'multiple-records', count: spf.records.length, lookups: 0 });
  } else if (spf.permerrors.length > 0) {
    const first = spf.permerrors[0] as (typeof spf.permerrors)[number];
    emit(
      'record-invalid',
      { reason: first.reason, count: 1, lookups: spf.lookups },
      offendingEvidence(spf, dns, first.domain),
    );
  } else {
    emitAllQualifierFinding(t, spf, dns, lookup, emit);
  }
  if (spf.state === 'found' && spf.ptr) emit('ptr-mechanism', {});
  return { observations, limitations };
}

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
    const { observations, limitations } = evaluateTargets(dns, slice.target.host, (t) =>
      evaluateDomain(t, dns, lookup),
    );

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations } : {}),
      observations,
    };
  },
});
