/**
 * MAIL-03: DKIM key records (RFC 6376) on the selectors the collector probed for each mail domain, and their RSA key
 * length (RFC 8301). Selectors are chosen freely, so a domain without a key on the probed names is only a warning
 * where a key is expected (a selector the operator set, or one a recognised provider always signs with) and info
 * otherwise. A published key does not show that mail is signed. Unknown answers give no finding: a failed lookup is an
 * error on the scanned domain; a used-up budget, an unreadable or withdrawn key, or a given selector over the selector
 * limit leaves it inconclusive; on a further mail domain each of them is a limitation that names the domain.
 */
import { defineCheck, type EvidenceInput, type Observation, subjects } from '../../core/api.ts';
import type { DkimPlanEntry, DnsSection } from '../../core/snapshot/dns.ts';
import { analyzeDkim, type DkimSelectorResult, type DkimSignals, dkimSignals } from './lib/dkim.ts';
import { dnsEvidence } from './lib/evidence.ts';
import { type DnsLookup, lookupFromQueries } from './lib/records.ts';
import {
  furtherTargets,
  InconclusiveDnsError,
  type MailTarget,
  scopeParams,
  siteTarget,
} from './lib/targets.ts';

const ID = 'MAIL-03';
/** RFC 8301 §3.2: verifiers must not accept signatures made with smaller RSA keys. */
const RFC_MIN_RSA_BITS = 1024;
/** Characters of `p=` kept in the evidence; the key length is in the finding, the full key in the snapshot. */
const SHOWN_KEY_CHARS = 32;

type OpenReason =
  | 'key-unparsable'
  | 'key-revoked'
  | 'dns-budget-exhausted'
  | 'dkim-selectors-capped'
  | 'dkim-not-collected';

/** The domain's answers are complete enough to read, but not to decide: no finding, the check stays inconclusive. */
class DkimUndecided extends InconclusiveDnsError {
  readonly reason: OpenReason;
  constructor(reason: OpenReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

type DomainResult =
  | { skipped: NonNullable<DkimSignals['skip']> }
  | { observations: Observation[]; limitations: string[] };

interface DomainContext {
  dns: DnsSection;
  lookup: DnsLookup;
  plan: readonly DkimPlanEntry[];
  minBits: number;
}

/** `p=` cut to its start, so the evidence stays readable. */
function shortenKey(record: string): string {
  return record.replace(/((?:^|;)\s*p\s*=\s*)([^;]*)/, (all, tag: string, key: string) => {
    const compact = key.replace(/\s+/g, '');
    return compact.length > SHOWN_KEY_CHARS ? `${tag}${compact.slice(0, SHOWN_KEY_CHARS)}…` : all;
  });
}

function emitter(t: MailTarget) {
  const observations: Observation[] = [];
  const emit = (variant: string, subject: string, params: Observation['params'], evidence: EvidenceInput[]) =>
    observations.push({
      checkId: ID,
      variant,
      confidence: 'high',
      subject: subjects.record(subject, t.subjectScope ?? undefined),
      phases: ['dns'],
      pages: t.pages,
      params: { domain: t.domain, ...scopeParams(t), ...params },
      evidence,
    });
  return { observations, emit };
}

const OPEN_STATES: ReadonlySet<string> = new Set(['failed', 'pending', 'capped']);
const failedOrOpen = (r: DkimSelectorResult) => OPEN_STATES.has(r.result.state);

/** No probed selector has a key, and every answer is final: the missing key is a fact on these selectors. */
function requireDecided(t: MailTarget, results: readonly DkimSelectorResult[], ctx: DomainContext): void {
  const failed = results.filter((r) => r.result.state === 'failed');
  if (failed.length > 0) {
    const list = failed.map((r) => `${r.query?.qname} ${r.query?.rcode}`).join(', ');
    throw new InconclusiveDnsError(`DKIM lookup failed after retry (${list}); no conclusion about the key`);
  }
  if (results.some((r) => r.result.state === 'unparsable')) {
    throw new DkimUndecided('key-unparsable', `DKIM key record of ${t.domain} not readable`);
  }
  // A withdrawn key is no usable one, but it is not a selector without a record either: left open, no finding.
  if (results.some((r) => r.result.state === 'revoked')) {
    throw new DkimUndecided(
      'key-revoked',
      `DKIM key of ${t.domain} withdrawn (empty p=), no other key found`,
    );
  }
  if (results.some((r) => r.result.state === 'pending')) {
    // The scanned domain's budget stop is recorded by the first stage; any other gap is an unexplained one.
    const budget = t.scope !== 'site' || ctx.dns.errors.some((e) => e.code === 'dns-budget-exhausted');
    const open = results.filter((r) => r.result.state === 'pending').map((r) => r.entry.selector);
    const message = `DKIM selectors of ${t.domain} not queried: ${open.join(', ')}`;
    throw budget ? new DkimUndecided('dns-budget-exhausted', message) : new InconclusiveDnsError(message);
  }
  if (results.some((r) => r.result.state === 'capped')) {
    const capped = results.filter((r) => r.result.state === 'capped').map((r) => r.entry.selector);
    throw new DkimUndecided(
      'dkim-selectors-capped',
      `given DKIM selectors of ${t.domain} over the selector limit: ${capped.join(', ')}`,
    );
  }
}

function missingKey(
  t: MailTarget,
  results: readonly DkimSelectorResult[],
  ctx: DomainContext,
  emit: ReturnType<typeof emitter>['emit'],
): void {
  const evidenceOf = (rs: readonly DkimSelectorResult[]) =>
    rs.flatMap((r) => (r.query ? [dnsEvidence(r.query, ctx.dns)] : []));
  const given = results.filter((r) => r.entry.given);
  const providerOf = (rs: readonly DkimSelectorResult[], fallback: string) =>
    rs
      .map((r) => r.entry.reason)
      .find((reason) => reason.startsWith('provider:'))
      ?.slice('provider:'.length) ?? fallback;

  if (given.length > 0) {
    const provider = providerOf(given, 'operator');
    // The MX and SPF answers are why a provider's selectors count as given; operator selectors need no such proof.
    const signals =
      provider === 'operator'
        ? []
        : [ctx.lookup(t.domain, 'MX'), ctx.lookup(t.domain, 'TXT')].flatMap((q) =>
            q ? [dnsEvidence(q, ctx.dns)] : [],
          );
    emit(
      'given-selector-missing',
      'dkim',
      {
        provider,
        selectors: given.map((r) => r.entry.selector).join(', '),
        count: results.length,
      },
      [...signals, ...evidenceOf(given)],
    );
    return;
  }
  emit(
    'selectors-not-found',
    'dkim',
    {
      provider: providerOf(results, 'none'),
      selectors: results.map((r) => r.entry.selector).join(', '),
      count: results.length,
    },
    evidenceOf(results),
  );
}

function evaluateDomain(t: MailTarget, ctx: DomainContext): DomainResult {
  const signals = dkimSignals(t.domain, ctx.lookup);
  if (signals.skip) return { skipped: signals.skip };
  const results = analyzeDkim(t.domain, ctx.plan, ctx.lookup);
  if (results.length === 0) {
    throw new DkimUndecided('dkim-not-collected', `no DKIM selector was planned for ${t.domain}`);
  }

  const site = t.scope === 'site';
  const limitations: string[] = [];
  // Without MX or SPF the provider stays unknown, and with it whether its selectors are given.
  if (signals.mx === 'unknown') limitations.push(site ? 'mx-unknown' : `mail-domain-mx-unknown:${t.domain}`);
  if (!signals.spfComplete) {
    limitations.push(site ? 'spf-include-unresolved' : `mail-domain-spf-incomplete:${t.domain}`);
  }

  const { observations, emit } = emitter(t);
  const withKey = results.filter((r) => r.result.state === 'key');
  if (withKey.length > 0) {
    for (const r of withKey) {
      if (r.result.state !== 'key' || r.result.rsaBits.length === 0 || !r.query) continue;
      const bits = Math.min(...r.result.rsaBits);
      if (bits >= ctx.minBits) continue;
      emit(
        'key-too-short',
        `dkim:${r.entry.selector}`,
        {
          selector: r.entry.selector,
          bits,
          minBits: ctx.minBits,
          belowRfc: bits < RFC_MIN_RSA_BITS ? 'yes' : 'no',
        },
        [dnsEvidence(r.query, ctx.dns, { formatRecord: shortenKey })],
      );
    }
    // A key settles whether one is published; an open selector could still hold a short one.
    if (results.some(failedOrOpen)) {
      limitations.push(site ? 'dkim-selectors-unresolved' : `mail-domain-unresolved:${t.domain}`);
    }
    return { observations, limitations };
  }

  requireDecided(t, results, ctx);
  missingKey(t, results, ctx, emit);
  return { observations, limitations };
}

/** A further domain that could not be decided: named in a limitation, never a finding. */
function furtherLimitation(t: MailTarget, err: InconclusiveDnsError): string {
  if (err instanceof DkimUndecided && err.reason === 'key-unparsable') {
    return `mail-domain-dkim-key-unparsable:${t.domain}`;
  }
  if (err instanceof DkimUndecided && err.reason === 'key-revoked')
    return `mail-domain-dkim-key-revoked:${t.domain}`;
  return `mail-domain-unresolved:${t.domain}`;
}

export const mail03 = defineCheck({
  id: ID,
  module: 'dns',
  requires: ['dns'],
  variants: [
    { variant: 'key-too-short' },
    { variant: 'given-selector-missing', variantGroup: 'presence' },
    { variant: 'selectors-not-found', variantGroup: 'presence' },
  ],
  run(slice, ctx) {
    const dns = slice.dns;
    if (dns.notApplicable) return { status: 'not_applicable', reason: dns.notApplicable, observations: [] };
    if (!dns.dkimPlan) return { status: 'inconclusive', reason: 'dkim-not-collected', observations: [] };

    const domainCtx: DomainContext = {
      dns,
      lookup: lookupFromQueries(dns.queries),
      plan: dns.dkimPlan,
      minBits: ctx.thresholds.dns.dkimMinRsaBits,
    };
    const observations: Observation[] = [];
    const limitations: string[] = [];

    let open: OpenReason | null = null;
    let siteSkip: NonNullable<DkimSignals['skip']> | null = null;
    try {
      const r = evaluateDomain(siteTarget(dns, slice.target.host), domainCtx);
      if ('skipped' in r) siteSkip = r.skipped;
      else {
        observations.push(...r.observations);
        limitations.push(...r.limitations);
      }
    } catch (err) {
      // A failed lookup of the scanned domain fails the check, as for MAIL-01 and MAIL-02.
      if (!(err instanceof DkimUndecided)) throw err;
      open = err.reason;
    }

    const further = furtherTargets(dns);
    let furtherEvaluated = 0;
    for (const t of further.targets) {
      try {
        const r = evaluateDomain(t, domainCtx);
        if ('skipped' in r) continue;
        furtherEvaluated++;
        observations.push(...r.observations);
        limitations.push(...r.limitations);
      } catch (err) {
        if (!(err instanceof InconclusiveDnsError)) throw err;
        furtherEvaluated++;
        limitations.push(furtherLimitation(t, err));
      }
    }
    limitations.push(...further.limitations);

    const unique = [...new Set(limitations)];
    const limited = unique.length > 0 ? { limitations: unique } : {};
    if (open) return { status: 'inconclusive', reason: open, observations, ...limited };
    if (siteSkip && furtherEvaluated === 0 && unique.length === 0) {
      return { status: 'not_applicable', reason: siteSkip, observations };
    }
    return { status: unique.length > 0 ? 'partial' : 'completed', ...limited, observations };
  },
});
