/**
 * The DNS stage after the browser with a fake resolver client (no network): which further mail domains it picks from
 * the snapshot (final host, Impressum addresses) and how it queries them next to the scanned domain's queries.
 */
import { describe, expect, it } from 'vitest';
import { collectMailDns, collectMailDomains } from '../../../../src/collectors/dns/collect.ts';
import { type MailTargetPlan, selectMailTargets } from '../../../../src/collectors/dns/mail-targets.ts';
import type { DnsClient, RawDnsResult } from '../../../../src/collectors/dns/resolver.ts';
import { loadMailDomainRules } from '../../../../src/collectors/dns/rules.ts';
import { redactText } from '../../../../src/core/redaction/redact.ts';
import type { DocumentPart, LinkFact } from '../../../../src/core/snapshot/browser.ts';
import type { DnsRecordType, DnsSection } from '../../../../src/core/snapshot/dns.ts';
import type { Snapshot } from '../../../../src/core/snapshot/index.ts';
import {
  FIXED_NOW,
  makeBrowser,
  makeDns,
  makeDocument,
  makeDom,
  makeLink,
  makePage,
  makePhase,
  makeSnapshot,
  makeTarget,
} from '../../../utils/snapshot-builder.ts';
import type { ZoneSpec } from './zone.ts';

const IMPRESSUM = 'https://www.example.de/impressum/';
const freeMail = loadMailDomainRules().freeMail;

function part(text: string, origin: DocumentPart['origin'] = 'visible'): DocumentPart {
  return { id: `p-${text.length}`, text: redactText(text), origin, sourceUrl: IMPRESSUM };
}

/** A scanned www.example.de with the given Impressum text parts, privacy text parts and Impressum page links. */
function snapshotWith(
  o: {
    impressum?: readonly DocumentPart[];
    privacy?: readonly DocumentPart[];
    links?: readonly LinkFact[];
    finalUrl?: string;
    browser?: boolean;
  } = {},
): Snapshot {
  const documents = [
    ...(o.impressum ? [makeDocument({ kind: 'impressum', url: IMPRESSUM, parts: [...o.impressum] })] : []),
    ...(o.privacy ? [makeDocument({ kind: 'privacy', parts: [...o.privacy] })] : []),
  ];
  const page = makePage({
    url: IMPRESSUM,
    role: 'impressum',
    order: 1,
    dom: makeDom({ links: [...(o.links ?? [])] }),
  });
  return makeSnapshot({
    target: makeTarget('https://www.example.de/', o.finalUrl ?? 'https://www.example.de/'),
    dns: makeDns({ domain: 'example.de', host: 'www.example.de' }),
    ...(o.browser === false
      ? {}
      : {
          browser: makeBrowser({
            phases: [makePhase('A', { pages: [makePage({ url: 'https://www.example.de/' }), page] })],
          }),
          documents: { documents, attempts: [] },
        }),
  });
}

const select = (s: Snapshot, maxMailDomains = 2) => selectMailTargets(s, { maxMailDomains, freeMail });
const domainsOf = (plan: MailTargetPlan) =>
  plan.targets.map((t) => `${t.domain}:${t.roles.join('+')}${t.skip ? `:${t.skip}` : ''}`);

const mailtoLink = (attr: string, over: Partial<LinkFact> = {}): LinkFact =>
  makeLink({ text: 'E-Mail schreiben', hrefKind: 'mailto', mailto: attr, region: 'main', ...over });

describe('selectMailTargets: contact domains from the Impressum only', () => {
  it('an address in the Impressum text → a contact target with that page as source', () => {
    const plan = select(snapshotWith({ impressum: [part('E-Mail: info@example-mail.de')] }));
    expect(plan.contacts).toBe('impressum');
    expect(plan.targets).toEqual([
      {
        domain: 'example-mail.de',
        host: 'example-mail.de',
        orgDomain: 'example-mail.de',
        roles: ['contact'],
        sources: [{ kind: 'impressum-text', url: IMPRESSUM }],
      },
    ]);
  });

  it('a mailto link whose text is no address ("E-Mail schreiben") on an Impressum page → a target', () => {
    const plan = select(
      snapshotWith({ impressum: [], links: [mailtoLink('mailto:[redacted]@example-mail.de')] }),
    );
    expect(plan.targets).toMatchObject([
      { domain: 'example-mail.de', sources: [{ kind: 'impressum-mailto', url: IMPRESSUM }] },
    ]);
  });

  it('an address written as name(at)domain in the Impressum → a target, after the redaction masked it', () => {
    const plan = select(snapshotWith({ impressum: [part('Kontakt: kontakt (at) example-mail.de')] }));
    expect(domainsOf(plan)).toEqual(['example-mail.de:contact']);
  });

  it.each([
    [
      'only in the privacy policy',
      { impressum: [], privacy: [part('Datenschutzbeauftragter: dsb@dpo.example')] },
    ],
    ['in a hidden, unrelated part', { impressum: [part('info@example-mail.de', 'hidden-irrelevant')] }],
    [
      'a mailto in the footer (agency credit)',
      { impressum: [], links: [mailtoLink('mailto:[redacted]@agency.example', { region: 'footer' })] },
    ],
    ['on the scanned domain', { impressum: [part('info@example.de')] }],
  ] as const)('an address %s → no target', (_label, o) => {
    expect(select(snapshotWith(o)).targets).toEqual([]);
  });

  it('a free-mail domain is recorded as skipped (no query); a longer name that ends like one is not free mail', () => {
    const plan = select(snapshotWith({ impressum: [part('a@gmx.de, b@gmx.de.example-mail.de')] }));
    expect(domainsOf(plan)).toEqual(['gmx.de:contact:free-mail', 'gmx.de.example-mail.de:contact']);
  });

  it('many free-mail addresses before the company address do not push it out of the plan', () => {
    const freeList = [...freeMail].slice(0, 12).map((d, i) => `p${i}@${d}`);
    const plan = select(snapshotWith({ impressum: [part(`${freeList.join(', ')}, info@company-mail.de`)] }));
    expect(domainsOf(plan).filter((d) => !d.endsWith(':free-mail'))).toEqual(['company-mail.de:contact']);
  });

  it('over the record cap a domain skipped for the limit is still kept, so the result says it was capped', () => {
    const freeList = [...freeMail].slice(0, 12).map((d, i) => `p${i}@${d}`);
    const text = `a@one.example, b@two.example, ${freeList.join(', ')}, c@three.example, d@four.example`;
    const plan = select(snapshotWith({ impressum: [part(text)] }));
    expect(domainsOf(plan).filter((d) => !d.endsWith(':free-mail'))).toEqual([
      'one.example:contact',
      'two.example:contact',
      'three.example:contact:limit',
    ]);
  });

  it('three domains with dns.maxMailDomains 2 → two planned in document order, the third skipped for the limit', () => {
    const plan = select(
      snapshotWith({ impressum: [part('a@one.example, b@two.example'), part('c@three.example')] }),
    );
    expect(domainsOf(plan)).toEqual([
      'one.example:contact',
      'two.example:contact',
      'three.example:contact:limit',
    ]);
  });

  it('addresses written in the text count before mailto recipients the text does not show', () => {
    const plan = select(
      snapshotWith({
        impressum: [part('a@second.example'), part('b@third.example')],
        links: [mailtoLink('mailto:[redacted]@first.example')],
      }),
    );
    expect(domainsOf(plan)).toEqual([
      'second.example:contact',
      'third.example:contact',
      'first.example:contact:limit',
    ]);
  });

  it('the same domain in the text and in a mailto link is one target with both sources', () => {
    const plan = select(
      snapshotWith({
        impressum: [part('info@example-mail.de')],
        links: [mailtoLink('mailto:[redacted]@example-mail.de')],
      }),
    );
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.sources.map((s) => s.kind)).toEqual(['impressum-text', 'impressum-mailto']);
  });

  it('a subdomain address keeps its exact domain; its organizational domain bounds the DMARC walk', () => {
    const plan = select(snapshotWith({ impressum: [part('info@mail.example-mail.de')] }));
    expect(plan.targets[0]).toMatchObject({ domain: 'mail.example-mail.de', orgDomain: 'example-mail.de' });
  });

  it('an internationalized address domain is queried in its ASCII form', () => {
    const plan = select(snapshotWith({ impressum: [part('info@müller-mail.de')] }));
    expect(plan.targets[0]?.domain).toBe('xn--mller-mail-9db.de');
  });

  it('dns.maxMailDomains 0 → no contact targets (off)', () => {
    const plan = select(snapshotWith({ impressum: [part('info@example-mail.de')] }), 0);
    expect(plan).toEqual({ targets: [], contacts: 'off' });
  });

  it('an Impressum page the browser could not read (blocked) and no Impressum document → not collected', () => {
    const snap = snapshotWith({ links: [mailtoLink('mailto:[redacted]@example-mail.de')] });
    for (const page of snap.browser?.phases[0]?.pages ?? []) {
      if (page.role === 'impressum') page.evaluable = false;
    }
    expect(select(snap)).toEqual({ targets: [], contacts: 'not-collected' });
  });

  it('an Impressum only as PDF (no text read) → not collected', () => {
    const snap = snapshotWith({ impressum: [] });
    const doc = snap.documents?.documents[0];
    if (doc) Object.assign(doc, { format: 'pdf', complete: false, errors: ['pdf-not-evaluated'] });
    for (const page of snap.browser?.phases[0]?.pages ?? []) {
      if (page.role === 'impressum') page.dom = null;
    }
    expect(select(snap).contacts).toBe('not-collected');
  });

  it('no browser run → no contact targets, and the plan says they were not collected', () => {
    expect(select(snapshotWith({ browser: false }))).toEqual({ targets: [], contacts: 'not-collected' });
  });
});

describe('selectMailTargets: the domain of the final host', () => {
  it('a redirect to another domain → a final target walked from the final host', () => {
    const plan = select(snapshotWith({ finalUrl: 'https://www.example.net/' }));
    expect(plan.targets).toEqual([
      {
        domain: 'example.net',
        host: 'www.example.net',
        orgDomain: 'example.net',
        roles: ['final'],
        sources: [],
      },
    ]);
  });

  it('a final host of the same registrable domain → no further target', () => {
    expect(select(snapshotWith({ finalUrl: 'https://example.de/start' })).targets).toEqual([]);
  });

  it('the final domain is also an Impressum address domain → one target with both roles', () => {
    const plan = select(
      snapshotWith({ finalUrl: 'https://www.example.net/', impressum: [part('info@example.net')] }),
    );
    expect(domainsOf(plan)).toEqual(['example.net:final+contact']);
    expect(plan.targets[0]?.sources).toEqual([{ kind: 'impressum-text', url: IMPRESSUM }]);
  });

  it('the final target does not count against dns.maxMailDomains', () => {
    const plan = select(
      snapshotWith({ finalUrl: 'https://www.example.net/', impressum: [part('a@one.example')] }),
      1,
    );
    expect(domainsOf(plan)).toEqual(['example.net:final', 'one.example:contact']);
  });
});

interface FakeClient extends DnsClient {
  calls: string[];
}

function fakeClient(spec: ZoneSpec, onQuery?: () => void): FakeClient {
  const calls: string[] = [];
  return {
    calls,
    resolver: { kind: 'custom', servers: ['192.0.2.53'] },
    cancel() {},
    async query(qname: string, type: DnsRecordType): Promise<RawDnsResult> {
      calls.push(`${type} ${qname}`);
      onQuery?.();
      const entry = spec[`${type} ${qname}`] ?? 'NXDOMAIN';
      if (typeof entry === 'string') {
        const retried = entry === 'SERVFAIL' || entry === 'TIMEOUT';
        return { rcode: entry, answers: [], attempts: retried ? 2 : 1, durationMs: 1 };
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

const ZONE: ZoneSpec = {
  'MX example.de': ['10 mx.example.de'],
  'TXT _dmarc.example.de': ['v=DMARC1; p=reject; rua=mailto:dmarc@example.de'],
  'TXT example.de': ['v=spf1 include:_spf.provider.example -all'],
  'TXT _spf.provider.example': ['v=spf1 ip4:192.0.2.0/24 -all'],
  'MX example-mail.de': ['10 mx.example-mail.de'],
  'TXT example-mail.de': ['v=spf1 include:_spf.provider.example ?all'],
  'MX example-other.de': ['10 mx.example-other.de'],
  'TXT _dmarc.example-other.de': ['v=DMARC1; p=reject; rua=mailto:dmarc@example-other.de'],
  'TXT example-other.de': ['v=spf1 ip4:192.0.2.0/24 -all'],
};

async function firstStage(client: DnsClient): Promise<DnsSection> {
  return (
    await collectMailDns({ host: 'www.example.de', domain: 'example.de', client, now: () => FIXED_NOW })
  ).section;
}

const contactPlan = (...domains: string[]): MailTargetPlan => ({
  contacts: 'impressum',
  targets: domains.map((domain) => ({
    domain,
    host: domain,
    orgDomain: domain,
    roles: ['contact'],
    sources: [{ kind: 'impressum-text', url: IMPRESSUM }],
    ...(domain === 'gmx.de' ? { skip: 'free-mail' as const } : {}),
  })),
});

describe('collectMailDomains: queries of the further mail domains', () => {
  it('MX, DMARC walk, SPF tree, DKIM selectors per domain; ids continue and an include the first stage resolved is not asked again', async () => {
    const client = fakeClient(ZONE);
    const first = await firstStage(client);
    const before = client.calls.length;

    const section = await collectMailDomains({
      section: first,
      plan: contactPlan('example-mail.de'),
      client,
      now: () => FIXED_NOW,
    });

    // _spf.provider.example is in both SPF trees: the first stage's answer is reused.
    expect(client.calls.slice(before)).toEqual([
      'MX example-mail.de',
      'TXT _dmarc.example-mail.de',
      'TXT _dmarc.de',
      'TXT example-mail.de',
      ...['default', 'dkim', 'mail', 's1', 's2', 'k1', 'key1'].map(
        (s) => `TXT ${s}._domainkey.example-mail.de`,
      ),
    ]);
    // The scanned domain's selectors stay first; the further domain's follow under its own name.
    expect(section.dkimPlan?.map((e) => e.domain)).toEqual([
      ...Array(7).fill('example.de'),
      ...Array(7).fill('example-mail.de'),
    ]);
    expect(section.queries.slice(0, first.queries.length)).toEqual(first.queries);
    expect(section.queries.map((q) => q.id)).toEqual(
      Array.from({ length: section.queries.length }, (_, i) => `dns-${String(i + 1).padStart(3, '0')}`),
    );
    expect(section.budget).toEqual(first.budget);
    expect(section.mailDomains).toMatchObject([
      { domain: 'example-mail.de', status: 'checked', budget: { limit: 30, used: 11 } },
    ]);
  });

  it('a free-mail domain sends no query', async () => {
    const client = fakeClient(ZONE);
    const first = await firstStage(client);
    const section = await collectMailDomains({
      section: first,
      plan: contactPlan('gmx.de'),
      client,
      now: () => FIXED_NOW,
    });

    expect(client.calls.filter((c) => c.includes('gmx.de'))).toEqual([]);
    expect(section.mailDomains).toEqual([
      expect.objectContaining({
        domain: 'gmx.de',
        status: 'skipped',
        reason: 'free-mail',
        budget: { limit: 30, used: 0 },
      }),
    ]);
  });

  it('a domain over its own budget is partial; the scanned domain and the next domain keep theirs', async () => {
    const client = fakeClient(ZONE);
    const first = await firstStage(client);
    const plan: MailTargetPlan = {
      contacts: 'impressum',
      targets: [
        {
          domain: 'example-mail.de',
          host: 'mail.example-mail.de',
          orgDomain: 'example-mail.de',
          roles: ['contact'],
          sources: [],
        },
        {
          domain: 'example-other.de',
          host: 'example-other.de',
          orgDomain: 'example-other.de',
          roles: ['contact'],
          sources: [],
        },
      ],
    };

    // example-other.de needs 10 queries (MX, DMARC, SPF, 7 selectors); example-mail.de 12, its walk starts lower.
    const section = await collectMailDomains({
      section: first,
      plan,
      client,
      now: () => FIXED_NOW,
      budget: 10,
    });

    expect(section.budget).toEqual(first.budget);
    expect(section.mailDomains?.map((d) => [d.domain, d.status, d.reason ?? null, d.budget.used])).toEqual([
      ['example-mail.de', 'partial', 'dns-budget-exhausted', 10],
      ['example-other.de', 'checked', null, 10],
    ]);
  });

  it('an abort marks the further domains aborted without a query', async () => {
    const client = fakeClient(ZONE);
    const first = await firstStage(client);
    const before = client.calls.length;
    const controller = new AbortController();
    controller.abort();

    const section = await collectMailDomains({
      section: first,
      plan: contactPlan('example-mail.de'),
      client,
      now: () => FIXED_NOW,
      signal: controller.signal,
    });

    expect(client.calls.length).toBe(before);
    expect(section.mailDomains).toMatchObject([{ status: 'skipped', reason: 'aborted' }]);
  });

  it('an abort during a domain → partial (aborted), the answers before it kept', async () => {
    const controller = new AbortController();
    const client = fakeClient(ZONE, () => {
      if (client.calls.at(-1) === 'MX example-mail.de') controller.abort();
    });
    const first = await firstStage(client);

    const section = await collectMailDomains({
      section: first,
      plan: contactPlan('example-mail.de'),
      client,
      now: () => FIXED_NOW,
      signal: controller.signal,
    });

    expect(section.mailDomains).toMatchObject([
      { status: 'partial', reason: 'aborted', budget: { used: 1 } },
    ]);
    expect(section.queries.at(-1)?.qname).toBe('example-mail.de');
  });

  it('timeouts on the selector names of one domain do not keep MX, DMARC and SPF of the next domain from being asked', async () => {
    const spec: ZoneSpec = { ...ZONE };
    for (const name of ['default', 'dkim', 'mail', 's1', 's2', 'k1', 'key1']) {
      spec[`TXT ${name}._domainkey.example.de`] = 'TIMEOUT';
      spec[`TXT ${name}._domainkey.example-mail.de`] = 'TIMEOUT';
    }
    const client = fakeClient(spec);
    const first = await firstStage(client);
    expect(first.errors.map((e) => e.code)).not.toContain('resolver-unresponsive');

    const section = await collectMailDomains({
      section: first,
      plan: contactPlan('example-mail.de', 'example-other.de'),
      client,
      now: () => FIXED_NOW,
    });

    expect(section.mailDomains?.map((d) => [d.domain, d.status, d.reason ?? null])).toEqual([
      ['example-mail.de', 'checked', null],
      ['example-other.de', 'checked', null],
    ]);
    expect(client.calls).toEqual(expect.arrayContaining(['MX example-other.de', 'TXT example-other.de']));
  });

  it('a resolver the first stage found unresponsive is not asked again', async () => {
    const client = fakeClient({});
    const first: DnsSection = {
      ...(await firstStage(fakeClient(ZONE))),
      errors: [{ code: 'resolver-unresponsive', message: 'x' }],
    };
    const section = await collectMailDomains({
      section: first,
      plan: contactPlan('example-mail.de'),
      client,
      now: () => FIXED_NOW,
    });

    expect(client.calls).toEqual([]);
    expect(section.mailDomains).toMatchObject([{ status: 'skipped', reason: 'resolver-unresponsive' }]);
  });

  it('a final domain is walked from the final host', async () => {
    const client = fakeClient(ZONE);
    const first = await firstStage(client);
    const before = client.calls.length;
    const plan: MailTargetPlan = {
      contacts: 'not-collected',
      targets: [
        {
          domain: 'example.net',
          host: 'www.example.net',
          orgDomain: 'example.net',
          roles: ['final'],
          sources: [],
        },
      ],
    };

    await collectMailDomains({ section: first, plan, client, now: () => FIXED_NOW });

    expect(client.calls.slice(before, before + 4)).toEqual([
      'MX example.net',
      'TXT _dmarc.www.example.net',
      'TXT _dmarc.example.net',
      'TXT _dmarc.net',
    ]);
  });
});
