// DNS collector: `node:dns/promises` with `ctx.network.dnsServers` when non-empty (system configuration otherwise),
// direct even with `--proxy`. At most `dns.queryBudget` queries for the scanned domain, and after the browser at most
// `dns.mailDomainQueryBudget` for each further mail domain, DKIM selectors included; `mailto:` masked before storing.
import { isIP } from 'node:net';
import type { CollectorContext, DnsCollector } from '../../core/snapshot/collector.ts';
import type { DnsSection } from '../../core/snapshot/dns.ts';
import { registrableDomain } from '../../core/url/url.ts';
import { collectMailDns, collectMailDomains, type DkimOptions } from './collect.ts';
import { selectMailTargets } from './mail-targets.ts';
import { createNodeDnsClient, type DnsClient } from './resolver.ts';
import { loadDkimRules, loadMailDomainRules } from './rules.ts';

function createClient(ctx: CollectorContext): DnsClient {
  const cfg = ctx.config.dns;
  return createNodeDnsClient({
    servers: ctx.network.dnsServers,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
  });
}

function dkimOptions(ctx: CollectorContext): DkimOptions {
  const cfg = ctx.config.dns;
  return { selectors: cfg.dkimSelectors, maxSelectors: cfg.dkimMaxSelectors, rules: loadDkimRules() };
}

function notApplicable(host: string, reason: string, budget: number): DnsSection {
  return {
    resolver: { kind: 'system', servers: [] },
    domain: host,
    host,
    queries: [],
    budget: { limit: budget, used: 0 },
    errors: [],
    notApplicable: reason,
  };
}

export const collectDns: DnsCollector = async (ctx) => {
  const cfg = ctx.config.dns;
  const host = ctx.target.host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host))
    return { status: 'ok', sections: { dns: notApplicable(host, 'ip-target', cfg.queryBudget) } };
  const domain = ctx.target.etld1 ?? registrableDomain(host);
  if (!domain) {
    return { status: 'ok', sections: { dns: notApplicable(host, 'no-registrable-domain', cfg.queryBudget) } };
  }

  let client: DnsClient;
  try {
    client = createClient(ctx);
  } catch (err) {
    const message = `invalid DNS server configuration: ${(err as Error).message}`;
    return {
      status: 'error',
      reason: 'resolver-config',
      sections: {},
      error: { code: 'resolver-config', message },
    };
  }
  const onAbort = () => client.cancel();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await collectMailDns({
      host,
      domain,
      client,
      now: ctx.now,
      signal: ctx.signal,
      log: ctx.log,
      budget: cfg.queryBudget,
      concurrency: cfg.concurrency,
      maxTimeoutResults: cfg.maxTimeoutResults,
      dkim: dkimOptions(ctx),
    });
    return { status: r.status, ...(r.reason ? { reason: r.reason } : {}), sections: { dns: r.section } };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
};

/**
 * The DNS stage after the browser: the domain of the final host and the address domains of the Impressum, which the
 * first stage could not know. It extends `ctx.snapshot.dns`; without that section (DNS not run, IP target) it does
 * nothing.
 */
export const collectDnsFollowUp: DnsCollector = async (ctx) => {
  const first = ctx.snapshot.dns;
  if (!first || first.notApplicable) return { status: 'skipped', reason: 'no-dns-section', sections: {} };

  const cfg = ctx.config.dns;
  const t0 = performance.now();
  const plan = selectMailTargets(ctx.snapshot, {
    maxMailDomains: cfg.maxMailDomains,
    freeMail: loadMailDomainRules().freeMail,
  });
  const stage = (section: DnsSection): DnsSection => ({
    ...section,
    mailDomainStage: { contacts: plan.contacts, durationMs: Math.round(performance.now() - t0) },
  });
  if (plan.targets.length === 0)
    return { status: 'ok', sections: { dns: stage({ ...first, mailDomains: [] }) } };

  // The first stage validated the resolver configuration; a client built from it again cannot fail differently.
  const client = createClient(ctx);
  const onAbort = () => client.cancel();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const section = await collectMailDomains({
      section: first,
      plan,
      client,
      now: ctx.now,
      signal: ctx.signal,
      log: ctx.log,
      budget: cfg.mailDomainQueryBudget,
      concurrency: cfg.concurrency,
      maxTimeoutResults: cfg.maxTimeoutResults,
      dkim: dkimOptions(ctx),
    });
    const stopped = section.mailDomains?.some(
      (d) => d.status !== 'checked' && d.reason !== 'free-mail' && d.reason !== 'limit',
    );
    return { status: stopped ? 'partial' : 'ok', sections: { dns: stage(section) } };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
};
