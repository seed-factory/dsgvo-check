import { describe, expect, it } from 'vitest';
import { mail02 } from '../../../../src/checks/dns/mail-02.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, siteZone, type ZoneEntry, type ZoneSpec } from './zone.ts';

const REJECT = ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'] as const;

const site = (spf: ZoneEntry, dmarc: ZoneEntry = REJECT, extra: ZoneSpec = {}) =>
  siteZone(dmarc, { 'TXT example.de': spf, ...extra });

const run = (spec: ZoneSpec) => runCheck(mail02, dnsSnapshot(spec));

describe('MAIL-02 SPF: warning variants', () => {
  it('no SPF record → record-not-found', () => {
    const r = run(site('NXDOMAIN'));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['record-not-found']);
    expect(observationsOf(r)[0]).toMatchObject({
      checkId: 'MAIL-02',
      subject: 'spf',
      phases: ['dns'],
      params: { domain: 'example.de', nullMx: 'no' },
    });
  });

  it('only unrelated TXT records (filtered) → record-not-found', () => {
    expect(variantsOf(run(site([])))).toEqual(['record-not-found']);
  });

  it.each([
    [
      'two v=spf1 records',
      ['v=spf1 -all', 'v=spf1 include:_spf.google.com ~all'],
      'record-invalid',
      { reason: 'multiple-records', count: 2 },
    ],
    ['a syntax error (permerror)', ['v=spf1 ip4:192.0.2.300 -all'], 'record-invalid', { reason: 'syntax' }],
    ['+all', ['v=spf1 +all'], 'permissive-qualifier', { qualifier: '+all' }],
    ['?all', ['v=spf1 ip4:192.0.2.1 ?all'], 'permissive-qualifier', { qualifier: '?all' }],
    ['no all at all', ['v=spf1 ip4:192.0.2.1'], 'permissive-qualifier', { qualifier: 'none' }],
  ])('%s → %s', (_label, records, variant, params) => {
    const r = run(site(records));
    expect(variantsOf(r)).toEqual([variant]);
    expect(observationsOf(r)[0]?.params).toMatchObject(params);
  });

  it.each([
    [['v=DMARC1; p=none'], 'none'],
    ['NXDOMAIN', 'missing'],
    [['v=DMARC1; p=bogus'], 'invalid'],
  ] as const)('~all with DMARC %j → softfail-without-enforcement (%s)', (dmarc, policy) => {
    const r = run(site(['v=spf1 ip4:192.0.2.1 ~all'], dmarc));
    expect(variantsOf(r)).toEqual(['softfail-without-enforcement']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ dmarcPolicy: policy });
  });

  it('permerror: more than 10 lookups', () => {
    const includes = Array.from({ length: 11 }, (_, i) => `include:i${i}.example.net`).join(' ');
    const extra: ZoneSpec = {};
    for (let i = 0; i < 11; i++) extra[`TXT i${i}.example.net`] = ['v=spf1 ip4:192.0.2.1 -all'];
    const r = run(site([`v=spf1 ${includes} -all`], REJECT, extra));
    expect(variantsOf(r)).toEqual(['record-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'too-many-lookups', lookups: 11 });
  });

  it('permerror: include of a name without SPF; the offending lookup is evidence', () => {
    const r = run(
      site(['v=spf1 include:gone.example.net -all'], REJECT, { 'TXT gone.example.net': 'NXDOMAIN' }),
    );
    expect(variantsOf(r)).toEqual(['record-invalid']);
    const qnames = observationsOf(r)[0]?.evidence.map((e) => (e.type === 'dns' ? e.qname : null));
    expect(qnames).toContain('gone.example.net');
  });
});

describe('MAIL-02 SPF: matrix with DMARC (BSI TR-03182) and info variants', () => {
  it.each([
    [['v=DMARC1; p=reject'], 'reject'],
    [['v=DMARC1; p=quarantine'], 'quarantine'],
  ] as const)(
    'counterexample: ~all with DMARC %j → info softfail-with-enforcement, not warning',
    (dmarc, policy) => {
      const r = run(
        site(['v=spf1 include:_spf.provider.net ~all'], dmarc, {
          'TXT _spf.provider.net': ['v=spf1 ip4:192.0.2.0/24 -all'],
        }),
      );
      expect(variantsOf(r)).toEqual(['softfail-with-enforcement']);
      const o = observationsOf(r)[0];
      expect(o?.params).toMatchObject({ dmarcPolicy: policy });
      expect(o?.related).toEqual([{ checkId: 'MAIL-01', subject: 'dmarc', relation: 'dmarc-policy' }]);
    },
  );

  it('all → no finding', () => {
    const r = run(
      site(['v=spf1 mx include:_spf.provider.net -all'], REJECT, {
        'TXT _spf.provider.net': ['v=spf1 ip4:192.0.2.0/24 -all'],
      }),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('~all via redirect with DMARC quarantine → softfail-with-enforcement', () => {
    const r = run(
      site(['v=spf1 redirect=_spf.example.net'], ['v=DMARC1; p=quarantine'], {
        'TXT _spf.example.net': ['v=spf1 ip4:192.0.2.0/24 ~all'],
      }),
    );
    expect(variantsOf(r)).toEqual(['softfail-with-enforcement']);
  });

  it('ptr → info ptr-mechanism next to the all result', () => {
    expect(variantsOf(run(site(['v=spf1 ptr -all'])))).toEqual(['ptr-mechanism']);
    expect(variantsOf(run(site(['v=spf1 ptr ~all'], ['v=DMARC1; p=none'])))).toEqual([
      'ptr-mechanism',
      'softfail-without-enforcement',
    ]);
  });
});

describe('MAIL-02 uses the DMARC policy of the mail domain', () => {
  it('a record only on www does not count as enforcement for the mail domain', () => {
    const r = run({
      ...site(['v=spf1 ~all'], 'NXDOMAIN'),
      'TXT _dmarc.www.example.de': ['v=DMARC1; p=reject'],
    });
    expect(variantsOf(r)).toEqual(['softfail-without-enforcement']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ dmarcPolicy: 'missing' });
  });
});

describe('MAIL-02 Null MX (no exception in §3.11: evaluated like any domain, text mentions the Null MX)', () => {
  const nullMx = { 'MX example.de': ['0 .'] } as const;

  it('Null MX without SPF → record-not-found with nullMx and the MX evidence', () => {
    const r = run(site('NXDOMAIN', REJECT, nullMx));
    expect(variantsOf(r)).toEqual(['record-not-found']);
    const o = observationsOf(r)[0];
    expect(o?.params).toMatchObject({ nullMx: 'yes' });
    expect(o?.evidence.some((e) => e.type === 'dns' && e.qtype === 'MX')).toBe(true);
  });

  it.each([
    ['v=spf1 -all', [], 'no finding'],
    ['v=spf1 ~all', ['softfail-with-enforcement'], 'the DMARC reject matrix as usual'],
    ['v=spf1 ptr ?all', ['permissive-qualifier', 'ptr-mechanism'], 'ptr is reported as usual'],
  ])('Null MX with "%s" → %j: %s', (record, variants) => {
    expect(variantsOf(run(site([record], REJECT, nullMx)))).toEqual(variants);
  });
});

describe('MAIL-02 errors', () => {
  it.each(['SERVFAIL', 'TIMEOUT'] as const)('%s on the SPF lookup → error, not missing', (rcode) => {
    const r = run(site(rcode));
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it.each([
    ['~all while the DMARC lookup failed (matrix undecidable)', site(['v=spf1 ~all'], 'SERVFAIL'), 'error'],
    ['-all while the DMARC lookup failed (still decidable)', site(['v=spf1 -all'], 'SERVFAIL'), 'completed'],
    [
      'the redirect target failed (effective all unknown)',
      site(['v=spf1 redirect=_spf.example.net'], REJECT, { 'TXT _spf.example.net': 'SERVFAIL' }),
      'error',
    ],
  ])('%s → %s', (_label, spec, status) => {
    expect(run(spec).status).toBe(status);
  });

  it('include failed temporarily with +all → partial with limitation, the established result is kept', () => {
    const r = run(
      site(['v=spf1 include:_spf.provider.net +all'], REJECT, { 'TXT _spf.provider.net': 'TIMEOUT' }),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['spf-include-unresolved']);
    expect(variantsOf(r)).toEqual(['permissive-qualifier']);
  });

  it.each([
    ['-all', 'SERVFAIL'],
    ['-all', 'TIMEOUT'],
    ['~all', 'SERVFAIL'],
  ] as const)('%s with an include that failed (%s) → error, not clean', (all, rcode) => {
    const r = run(
      site([`v=spf1 include:failed.example.de ${all}`], REJECT, { 'TXT failed.example.de': rcode }),
    );
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
    expect(r.error?.message).toMatch(`failed.example.de ${rcode}`);
  });

  it('a permerror established in the resolved part stays, the failed include is a limitation', () => {
    const r = run(
      site(['v=spf1 include:none.example.de include:failed.example.de -all'], REJECT, {
        'TXT none.example.de': 'NXDOMAIN',
        'TXT failed.example.de': 'SERVFAIL',
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['spf-include-unresolved']);
    expect(variantsOf(r)).toEqual(['record-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'include-no-record' });
  });

  it('SPF query missing from the snapshot → error', () => {
    const spec = site('NXDOMAIN');
    delete spec['TXT example.de'];
    expect(run(spec).status).toBe('error');
  });

  it('IP target → not_applicable', () => {
    const r = runCheck(mail02, dnsSnapshot({}, { notApplicable: 'ip-target' }));
    expect(r).toMatchObject({ status: 'not_applicable', reason: 'ip-target' });
  });
});
