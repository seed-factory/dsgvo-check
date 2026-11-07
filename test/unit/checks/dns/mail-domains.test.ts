/**
 * MAIL-01 and MAIL-02 on the further mail domains of the stage after the browser: the domain of the site after a
 * redirect (`final`) and address domains seen in the Impressum (`contact`). Each domain is evaluated on its own, under
 * its own subject, and a domain whose lookups did not finish is a limitation, never a finding or a failed check.
 */
import { describe, expect, it } from 'vitest';
import { mail01 } from '../../../../src/checks/dns/mail-01.ts';
import { mail02 } from '../../../../src/checks/dns/mail-02.ts';
import { loadRouting, loadRuleset } from '../../../../src/core/data/load.ts';
import { assess } from '../../../../src/core/evaluation/assess.ts';
import { fingerprint } from '../../../../src/core/evaluation/fingerprint.ts';
import type { MailDomainStage, MailDomainTarget } from '../../../../src/core/snapshot/dns.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import {
  contactDomain as contact,
  dnsSnapshot,
  IMPRESSUM,
  IMPRESSUM_STAGE as STAGE,
  siteZone,
  type ZoneEntry,
  type ZoneSpec,
} from './zone.ts';

const REJECT = ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'] as const;
const NONE = ['v=DMARC1; p=none; rua=mailto:[redacted]@example.de'] as const;

/** The scanned www.example.de: its organizational record decides, SPF -all. */
const site = (dmarc: ZoneEntry = REJECT, spf: ZoneEntry = ['v=spf1 ip4:192.0.2.0/24 -all']) =>
  siteZone(dmarc, { 'TXT example.de': spf });

/** Records of example-mail.de, the domain of an Impressum address. */
function mailZone(dmarc: ZoneEntry, spf: ZoneEntry = ['v=spf1 ip4:192.0.2.0/24 -all']): ZoneSpec {
  return {
    'MX example-mail.de': ['10 mx.example-mail.de'],
    'TXT _dmarc.example-mail.de': dmarc,
    'TXT example-mail.de': spf,
  };
}

/** Records of example.net, the domain the start page redirects to (www.example.net). */
function finalZone(dmarc: ZoneEntry, spf: ZoneEntry = ['v=spf1 ip4:192.0.2.0/24 -all']): ZoneSpec {
  return {
    'MX example.net': ['10 mx.example.net'],
    'TXT _dmarc.www.example.net': 'NXDOMAIN',
    'TXT _dmarc.example.net': dmarc,
    'TXT _dmarc.net': 'NXDOMAIN',
    'TXT example.net': spf,
  };
}

const FINAL: MailDomainTarget = {
  domain: 'example.net',
  host: 'www.example.net',
  orgDomain: 'example.net',
  roles: ['final'],
  sources: [],
  status: 'checked',
  budget: { limit: 30, used: 5 },
};

const snapshotOf = (spec: ZoneSpec, mailDomains: MailDomainTarget[], stage: MailDomainStage = STAGE) =>
  dnsSnapshot(spec, { mailDomains, mailDomainStage: stage });

const subjectsOf = (r: ReturnType<typeof runCheck>) =>
  observationsOf(r).map((o) => `${o.variant}@${o.subject}`);

describe('MAIL-01 on further mail domains', () => {
  it('an Impressum address domain without DMARC → record-not-found under its own subject, with the Impressum page', () => {
    const r = runCheck(
      mail01,
      snapshotOf({ ...site(), ...mailZone('NXDOMAIN') }, [contact('example-mail.de')]),
    );

    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['record-not-found']);
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'dmarc@contact:example-mail.de',
      pages: [IMPRESSUM],
      params: {
        domain: 'example-mail.de',
        mailDomain: 'example-mail.de',
        scope: 'contact',
        inherited: 'none',
      },
    });
  });

  it('the scanned domain keeps its subject and gets scope site', () => {
    const r = runCheck(
      mail01,
      snapshotOf({ ...site(NONE), ...mailZone(REJECT) }, [contact('example-mail.de')]),
    );
    expect(observationsOf(r)).toMatchObject([
      {
        variant: 'policy-none',
        subject: 'dmarc',
        pages: [],
        params: { domain: 'example.de', scope: 'site' },
      },
    ]);
  });

  it('SERVFAIL on a further domain → partial with mail-domain-unresolved; the scanned domain is still evaluated', () => {
    const spec: ZoneSpec = { ...site(NONE), ...mailZone('SERVFAIL') };
    const r = runCheck(mail01, snapshotOf(spec, [contact('example-mail.de')]));

    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mail-domain-unresolved:example-mail.de']);
    expect(subjectsOf(r)).toEqual(['policy-none@dmarc']);
  });

  it('SERVFAIL on the scanned domain stays a check error, whatever the further domains show', () => {
    const r = runCheck(
      mail01,
      snapshotOf({ ...site('SERVFAIL'), ...mailZone(REJECT) }, [contact('example-mail.de')]),
    );
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it('p=none on two domains → two findings with different fingerprints; the scanned domain keeps its fingerprint', () => {
    const snap = snapshotOf({ ...site(NONE), ...mailZone(['v=DMARC1; p=none']) }, [
      contact('example-mail.de'),
    ]);
    const out = assess({
      checks: [mail01],
      executed: new Map([['MAIL-01', runCheck(mail01, snap)]]),
      ruleset: loadRuleset(),
      routing: loadRouting(),
    });

    const policyNone = out.findings.filter((f) => f.variant === 'policy-none');
    expect(policyNone.map((f) => f.params.domain)).toEqual(['example.de', 'example-mail.de']);
    expect(new Set(policyNone.map((f) => f.fingerprint)).size).toBe(2);
    expect(policyNone[0]?.fingerprint).toBe(
      fingerprint({ checkId: 'MAIL-01', variantGroup: 'policy', subject: 'dmarc' }),
    );
  });

  it('the redirect target without DMARC → record-not-found for its domain (subject dmarc@final), walked from the final host', () => {
    const spec: ZoneSpec = {
      ...site(['v=DMARC1; p=quarantine; rua=mailto:[redacted]@example.de']),
      ...finalZone('NXDOMAIN'),
    };
    const r = runCheck(mail01, snapshotOf(spec, [FINAL]));

    expect(subjectsOf(r)).toEqual(['record-not-found@dmarc@final']);
    const o = observationsOf(r)[0];
    expect(o?.params).toMatchObject({ domain: 'example.net', scope: 'final' });
    const walk = o?.evidence.find((e) => e.type === 'dns' && e.treeWalk);
    expect(walk).toMatchObject({ treeWalk: ['_dmarc.www.example.net', '_dmarc.example.net', '_dmarc.net'] });
  });

  it('p=reject of the redirect target does not stand in for the scanned domain without a record', () => {
    const r = runCheck(mail01, snapshotOf({ ...site('NXDOMAIN'), ...finalZone(REJECT) }, [FINAL]));
    expect(subjectsOf(r)).toEqual(['record-not-found@dmarc']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ domain: 'example.de', scope: 'site' });
  });

  it('a final domain that is also an Impressum address domain is one finding (final) that cites the Impressum', () => {
    const both: MailDomainTarget = {
      ...FINAL,
      roles: ['final', 'contact'],
      sources: [{ kind: 'impressum-mailto', url: 'https://www.example.net/impressum/' }],
    };
    const r = runCheck(mail01, snapshotOf({ ...site(), ...finalZone('NXDOMAIN') }, [both]));
    expect(observationsOf(r)).toMatchObject([
      {
        subject: 'dmarc@final',
        pages: ['https://www.example.net/impressum/'],
        params: { scope: 'final', domain: 'example.net' },
      },
    ]);
  });

  it.each([
    ['free-mail', []],
    ['limit', ['mail-domains-capped']],
    ['aborted', ['mail-domain-unresolved:example-mail.de']],
    ['resolver-unresponsive', ['mail-domain-unresolved:example-mail.de']],
  ] as const)('a domain skipped for %s → limitations %j, no finding for it', (reason, limitations) => {
    const skipped = contact('example-mail.de', { status: 'skipped', reason, budget: { limit: 30, used: 0 } });
    const r = runCheck(mail01, snapshotOf(site(), [skipped]));
    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.limitations ?? []).toEqual(limitations);
  });

  it('a domain stopped by its budget after a finished DMARC walk is still evaluated', () => {
    const partial = contact('example-mail.de', { status: 'partial', reason: 'dns-budget-exhausted' });
    const spec: ZoneSpec = {
      ...site(),
      'MX example-mail.de': ['10 mx.example-mail.de'],
      'TXT _dmarc.example-mail.de': 'NXDOMAIN',
    };
    const r = runCheck(mail01, snapshotOf(spec, [partial]));
    expect(subjectsOf(r)).toEqual(['record-not-found@dmarc@contact:example-mail.de']);
  });

  it('MX of a further domain unknown → its finding stays, with the limitation naming the domain', () => {
    const spec: ZoneSpec = { ...site(), ...mailZone('NXDOMAIN'), 'MX example-mail.de': 'SERVFAIL' };
    const r = runCheck(mail01, snapshotOf(spec, [contact('example-mail.de')]));
    expect(r.outcome?.limitations).toEqual(['mail-domain-mx-unknown:example-mail.de']);
    expect(variantsOf(r)).toEqual(['record-not-found']);
  });

  it.each([
    ['no Impressum read in this run', { contacts: 'not-collected', durationMs: 0 }],
    [
      'the stage failed',
      { contacts: 'not-collected', durationMs: 0, error: { code: 'timeout', message: 'x' } },
    ],
  ] as const)('%s → mail-domains-not-collected', (_label, stage) => {
    const r = runCheck(mail01, snapshotOf(site(), [], stage));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mail-domains-not-collected']);
  });

  it('further domains turned off (dns.maxMailDomains 0) → no limitation', () => {
    const r = runCheck(mail01, snapshotOf(site(), [], { contacts: 'off', durationMs: 0 }));
    expect(r.status).toBe('completed');
  });

  it('a snapshot without the stage (older version) → evaluated as before, without a limitation', () => {
    const r = runCheck(mail01, dnsSnapshot(site(NONE)));
    expect(r.status).toBe('completed');
    expect(subjectsOf(r)).toEqual(['policy-none@dmarc']);
  });
});

describe('MAIL-02 on further mail domains', () => {
  it('?all on an Impressum address domain → permissive-qualifier for that domain only', () => {
    const spec: ZoneSpec = { ...site(), ...mailZone('NXDOMAIN', ['v=spf1 ip4:192.0.2.0/24 ?all']) };
    const r = runCheck(mail02, snapshotOf(spec, [contact('example-mail.de')]));

    expect(r.status).toBe('completed');
    expect(observationsOf(r)).toMatchObject([
      {
        variant: 'permissive-qualifier',
        subject: 'spf@contact:example-mail.de',
        pages: [IMPRESSUM],
        params: { domain: 'example-mail.de', scope: 'contact', qualifier: '?all' },
      },
    ]);
  });

  it('~all of the redirect target without DMARC → softfail-without-enforcement, related to its own DMARC subject', () => {
    const spec: ZoneSpec = { ...site(), ...finalZone('NXDOMAIN', ['v=spf1 ip4:192.0.2.0/24 ~all']) };
    const r = runCheck(mail02, snapshotOf(spec, [FINAL]));

    expect(observationsOf(r)).toMatchObject([
      {
        variant: 'softfail-without-enforcement',
        subject: 'spf@final',
        params: { domain: 'example.net', scope: 'final', dmarcPolicy: 'missing' },
        related: [{ checkId: 'MAIL-01', subject: 'dmarc@final', relation: 'dmarc-policy' }],
      },
    ]);
  });

  it("the scanned domain's ~all is not enforced by another domain's DMARC", () => {
    const spec: ZoneSpec = { ...site('NXDOMAIN', ['v=spf1 ip4:192.0.2.0/24 ~all']), ...mailZone(REJECT) };
    const r = runCheck(mail02, snapshotOf(spec, [contact('example-mail.de')]));

    expect(observationsOf(r)).toMatchObject([
      {
        variant: 'softfail-without-enforcement',
        subject: 'spf',
        params: { domain: 'example.de', scope: 'site' },
        related: [{ checkId: 'MAIL-01', subject: 'dmarc' }],
      },
    ]);
  });

  it('~all of a subdomain address with p=reject at its organizational domain → softfail-with-enforcement', () => {
    const spec: ZoneSpec = {
      ...site(),
      'MX mail.example.de': ['10 mx.example.de'],
      'TXT _dmarc.mail.example.de': 'NXDOMAIN',
      'TXT mail.example.de': ['v=spf1 ip4:192.0.2.0/24 ~all'],
    };
    const r = runCheck(mail02, snapshotOf(spec, [contact('mail.example.de', { orgDomain: 'example.de' })]));
    expect(subjectsOf(r)).toEqual(['softfail-with-enforcement@spf@contact:mail.example.de']);
  });

  it.each([
    ['v=DMARC1; p=reject; sp=none', 'softfail-without-enforcement', 'none'],
    ['v=DMARC1; p=none; sp=reject', 'softfail-with-enforcement', 'reject'],
  ] as const)(
    '~all of a subdomain address under "%s" → %s: the subdomain policy sp applies',
    (org, variant, policy) => {
      const spec: ZoneSpec = {
        ...site([`${org}; rua=mailto:[redacted]@example.de`]),
        'MX mail.example.de': ['10 mx.example.de'],
        'TXT _dmarc.mail.example.de': 'NXDOMAIN',
        'TXT mail.example.de': ['v=spf1 ip4:192.0.2.0/24 ~all'],
      };
      const r = runCheck(mail02, snapshotOf(spec, [contact('mail.example.de', { orgDomain: 'example.de' })]));
      expect(observationsOf(r)).toMatchObject([
        { variant, params: { domain: 'mail.example.de', dmarcPolicy: policy } },
      ]);
    },
  );

  it("the scanned domain's own record keeps p for the matrix, whatever sp says", () => {
    const spec: ZoneSpec = site(
      ['v=DMARC1; p=reject; sp=none; rua=mailto:[redacted]@example.de'],
      ['v=spf1 ip4:192.0.2.0/24 ~all'],
    );
    expect(variantsOf(runCheck(mail02, dnsSnapshot(spec)))).toEqual(['softfail-with-enforcement']);
  });

  it('SERVFAIL on the SPF of a further domain → partial with mail-domain-unresolved, never record-not-found', () => {
    const spec: ZoneSpec = { ...site(), ...mailZone(REJECT, 'SERVFAIL') };
    const r = runCheck(mail02, snapshotOf(spec, [contact('example-mail.de')]));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mail-domain-unresolved:example-mail.de']);
    expect(variantsOf(r)).toEqual([]);
  });

  it('a decided ?all with an unresolved include → the finding and a limitation naming the domain', () => {
    const spec: ZoneSpec = {
      ...site(),
      ...mailZone(REJECT, ['v=spf1 include:_spf.mail-provider.example ?all']),
      'TXT _spf.mail-provider.example': 'TIMEOUT',
    };
    const r = runCheck(mail02, snapshotOf(spec, [contact('example-mail.de')]));
    expect(variantsOf(r)).toEqual(['permissive-qualifier']);
    expect(r.outcome?.limitations).toEqual(['mail-domain-spf-incomplete:example-mail.de']);
  });

  it('no Impressum read → mail-domains-not-collected, as in MAIL-01', () => {
    const r = runCheck(mail02, snapshotOf(site(), [], { contacts: 'not-collected', durationMs: 0 }));
    expect(r.outcome?.limitations).toEqual(['mail-domains-not-collected']);
  });
});
