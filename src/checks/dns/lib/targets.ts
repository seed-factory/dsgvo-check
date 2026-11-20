/**
 * The mail domains a MAIL-* check evaluates: the scanned domain, then the further domains of the DNS stage after the
 * browser (the site's domain after a redirect, Impressum address domains). Each is evaluated on its own; only the
 * scanned domain's unknown answers fail the check, a further domain's become a limitation that names it.
 */
import type { DnsSection, MailDomainTarget } from '../../../core/snapshot/dns.ts';

export type MailScope = 'site' | 'final' | 'contact';

export interface MailTarget {
  scope: MailScope;
  /** Scope part of the record subject (`final`, `contact:<domain>`); null for the scanned domain, whose subject stays the bare kind. */
  subjectScope: string | null;
  /** Domain whose MX and SPF are evaluated. */
  domain: string;
  /** Start of the DMARC Tree Walk. */
  host: string;
  /** Registrable domain: a record from here down is the domain's own policy. */
  orgDomain: string;
  /** Pages where the domain was seen (Impressum), for the finding's pages. */
  pages: string[];
}

/** An answer that is missing or failed: no conclusion about this domain. */
export class InconclusiveDnsError extends Error {
  override name = 'InconclusiveDnsError';
}

export function siteTarget(dns: DnsSection, targetHost: string): MailTarget {
  return {
    scope: 'site',
    subjectScope: null,
    domain: dns.domain,
    host: dns.host ?? targetHost,
    orgDomain: dns.domain,
    pages: [],
  };
}

function furtherTarget(t: MailDomainTarget): MailTarget {
  const final = t.roles.includes('final');
  return {
    scope: final ? 'final' : 'contact',
    subjectScope: final ? 'final' : `contact:${t.domain}`,
    domain: t.domain,
    host: t.host,
    orgDomain: t.orgDomain,
    pages: [...new Set(t.sources.map((s) => s.url))],
  };
}

export interface FurtherTargets {
  targets: MailTarget[];
  /** What the stage could not check: capped, not collected, or stopped before a domain's first query. */
  limitations: string[];
}

export function furtherTargets(dns: DnsSection): FurtherTargets {
  const targets: MailTarget[] = [];
  const limitations: string[] = [];
  for (const t of dns.mailDomains ?? []) {
    if (t.status !== 'skipped') targets.push(furtherTarget(t));
    else if (t.reason === 'limit') limitations.push('mail-domains-capped');
    // A free-mail provider's settings are not the site's: left out on purpose, so no limitation.
    else if (t.reason !== 'free-mail') limitations.push(`mail-domain-unresolved:${t.domain}`);
  }

  const stage = dns.mailDomainStage;
  if (stage && (stage.error || stage.contacts === 'not-collected'))
    limitations.push('mail-domains-not-collected');
  return { targets, limitations: [...new Set(limitations)] };
}

/** Params every observation of a target carries: where the domain comes from and which domain was checked. */
export function scopeParams(t: MailTarget): { scope: MailScope; mailDomain: string } {
  return { scope: t.scope, mailDomain: t.domain };
}

/**
 * Runs `evaluate` on the scanned domain (its errors fail the check) and on each further domain (an inconclusive
 * answer becomes `mail-domain-unresolved:<domain>`). Limitations of a further domain are prefixed by the caller.
 */
export function evaluateTargets<T>(
  dns: DnsSection,
  targetHost: string,
  evaluate: (t: MailTarget) => { observations: T[]; limitations: string[] },
): { observations: T[]; limitations: string[] } {
  const site = evaluate(siteTarget(dns, targetHost));
  const observations = [...site.observations];
  const limitations = [...site.limitations];

  const further = furtherTargets(dns);
  for (const t of further.targets) {
    try {
      const r = evaluate(t);
      observations.push(...r.observations);
      limitations.push(...r.limitations);
    } catch (err) {
      if (!(err instanceof InconclusiveDnsError)) throw err;
      limitations.push(`mail-domain-unresolved:${t.domain}`);
    }
  }
  limitations.push(...further.limitations);
  return { observations, limitations: [...new Set(limitations)] };
}
