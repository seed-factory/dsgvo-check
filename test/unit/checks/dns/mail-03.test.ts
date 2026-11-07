/**
 * MAIL-03 DKIM beyond the fixture table: what a finding carries (subject, params, evidence), the configurable minimum
 * RSA length, unknown answers that must not become a finding, and the further mail domains, each on its own.
 */
import { describe, expect, it } from 'vitest';
import { mail03 } from '../../../../src/checks/dns/mail-03.ts';
import { defaultConfig } from '../../../../src/core/config/schema.ts';
import { checkThresholds } from '../../../../src/core/config/thresholds.ts';
import { loadRouting, loadRuleset } from '../../../../src/core/data/load.ts';
import { assess } from '../../../../src/core/evaluation/assess.ts';
import type { DkimPlanEntry, MailDomainTarget } from '../../../../src/core/snapshot/dns.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { dkimRecord, rsaKey } from './dkim-keys.ts';
import { dnsSnapshot, type ZoneEntry, type ZoneSpec } from './zone.ts';

const COMMON = ['default', 'dkim', 'mail', 's1', 's2', 'k1', 'key1'];

function plan(domain: string, given: Array<[string, DkimPlanEntry['reason']]>, common = COMMON) {
  const entries: DkimPlanEntry[] = given.map(([selector, reason]) => ({
    domain,
    selector,
    reason,
    given: reason === 'operator' || reason === 'provider:microsoft-365',
  }));
  for (const selector of common) entries.push({ domain, selector, reason: 'common', given: false });
  return entries.slice(0, 8);
}

const M365_GIVEN: Array<[string, DkimPlanEntry['reason']]> = [
  ['selector1', 'provider:microsoft-365'],
  ['selector2', 'provider:microsoft-365'],
];

/** MX and SPF of a domain; `m365` points both to Microsoft 365. */
function mail(domain: string, m365: boolean): ZoneSpec {
  return m365
    ? {
        [`MX ${domain}`]: [`0 ${domain.replace(/\./g, '-')}.mail.protection.outlook.com`],
        [`TXT ${domain}`]: ['v=spf1 include:spf.protection.outlook.com -all'],
        'TXT spf.protection.outlook.com': ['v=spf1 ip4:192.0.2.0/24 -all'],
      }
    : { [`MX ${domain}`]: [`10 mx.${domain}`], [`TXT ${domain}`]: ['v=spf1 ip4:192.0.2.0/24 -all'] };
}

/** Every planned selector NXDOMAIN unless `answers` names it. */
function selectors(entries: readonly DkimPlanEntry[], answers: Record<string, ZoneEntry> = {}): ZoneSpec {
  return Object.fromEntries(
    entries.map((e) => [
      `TXT ${e.selector}._domainkey.${e.domain}`,
      answers[`${e.selector}@${e.domain}`] ?? answers[e.selector] ?? 'NXDOMAIN',
    ]),
  );
}

const SITE_M365 = plan('example.de', M365_GIVEN);
const SITE_OWN = plan('example.de', []);

const run = (spec: ZoneSpec, dkimPlan: DkimPlanEntry[] | undefined, extra = {}) =>
  runCheck(mail03, dnsSnapshot(spec, { ...(dkimPlan ? { dkimPlan } : {}), ...extra }));

describe('MAIL-03: what a finding carries', () => {
  it('given-selector-missing names the provider, the given selectors and how many were probed', () => {
    const r = run({ ...mail('example.de', true), ...selectors(SITE_M365) }, SITE_M365);
    expect(r.status).toBe('completed');
    const [o, ...rest] = observationsOf(r);
    expect(rest).toEqual([]);
    expect(o).toMatchObject({
      checkId: 'MAIL-03',
      variant: 'given-selector-missing',
      confidence: 'high',
      subject: 'dkim',
      phases: ['dns'],
      params: {
        domain: 'example.de',
        scope: 'site',
        mailDomain: 'example.de',
        provider: 'microsoft-365',
        selectors: 'selector1, selector2',
        count: 8,
      },
    });
    const qnames = o?.evidence.map((e) => (e.type === 'dns' ? e.qname : null));
    expect(qnames).toEqual(
      expect.arrayContaining([
        'example.de',
        'selector1._domainkey.example.de',
        'selector2._domainkey.example.de',
      ]),
    );
  });

  it('an operator selector makes the provider "operator"', () => {
    const p = plan('example.de', [['mailing', 'operator']]);
    const r = run({ ...mail('example.de', false), ...selectors(p) }, p);
    expect(observationsOf(r)[0]?.params).toMatchObject({ provider: 'operator', selectors: 'mailing' });
  });

  it('selectors-not-found lists the probed names and says which provider preset was probed', () => {
    const p: DkimPlanEntry[] = [
      { domain: 'example.de', selector: 'google', reason: 'provider:google-workspace', given: false },
      ...plan('example.de', [], COMMON.slice(0, 3)),
    ];
    const r = run({ ...mail('example.de', false), ...selectors(p) }, p);
    expect(variantsOf(r)).toEqual(['selectors-not-found']);
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'dkim',
      params: { count: 4, selectors: 'google, default, dkim, mail', provider: 'google-workspace' },
    });
  });

  it('key-too-short: subject per selector, bits and threshold in the params, the key shortened in the evidence', () => {
    const record = dkimRecord(rsaKey(768));
    const r = run({ ...mail('example.de', false), ...selectors(SITE_OWN, { s1: [record] }) }, SITE_OWN);
    expect(variantsOf(r)).toEqual(['key-too-short']);
    const o = observationsOf(r)[0];
    expect(o).toMatchObject({
      subject: 'dkim:s1',
      params: { domain: 'example.de', selector: 's1', bits: 768, minBits: 1024, belowRfc: 'yes' },
    });
    const ev = o?.evidence.find((e) => e.type === 'dns' && e.qname === 's1._domainkey.example.de');
    expect(ev).toMatchObject({ type: 'dns', rcode: 'NOERROR' });
    const shown = ev?.type === 'dns' ? (ev.records[0] ?? '') : '';
    expect(shown.startsWith(record.slice(0, 40))).toBe(true);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown.length).toBeLessThan(record.length);
  });

  it('two short keys give one finding each, under their own subjects', () => {
    const r = run(
      {
        ...mail('example.de', true),
        ...selectors(SITE_M365, {
          selector1: [dkimRecord(rsaKey(512))],
          selector2: [dkimRecord(rsaKey(1000))],
        }),
      },
      SITE_M365,
    );
    expect(observationsOf(r).map((o) => [o.variant, o.subject, o.params.bits])).toEqual([
      ['key-too-short', 'dkim:selector1', 512],
      ['key-too-short', 'dkim:selector2', 1000],
    ]);
  });
});

describe('MAIL-03: the minimum RSA length comes from the settings', () => {
  const spec = (bits: number) => ({
    ...mail('example.de', false),
    ...selectors(SITE_OWN, { default: [dkimRecord(rsaKey(bits))] }),
  });
  const thresholds = (dkimMinRsaBits: number) => {
    const config = defaultConfig();
    config.dns.dkimMinRsaBits = dkimMinRsaBits;
    return checkThresholds(config);
  };

  it.each([
    [1023, 1024, ['key-too-short']],
    [1024, 1024, []],
    [1024, 2048, ['key-too-short']],
    [2047, 2048, ['key-too-short']],
    [2048, 2048, []],
  ])('%i bits at a minimum of %i → %j', (bits, min, variants) => {
    const r = runCheck(mail03, dnsSnapshot(spec(bits), { dkimPlan: SITE_OWN }), {
      thresholds: thresholds(min),
    });
    expect(variantsOf(r)).toEqual(variants);
  });

  it('a key of 1024 bits under a raised minimum is below the setting but not below RFC 8301', () => {
    const r = runCheck(mail03, dnsSnapshot(spec(1024), { dkimPlan: SITE_OWN }), {
      thresholds: thresholds(2048),
    });
    expect(observationsOf(r)[0]?.params).toMatchObject({ bits: 1024, minBits: 2048, belowRfc: 'no' });
  });
});

describe('MAIL-03: unknown answers never become a missing key', () => {
  it('a key on one selector decides; a failed other selector is a limitation, not an error', () => {
    const r = run(
      {
        ...mail('example.de', true),
        ...selectors(SITE_M365, { selector1: [dkimRecord(rsaKey(2048))], s1: 'SERVFAIL' }),
      },
      SITE_M365,
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['dkim-selectors-unresolved']);
    expect(variantsOf(r)).toEqual([]);
  });

  it.each(['v=DKIM1.0; k=rsa; p=AAAA', 'v="DKIM1"; k=rsa; p=AAAA'])(
    'a key record "%s" at the operator selector is an unreadable key, not a missing one: inconclusive',
    (txt) => {
      const own = plan('example.de', [['s1', 'operator']]);
      const r = run({ ...mail('example.de', false), ...selectors(own, { s1: [txt] }) }, own);
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'key-unparsable' });
      expect(variantsOf(r)).toEqual([]);
    },
  );

  it('an unparsable key on a common name keeps the given selectors open: inconclusive, no warning', () => {
    const r = run(
      { ...mail('example.de', true), ...selectors(SITE_M365, { dkim: ['v=DKIM1; k=rsa; p=AAAA'] }) },
      SITE_M365,
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'key-unparsable' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('a withdrawn key on a common name keeps the given selectors open: inconclusive (key-revoked), no warning', () => {
    const r = run(
      { ...mail('example.de', true), ...selectors(SITE_M365, { default: ['v=DKIM1; k=rsa; p='] }) },
      SITE_M365,
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'key-revoked' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('a given selector over the cap with a key elsewhere: no finding, the capped one is a limitation', () => {
    const p: DkimPlanEntry[] = [
      { domain: 'example.de', selector: 'selector1', reason: 'provider:microsoft-365', given: true },
      {
        domain: 'example.de',
        selector: 'selector2',
        reason: 'provider:microsoft-365',
        given: true,
        capped: true,
      },
    ];
    const spec = {
      ...mail('example.de', true),
      'TXT selector1._domainkey.example.de': [dkimRecord(rsaKey(2048))],
    };
    const r = run(spec, p);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['dkim-selectors-unresolved']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('a selector that was not queried without a recorded budget stop is an error', () => {
    const spec = { ...mail('example.de', false), ...selectors(SITE_OWN) };
    delete spec['TXT key1._domainkey.example.de'];
    expect(run(spec, SITE_OWN)).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it('an MX that could not be read leaves the provider unknown: selectors-not-found with mx-unknown', () => {
    const r = run(
      { ...mail('example.de', false), 'MX example.de': 'SERVFAIL', ...selectors(SITE_OWN) },
      SITE_OWN,
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mx-unknown']);
    expect(variantsOf(r)).toEqual(['selectors-not-found']);
  });

  it('neither MX nor SPF: not_applicable (no-mail-records)', () => {
    const r = run({ 'MX example.de': 'NXDOMAIN', 'TXT example.de': 'NXDOMAIN' }, []);
    expect(r).toMatchObject({ status: 'not_applicable', reason: 'no-mail-records' });
  });

  it('an IP target is not_applicable as for MAIL-01', () => {
    const r = runCheck(mail03, dnsSnapshot({}, { notApplicable: 'ip-target', dkimPlan: [] }));
    expect(r).toMatchObject({ status: 'not_applicable', reason: 'ip-target' });
  });
});

const IMPRESSUM = 'https://www.example.de/impressum/';
const contact = (domain: string, over: Partial<MailDomainTarget> = {}): MailDomainTarget => ({
  domain,
  host: domain,
  orgDomain: domain,
  roles: ['contact'],
  sources: [{ kind: 'impressum-text', url: IMPRESSUM }],
  status: 'checked',
  budget: { limit: 30, used: 10 },
  ...over,
});
const STAGE = { contacts: 'impressum' as const, durationMs: 3 };

describe('MAIL-03 on the further mail domains', () => {
  const CONTACT_M365 = plan('example-mail.de', M365_GIVEN);

  it('each domain on its own: subjects and fingerprints differ, the contact finding names its domain and page', () => {
    const spec = {
      ...mail('example.de', true),
      ...selectors(SITE_M365),
      ...mail('example-mail.de', true),
      ...selectors(CONTACT_M365),
    };
    const snap = dnsSnapshot(spec, {
      dkimPlan: [...SITE_M365, ...CONTACT_M365],
      mailDomains: [contact('example-mail.de')],
      mailDomainStage: STAGE,
    });
    const r = runCheck(mail03, snap);
    const obs = observationsOf(r);
    expect(obs.map((o) => [o.variant, o.subject, o.params.scope, o.params.domain])).toEqual([
      ['given-selector-missing', 'dkim', 'site', 'example.de'],
      ['given-selector-missing', 'dkim@contact:example-mail.de', 'contact', 'example-mail.de'],
    ]);
    expect(obs[1]?.pages).toEqual([IMPRESSUM]);

    const { findings } = assess({
      checks: [mail03],
      executed: new Map([['MAIL-03', r]]),
      ruleset: loadRuleset(),
      routing: loadRouting(),
    });
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(2);
    expect(findings.map((f) => [f.severity, f.crmCode])).toEqual([
      ['warning', 'T3_MAIL_UNPROTECTED'],
      ['warning', 'T3_MAIL_UNPROTECTED'],
    ]);
  });

  it('the redirect target is evaluated under @final', () => {
    const finalPlan = plan('example.net', []);
    const snap = dnsSnapshot(
      {
        ...mail('example.de', false),
        ...selectors(SITE_OWN, { default: [dkimRecord(rsaKey(2048))] }),
        ...mail('example.net', false),
        ...selectors(finalPlan, { 'default@example.net': [dkimRecord(rsaKey(512))] }),
      },
      {
        dkimPlan: [...SITE_OWN, ...finalPlan],
        mailDomains: [{ ...contact('example.net'), host: 'www.example.net', roles: ['final'], sources: [] }],
        mailDomainStage: STAGE,
      },
    );
    expect(observationsOf(runCheck(mail03, snap)).map((o) => [o.subject, o.params.scope])).toEqual([
      ['dkim:default@final', 'final'],
    ]);
  });

  it('a further domain whose budget ran out is a limitation; the scanned domain keeps its own result', () => {
    const contactPlan = plan('example-mail.de', []);
    const spec = {
      ...mail('example.de', false),
      ...selectors(SITE_OWN),
      ...mail('example-mail.de', false),
      ...selectors(contactPlan.slice(0, 2)),
    };
    const r = runCheck(
      mail03,
      dnsSnapshot(spec, {
        dkimPlan: [...SITE_OWN, ...contactPlan],
        mailDomains: [contact('example-mail.de', { status: 'partial', reason: 'dns-budget-exhausted' })],
        mailDomainStage: STAGE,
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mail-domain-unresolved:example-mail.de']);
    expect(observationsOf(r).map((o) => [o.variant, o.params.scope])).toEqual([
      ['selectors-not-found', 'site'],
    ]);
  });

  it('an unparsable key on a further domain is a limitation that names it', () => {
    const contactPlan = plan('example-mail.de', []);
    const r = runCheck(
      mail03,
      dnsSnapshot(
        {
          ...mail('example.de', false),
          ...selectors(SITE_OWN, { default: [dkimRecord(rsaKey(2048))] }),
          ...mail('example-mail.de', false),
          ...selectors(contactPlan, { 'mail@example-mail.de': ['v=DKIM1; k=rsa; p=AAAA'] }),
        },
        {
          dkimPlan: [...SITE_OWN, ...contactPlan],
          mailDomains: [contact('example-mail.de')],
          mailDomainStage: STAGE,
        },
      ),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mail-domain-dkim-key-unparsable:example-mail.de']);
  });

  it('a withdrawn key on a further domain is a limitation that names it', () => {
    const contactPlan = plan('example-mail.de', M365_GIVEN);
    const r = runCheck(
      mail03,
      dnsSnapshot(
        {
          ...mail('example.de', false),
          ...selectors(SITE_OWN, { default: [dkimRecord(rsaKey(2048))] }),
          ...mail('example-mail.de', true),
          ...selectors(contactPlan, { 'selector1@example-mail.de': ['v=DKIM1; p='] }),
        },
        {
          dkimPlan: [...SITE_OWN, ...contactPlan],
          mailDomains: [contact('example-mail.de')],
          mailDomainStage: STAGE,
        },
      ),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mail-domain-dkim-key-revoked:example-mail.de']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('a scanned domain with Null MX does not hide the findings of an Impressum address domain', () => {
    const contactPlan = plan('example-mail.de', M365_GIVEN);
    const r = runCheck(
      mail03,
      dnsSnapshot(
        {
          'MX example.de': ['0 .'],
          'TXT example.de': ['v=spf1 -all'],
          ...mail('example-mail.de', true),
          ...selectors(contactPlan),
        },
        { dkimPlan: contactPlan, mailDomains: [contact('example-mail.de')], mailDomainStage: STAGE },
      ),
    );
    expect(r.status).toBe('completed');
    expect(observationsOf(r).map((o) => o.subject)).toEqual(['dkim@contact:example-mail.de']);
  });
});
