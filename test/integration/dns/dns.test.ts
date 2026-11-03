/** The real node:dns client and the DNS collector against a fake DNS server; the full `scan` path is in scan.test.ts. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mail01 } from '../../../src/checks/dns/mail-01.ts';
import { mail02 } from '../../../src/checks/dns/mail-02.ts';
import { collectDns } from '../../../src/collectors/dns/index.ts';
import { createNodeDnsClient } from '../../../src/collectors/dns/resolver.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import type { CollectorContext } from '../../../src/core/snapshot/collector.ts';
import { FIXED_NOW, makeSnapshot, makeTarget, runCheck, variantsOf } from '../../utils/snapshot-builder.ts';
import { type FakeDnsServer, localDnsNetwork, MAIL_SITE, startFakeDns } from './dns-server.ts';

let dns: FakeDnsServer;

beforeAll(async () => {
  dns = await startFakeDns(MAIL_SITE);
});

afterAll(async () => {
  await dns?.close();
});

describe('node:dns client against dns2', () => {
  it('joins TXT chunks, keeps NXDOMAIN and NODATA apart, reads Null MX', async () => {
    dns.setZone({
      'TXT spf.example.test': [['v=spf1 include:a.test ', '-all']],
      'MX nullmx.example.test': ['0 .'],
      'A nodata.example.test': ['192.0.2.1'],
    });
    const client = createNodeDnsClient({ servers: [dns.server], timeoutMs: 1000 });
    expect(client.resolver).toEqual({ kind: 'custom', servers: [dns.server] });
    const txt = await client.query('spf.example.test', 'TXT');
    expect(txt).toMatchObject({ rcode: 'NOERROR', attempts: 1 });
    expect(txt.answers).toEqual([
      { type: 'TXT', value: 'v=spf1 include:a.test -all', chunks: ['v=spf1 include:a.test ', '-all'] },
    ]);
    expect(await client.query('nullmx.example.test', 'MX')).toMatchObject({
      rcode: 'NOERROR',
      answers: [{ type: 'MX', value: '.', priority: 0 }],
    });
    expect((await client.query('gone.example.test', 'TXT')).rcode).toBe('NXDOMAIN');
    expect((await client.query('nodata.example.test', 'TXT')).rcode).toBe('NODATA');
  });

  it('retries SERVFAIL exactly once', async () => {
    dns.setZone({ 'TXT _dmarc.example.test': 'SERVFAIL' });
    const client = createNodeDnsClient({ servers: [dns.server], timeoutMs: 1000 });
    const r = await client.query('_dmarc.example.test', 'TXT');
    expect(r).toMatchObject({ rcode: 'SERVFAIL', attempts: 2 });
    expect(dns.requests).toEqual(['TXT _dmarc.example.test', 'TXT _dmarc.example.test']);
  });

  it('retries a timeout exactly once', async () => {
    dns.setZone({ 'TXT slow.example.test': 'DROP' });
    const client = createNodeDnsClient({ servers: [dns.server], timeoutMs: 200 });
    const r = await client.query('slow.example.test', 'TXT');
    expect(r).toMatchObject({ rcode: 'TIMEOUT', attempts: 2 });
    expect(dns.requests).toHaveLength(2);
  });

  it('does not retry REFUSED', async () => {
    dns.setZone({ 'TXT refused.example.test': 'REFUSED' });
    const client = createNodeDnsClient({ servers: [dns.server], timeoutMs: 1000 });
    expect(await client.query('refused.example.test', 'TXT')).toMatchObject({
      rcode: 'REFUSED',
      attempts: 1,
    });
  });
});

function collectorContext(url: string): CollectorContext {
  return {
    target: makeTarget(url),
    options: { maxPages: 6, screenshots: false, sandbox: 'require', lang: 'de', assumeRegion: null },
    network: localDnsNetwork(dns),
    userAgent: { http: 'test', token: 'test' },
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    artifactsDir: '/nonexistent',
    artifactsRelDir: 'artifacts',
    now: () => FIXED_NOW,
    log: silentLogger,
    snapshot: makeSnapshot(),
  };
}

describe('collectDns with dnsServers', () => {
  it('collects MX, the DMARC walk and the SPF tree; masks mailto; drops unrelated TXT', async () => {
    dns.setZone(MAIL_SITE);
    const r = await collectDns(collectorContext('https://www.example.test/'));
    expect(r.status).toBe('ok');
    const section = r.sections.dns;
    if (!section) throw new Error('no dns section');
    expect(section.queries.map((q) => `${q.type} ${q.qname} ${q.rcode}`)).toEqual([
      'MX example.test NOERROR',
      'TXT _dmarc.www.example.test NXDOMAIN',
      'TXT _dmarc.example.test NOERROR',
      'TXT example.test NOERROR',
      'TXT _spf.provider.test NOERROR',
    ]);
    expect(section.resolver).toEqual({ kind: 'custom', servers: [dns.server] });
    const json = JSON.stringify(section);
    expect(json).toContain('rua=mailto:[redacted]@example.test');
    expect(json).not.toContain('dmarc-reports@');
    expect(json).not.toContain('google-site-verification');

    const snap = makeSnapshot({ target: makeTarget('https://www.example.test/'), dns: section });
    expect(variantsOf(runCheck(mail01, snap))).toEqual(['policy-none']);
    expect(variantsOf(runCheck(mail02, snap))).toEqual(['softfail-without-enforcement']);
  });

  it('SERVFAIL on the DMARC names → MAIL-01 error, not "record-not-found"', async () => {
    dns.setZone({
      ...MAIL_SITE,
      'TXT _dmarc.www.example.test': 'SERVFAIL',
      'TXT _dmarc.example.test': 'SERVFAIL',
      'TXT _dmarc.test': 'SERVFAIL',
    });
    const r = await collectDns(collectorContext('https://www.example.test/'));
    const snap = makeSnapshot({ target: makeTarget('https://www.example.test/'), dns: r.sections.dns });
    expect(runCheck(mail01, snap)).toMatchObject({ status: 'error', reason: 'exception' });
  });
});
