/**
 * DNS collector logic with a fake resolver client (no network): query plan, Tree Walk, SPF tree, budget,
 * redaction, retries and the circuit breaker. The real node:dns client is covered in test/integration/dns.
 */
import { describe, expect, it } from 'vitest';
import { mail01 } from '../../../../src/checks/dns/mail-01.ts';
import { mail02 } from '../../../../src/checks/dns/mail-02.ts';
import { mail03 } from '../../../../src/checks/dns/mail-03.ts';
import { collectMailDns, type DkimOptions } from '../../../../src/collectors/dns/collect.ts';
import { collectDns } from '../../../../src/collectors/dns/index.ts';
import { type DnsClient, errorToRcode, type RawDnsResult } from '../../../../src/collectors/dns/resolver.ts';
import { loadDkimRules } from '../../../../src/collectors/dns/rules.ts';
import { defaultConfig } from '../../../../src/core/config/schema.ts';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import type { CollectorContext } from '../../../../src/core/snapshot/collector.ts';
import type { DnsRecordType } from '../../../../src/core/snapshot/dns.ts';
import { defaultNetworkConfig } from '../../../../src/core/url/net.ts';
import {
  FIXED_NOW,
  makeSnapshot,
  makeTarget,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';
import { dkimRecord, rsaKey } from './dkim-keys.ts';
import type { ZoneSpec } from './zone.ts';

interface FakeClient extends DnsClient {
  calls: string[];
}

function fakeClient(spec: ZoneSpec): FakeClient {
  const calls: string[] = [];
  return {
    calls,
    resolver: { kind: 'custom', servers: ['192.0.2.53'] },
    cancel() {},
    async query(qname: string, type: DnsRecordType): Promise<RawDnsResult> {
      const key = `${type} ${qname}`;
      calls.push(key);
      const entry = spec[key] ?? 'NXDOMAIN';
      if (typeof entry === 'string') {
        const retried = entry === 'SERVFAIL' || entry === 'TIMEOUT';
        return {
          rcode: entry,
          answers: [],
          attempts: retried ? 2 : 1,
          durationMs: 1,
          ...(entry === 'NXDOMAIN' || entry === 'NODATA'
            ? {}
            : { error: { code: `E${entry}`, message: entry } }),
        };
      }
      const answers = entry.map((v) =>
        type === 'MX'
          ? { type, value: v.split(' ')[1] as string, priority: Number(v.split(' ')[0]) }
          : { type, value: v, chunks: [v] },
      );
      return { rcode: answers.length ? 'NOERROR' : 'NODATA', answers, attempts: 1, durationMs: 1 };
    },
  };
}

const RUA = 'rua=mailto:dmarc-reports@example.de';
const site: ZoneSpec = {
  'MX example.de': ['10 mx.example.de'],
  'TXT _dmarc.example.de': [`v=DMARC1; p=reject; ${RUA}`],
  'TXT example.de': ['google-site-verification=abc123', 'v=spf1 mx include:_spf.provider.example ~all'],
  'TXT _spf.provider.example': ['v=spf1 ip4:192.0.2.0/24 -all'],
};

const collect = (
  spec: ZoneSpec,
  o: { budget?: number; signal?: AbortSignal; host?: string; dkim?: DkimOptions } = {},
) => {
  const client = fakeClient(spec);
  const run = collectMailDns({
    host: o.host ?? 'www.example.de',
    domain: 'example.de',
    client,
    now: () => FIXED_NOW,
    ...(o.budget ? { budget: o.budget } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.dkim ? { dkim: o.dkim } : {}),
  });
  return { client, run };
};

/** The common selector names of test/data/dns/dkim.yaml, each asked under example.de. */
const COMMON_DKIM = ['default', 'dkim', 'mail', 's1', 's2', 'k1', 'key1'].map(
  (s) => `TXT ${s}._domainkey.example.de`,
);

describe('collectMailDns: query plan', () => {
  it('redacts spaced mailto and bare addresses in TXT records', async () => {
    const { run } = collect({
      ...site,
      'TXT _dmarc.example.de': ['v=DMARC1; p=none; rua=mailto: dmarc@example.de,other@example.de;'],
    });
    const answers = (await run).section.queries.flatMap((query) => query.answers);
    const txt = answers.find((answer) => answer.value.startsWith('v=DMARC1'));
    expect(txt?.value).toBe('v=DMARC1; p=none; rua=mailto:[redacted]@example.de,[redacted]@example.de;');
    expect(txt?.chunks?.join('')).toBe(txt?.value);
  });

  it('keeps the tags after an address in a record without spaces (shared redactText)', async () => {
    const { run } = collect({
      ...site,
      'TXT _dmarc.example.de': [
        'v=DMARC1;p=none;rua=mailto:dmarc@example.de;ruf=mailto:ruf@example.de;pct=100',
      ],
    });
    const answers = (await run).section.queries.flatMap((query) => query.answers);
    const txt = answers.find((answer) => answer.value.startsWith('v=DMARC1'));
    expect(txt?.value).toBe(
      'v=DMARC1;p=none;rua=mailto:[redacted]@example.de;ruf=mailto:[redacted]@example.de;pct=100',
    );
    expect(txt?.value).not.toContain('dmarc@');
  });

  it('MX, then the DMARC Tree Walk, then the SPF tree, then the DKIM selectors', async () => {
    const { client, run } = collect(site);

    const r = await run;

    expect(r.status).toBe('ok');
    expect(client.calls).toEqual([
      'MX example.de',
      'TXT _dmarc.www.example.de',
      'TXT _dmarc.example.de',
      'TXT example.de',
      'TXT _spf.provider.example',
      ...COMMON_DKIM,
    ]);

    const q = r.section.queries;
    expect(q.map((x) => x.purpose)).toEqual([
      'mx',
      'dmarc',
      'dmarc-tree-walk',
      'spf',
      'spf-include',
      ...COMMON_DKIM.map(() => 'dkim'),
    ]);
    expect(q.slice(0, 5).map((x) => x.treeWalkStep)).toEqual([undefined, 0, 1, undefined, undefined]);

    expect(r.section).toMatchObject({
      domain: 'example.de',
      host: 'www.example.de',
      resolver: { kind: 'custom', servers: ['192.0.2.53'] },
      budget: { limit: 60, used: 12 },
      errors: [],
    });
    expect(new Set(q.map((x) => x.id)).size).toBe(12);
    expect(q[0]?.queriedAt).toBe(FIXED_NOW.toISOString());
  });

  it('the section feeds MAIL-01, MAIL-02 and MAIL-03 (end to end)', async () => {
    const { run } = collect(site);
    const snap = makeSnapshot({ dns: (await run).section });

    expect(variantsOf(runCheck(mail01, snap))).toEqual([]);
    expect(variantsOf(runCheck(mail02, snap))).toEqual(['softfail-with-enforcement']);
    expect(variantsOf(runCheck(mail03, snap))).toEqual(['selectors-not-found']);
  });

  it('walks up to the TLD when no record exists', async () => {
    const { client, run } = collect({ ...site, 'TXT _dmarc.example.de': 'NXDOMAIN' });

    await run;

    expect(client.calls.filter((c) => c.includes('_dmarc'))).toEqual([
      'TXT _dmarc.www.example.de',
      'TXT _dmarc.example.de',
      'TXT _dmarc.de',
    ]);
  });

  it('also walks from the mail domain when the host has its own record', async () => {
    const { client, run } = collect({ ...site, 'TXT _dmarc.www.example.de': ['v=DMARC1; p=none'] });
    const r = await run;

    expect(client.calls.filter((c) => c.includes('_dmarc'))).toEqual([
      'TXT _dmarc.www.example.de',
      'TXT _dmarc.example.de',
    ]);
    const org = r.section.queries.find((q) => q.qname === '_dmarc.example.de');
    expect(org).toMatchObject({ purpose: 'dmarc-mail-domain', treeWalkStep: 0 });
  });

  it('stops the walk at a failed step (a parent cannot replace it) and records the failure', async () => {
    const { run } = collect({ ...site, 'TXT _dmarc.example.de': 'SERVFAIL' });
    const r = await run;

    const failed = r.section.queries.find((x) => x.qname === '_dmarc.example.de');
    expect(failed).toMatchObject({ rcode: 'SERVFAIL', attempts: 2 });
    expect(r.section.queries.map((x) => x.qname)).not.toContain('_dmarc.de');
    expect(r.section.errors).toEqual([
      expect.objectContaining({ code: 'servfail', message: expect.stringContaining('_dmarc.example.de') }),
    ]);
    expect(runCheck(mail01, makeSnapshot({ dns: r.section })).status).toBe('error');
  });

  it('reuses the MX answer for the SPF mx mechanism and queries each name once', async () => {
    const { client, run } = collect({
      ...site,
      'TXT example.de': ['v=spf1 mx include:a.example.net include:a.example.net -all'],
      'TXT a.example.net': ['v=spf1 -all'],
    });
    await run;

    expect(client.calls.filter((c) => c === 'MX example.de')).toHaveLength(1);
    expect(client.calls.filter((c) => c === 'TXT a.example.net')).toHaveLength(1);
  });

  it('stops following includes once the lookup limit is exceeded', async () => {
    // 15 includes, each of which includes one more name: far above the limit of 10 lookups
    const spec: ZoneSpec = { ...site };
    const includes = Array.from({ length: 15 }, (_, i) => `include:i${i}.example.net`).join(' ');
    spec['TXT example.de'] = [`v=spf1 ${includes} -all`];
    for (let i = 0; i < 15; i++) spec[`TXT i${i}.example.net`] = [`v=spf1 include:n${i}.example.net -all`];
    for (let i = 0; i < 15; i++) spec[`TXT n${i}.example.net`] = ['v=spf1 ip4:192.0.2.1 -all'];
    const { run } = collect(spec);

    const r = await run;

    expect(r.section.budget.used).toBeLessThanOrEqual(60);
    expect(variantsOf(runCheck(mail02, makeSnapshot({ dns: r.section })))).toEqual(['record-invalid']);
  });
});

const rules = loadDkimRules();
const dkim = (selectors: string[] = [], maxSelectors = 8): DkimOptions => ({
  selectors,
  maxSelectors,
  rules,
});

/** Microsoft 365: MX and SPF include, without DMARC. */
const m365: ZoneSpec = {
  'MX example.de': ['0 example-de.mail.protection.outlook.com'],
  'TXT _dmarc.example.de': [`v=DMARC1; p=reject; ${RUA}`],
  'TXT example.de': ['v=spf1 include:spf.protection.outlook.com -all'],
  'TXT spf.protection.outlook.com': ['v=spf1 ip4:192.0.2.0/24 include:spfb.protection.outlook.com -all'],
  'TXT spfb.protection.outlook.com': ['v=spf1 ip4:198.51.100.0/24 -all'],
};

describe('collectMailDns: DKIM selectors', () => {
  it('plans the operator selectors, then the provider selectors, then common names, up to the cap', async () => {
    const { run } = collect(m365, { dkim: dkim(['mailing', 'example.de/news', 'other.example/x'], 6) });
    const plan = (await run).section.dkimPlan?.map((e) => `${e.selector}:${e.reason}:${e.given}`);
    expect(plan).toEqual([
      'mailing:operator:true',
      'news:operator:true',
      'selector1:provider:microsoft-365:true',
      'selector2:provider:microsoft-365:true',
      'default:common:false',
      'dkim:common:false',
    ]);
  });

  it('asks every selector after the last SPF query, also one of a nested include', async () => {
    const { client, run } = collect(m365);
    await run;
    const lastSpf = client.calls.indexOf('TXT spfb.protection.outlook.com');
    const firstDkim = client.calls.findIndex((c) => c.includes('._domainkey.'));
    expect(lastSpf).toBeGreaterThan(0);
    expect(firstDkim).toBeGreaterThan(lastSpf);
    expect(client.calls.slice(firstDkim)).toEqual([
      'TXT selector1._domainkey.example.de',
      'TXT selector2._domainkey.example.de',
      ...COMMON_DKIM.slice(0, 6),
    ]);
  });

  it.each([
    ['Null MX', { 'MX example.de': ['0 .'], 'TXT example.de': ['v=spf1 -all'] }],
    ['neither MX nor SPF', { 'MX example.de': 'NXDOMAIN', 'TXT example.de': 'NXDOMAIN' }],
  ] as const)('%s: no selector is asked and the plan is empty', async (_label, spec) => {
    const { client, run } = collect({ 'TXT _dmarc.example.de': [`v=DMARC1; p=reject; ${RUA}`], ...spec });
    const r = await run;
    expect(client.calls.filter((c) => c.includes('_domainkey'))).toEqual([]);
    expect(r.section.dkimPlan).toEqual([]);
  });

  it('a budget that runs out among the selectors: the plan is kept, MAIL-03 is inconclusive, never selectors-not-found', async () => {
    // MX, two DMARC steps and the SPF tree take 5 queries; 3 of the 7 selectors fit.
    const r = await collect(site, { budget: 8 }).run;
    expect(r).toMatchObject({ status: 'partial', reason: 'dns-budget-exhausted' });
    expect(r.section.dkimPlan).toHaveLength(7);
    expect(r.section.queries.filter((q) => q.purpose === 'dkim')).toHaveLength(3);

    const check = runCheck(mail03, makeSnapshot({ dns: r.section }));
    expect(check).toMatchObject({ status: 'inconclusive', reason: 'dns-budget-exhausted' });
    expect(variantsOf(check)).toEqual([]);
    // MAIL-01 and MAIL-02 had all their answers before the selectors started.
    expect(runCheck(mail01, makeSnapshot({ dns: r.section })).status).toBe('completed');
    expect(runCheck(mail02, makeSnapshot({ dns: r.section })).status).toBe('completed');
  });

  it('a given selector over the cap is planned as capped and not asked', async () => {
    const { client, run } = collect(m365, { dkim: dkim([], 1) });
    const r = await run;
    expect(r.section.dkimPlan?.map((e) => `${e.selector}:${e.capped ?? false}`)).toEqual([
      'selector1:false',
      'selector2:true',
    ]);
    expect(client.calls.filter((c) => c.includes('_domainkey'))).toEqual([
      'TXT selector1._domainkey.example.de',
    ]);
  });

  it('timeouts on selector names do not mark the resolver unresponsive: the scanned domain stays ok for MAIL-01/02', async () => {
    const spec: ZoneSpec = { ...site };
    for (const name of ['default', 'dkim', 'mail', 's1', 's2'])
      spec[`TXT ${name}._domainkey.example.de`] = 'TIMEOUT';
    const { client, run } = collect(spec);
    const r = await run;
    expect(client.calls.filter((c) => c.includes('_domainkey'))).toHaveLength(7);
    expect(r.section.errors.map((e) => e.code)).not.toContain('resolver-unresponsive');
    expect(runCheck(mail03, makeSnapshot({ dns: r.section })).status).toBe('error');
  });

  it('keeps a record of another DKIM version, which MAIL-03 reads as unparsable, not as no key', async () => {
    const r = await collect({
      ...m365,
      'TXT selector1._domainkey.example.de': [`v=DKIM2; p=${rsaKey(2048)}`],
    }).run;
    const q = r.section.queries.find((x) => x.qname === 'selector1._domainkey.example.de');
    expect(q?.answers).toHaveLength(1);
    expect(q?.filteredAnswers).toBeUndefined();
    const check = runCheck(mail03, makeSnapshot({ dns: r.section }));
    expect(check).toMatchObject({ status: 'inconclusive', reason: 'key-unparsable' });
  });

  it('a name asked for SPF and as a selector keeps both records, so neither analysis loses its own', async () => {
    const key = dkimRecord(rsaKey(2048));
    const r = await collect(
      {
        ...site,
        'TXT example.de': ['v=spf1 include:selector1._domainkey.example.de -all'],
        'TXT selector1._domainkey.example.de': ['v=spf1 ip4:192.0.2.0/24 -all', key, 'site-verification=abc'],
      },
      { dkim: dkim(['selector1']) },
    ).run;
    const q = r.section.queries.filter((x) => x.qname === 'selector1._domainkey.example.de');
    expect(q).toHaveLength(1);
    expect(q[0]?.answers.map((a) => a.value)).toEqual(['v=spf1 ip4:192.0.2.0/24 -all', key]);
    expect(q[0]?.filteredAnswers).toBe(1);
    const snap = makeSnapshot({ dns: r.section });
    expect(variantsOf(runCheck(mail03, snap))).toEqual([]);
    expect(runCheck(mail02, snap).status).toBe('completed');
  });

  it('drops TXT answers at selector names that are no key record and counts them; keeps the key', async () => {
    const key = dkimRecord(rsaKey(2048));
    const r = await collect({
      ...site,
      'TXT default._domainkey.example.de': ['site-verification=0123456789abcdef', key],
      'TXT dkim._domainkey.example.de': ['v=DMARC1; p=reject'],
    }).run;
    const def = r.section.queries.find((q) => q.qname === 'default._domainkey.example.de');
    expect(def?.answers.map((a) => a.value)).toEqual([key]);
    expect(def?.filteredAnswers).toBe(1);
    const other = r.section.queries.find((q) => q.qname === 'dkim._domainkey.example.de');
    expect(other).toMatchObject({ answers: [], filteredAnswers: 1 });
    expect(JSON.stringify(r.section)).not.toContain('site-verification');
    expect(variantsOf(runCheck(mail03, makeSnapshot({ dns: r.section })))).toEqual([]);
  });
});

describe('collectMailDns: redaction and minimisation', () => {
  it('masks mailto: in values and chunks', async () => {
    const r = await collect(site).run;
    const json = JSON.stringify(r.section);

    expect(json).not.toContain('dmarc-reports@');
    const dmarc = r.section.queries.find((x) => x.qname === '_dmarc.example.de');
    expect(dmarc?.answers[0]?.value).toBe('v=DMARC1; p=reject; rua=mailto:[redacted]@example.de');
    expect(dmarc?.answers[0]?.chunks).toEqual(['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de']);
  });

  it('a mailto: split across TXT character-strings does not survive in chunks', async () => {
    const base = fakeClient(site);
    const split = ['v=DMARC1; p=reject; rua=mail', 'to:alice@example.de', ',mailto:bob', '@example.de'];
    const client: DnsClient = {
      ...base,
      async query(qname, type) {
        if (type !== 'TXT' || qname !== '_dmarc.example.de') return base.query(qname, type);
        return {
          rcode: 'NOERROR',
          answers: [{ type: 'TXT', value: split.join(''), chunks: split }],
          attempts: 1,
          durationMs: 1,
        };
      },
    };
    const r = await collectMailDns({
      host: 'www.example.de',
      domain: 'example.de',
      client,
      now: () => FIXED_NOW,
    });

    const json = JSON.stringify(r.section);
    expect(json).not.toContain('alice');
    expect(json).not.toContain('bob');
    const answer = r.section.queries.find((x) => x.qname === '_dmarc.example.de')?.answers[0];
    expect(answer?.value).toBe(
      'v=DMARC1; p=reject; rua=mailto:[redacted]@example.de,mailto:[redacted]@example.de',
    );
    // Chunks are re-cut from the redacted value: joined they equal the stored value.
    expect(answer?.chunks?.join('')).toBe(answer?.value);
  });

  it('drops unrelated TXT records at the SPF names (count only)', async () => {
    const r = await collect(site).run;

    const apex = r.section.queries.find((x) => x.qname === 'example.de' && x.type === 'TXT');
    expect(apex?.answers.map((a) => a.value)).toEqual(['v=spf1 mx include:_spf.provider.example ~all']);
    expect(apex?.filteredAnswers).toBe(1);
    expect(JSON.stringify(r.section)).not.toContain('google-site-verification');
  });
});

describe('collectMailDns: limits', () => {
  it('budget exhausted → partial with an error entry', async () => {
    const r = await collect(site, { budget: 3 }).run;

    expect(r.status).toBe('partial');
    expect(r.reason).toBe('dns-budget-exhausted');
    expect(r.section.budget).toEqual({ limit: 3, used: 3 });
    expect(r.section.errors.map((e) => e.code)).toContain('dns-budget-exhausted');

    // the missing SPF lookup makes MAIL-02 an error, not "record-not-found"
    expect(runCheck(mail02, makeSnapshot({ dns: r.section })).status).toBe('error');
  });

  it('an unresponsive resolver stops the collection after 3 timeouts', async () => {
    const spec: ZoneSpec = {
      'MX example.de': 'TIMEOUT',
      'TXT _dmarc.www.example.de': 'TIMEOUT',
      'TXT _dmarc.example.de': 'TIMEOUT',
      'TXT _dmarc.de': 'TIMEOUT',
      'TXT example.de': 'TIMEOUT',
    };
    const { client, run } = collect(spec);
    const r = await run;
    expect(client.calls).toHaveLength(3);
    expect(r).toMatchObject({ status: 'partial', reason: 'resolver-unresponsive' });
  });

  it('an aborted signal stops before any query', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, run } = collect(site, { signal: ac.signal });
    const r = await run;
    expect(client.calls).toEqual([]);
    expect(r).toMatchObject({ status: 'partial', reason: 'aborted' });
  });
});

describe('collectDns (collector entry point)', () => {
  const ctx = (url: string): CollectorContext =>
    ({
      target: makeTarget(url),
      options: { maxPages: 6, screenshots: false, sandbox: 'require', lang: 'de', assumeRegion: null },
      network: defaultNetworkConfig(),
      config: defaultConfig(),
      userAgent: { http: 'test', token: 'test' },
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      artifactsDir: '/nonexistent',
      artifactsRelDir: 'artifacts',
      now: () => FIXED_NOW,
      log: silentLogger,
      snapshot: makeSnapshot(),
    }) as CollectorContext;

  it.each([
    ['https://192.0.2.10/', 'ip-target'],
    ['https://[2001:db8::1]/', 'ip-target'],
    ['http://localhost:8080/', 'no-registrable-domain'],
  ])('%s → section with notApplicable=%s and no queries', async (url, reason) => {
    const r = await collectDns(ctx(url));
    expect(r.status).toBe('ok');
    expect(r.sections.dns).toMatchObject({ notApplicable: reason, queries: [], budget: { used: 0 } });
  });
});

describe('errorToRcode (node:dns error codes)', () => {
  it.each([
    ['ENOTFOUND', 'NXDOMAIN'],
    ['ENODATA', 'NODATA'],
    ['ESERVFAIL', 'SERVFAIL'],
    ['ETIMEOUT', 'TIMEOUT'],
    ['EREFUSED', 'REFUSED'],
    ['ECONNREFUSED', 'ERROR'],
    ['EBADRESP', 'ERROR'],
    ['constructor', 'ERROR'],
    [undefined, 'ERROR'],
  ])('%s → %s', (code, rcode) => {
    expect(errorToRcode(code)).toBe(rcode);
  });
});
