// DNS collector: `node:dns/promises` with `ctx.network.dnsServers` when non-empty (system configuration otherwise),
// direct even with `--proxy`. At most `dns.queryBudget` queries; `mailto:` masked before storing.
import { isIP } from 'node:net';
import type { DnsCollector } from '../../core/snapshot/collector.ts';
import type { DnsSection } from '../../core/snapshot/dns.ts';
import { registrableDomain } from '../../core/url/url.ts';
import { collectMailDns } from './collect.ts';
import { createNodeDnsClient, type DnsClient } from './resolver.ts';

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
    client = createNodeDnsClient({
      servers: ctx.network.dnsServers,
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
    });
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
    });
    return { status: r.status, ...(r.reason ? { reason: r.reason } : {}), sections: { dns: r.section } };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
};
