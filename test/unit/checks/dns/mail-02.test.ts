import { describe, expect, it } from 'vitest';
import { mail02 } from '../../../../src/checks/dns/mail-02.ts';
import { observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, type ZoneEntry, type ZoneSpec } from './zone.ts';

const REJECT = ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'] as const;

function site(spf: ZoneEntry, dmarc: ZoneEntry = REJECT, extra: ZoneSpec = {}): ZoneSpec {
  return {
    'MX example.de': ['10 mx.example.de'],
    'TXT _dmarc.www.example.de': 'NXDOMAIN',
    'TXT _dmarc.example.de': dmarc,
    'TXT _dmarc.de': 'NXDOMAIN',
    'TXT example.de': spf,
    ...extra,
  };
}

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

  it('two v=spf1 records → record-invalid (multiple-records)', () => {
    const r = run(site(['v=spf1 -all', 'v=spf1 include:_spf.google.com ~all']));
    expect(variantsOf(r)).toEqual(['record-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'multiple-records', count: 2 });
  });

  it('+all → permissive-qualifier', () => {
    const r = run(site(['v=spf1 +all']));
    expect(variantsOf(r)).toEqual(['permissive-qualifier']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ qualifier: '+all' });
  });

  it('?all → permissive-qualifier; no all at all → permissive-qualifier (none)', () => {
    const q = run(site(['v=spf1 ip4:192.0.2.1 ?all']));
    expect(variantsOf(q)).toEqual(['permissive-qualifier']);
    expect(observationsOf(q)[0]?.params).toMatchObject({ qualifier: '?all' });
    const none = run(site(['v=spf1 ip4:192.0.2.1']));
    expect(observationsOf(none)[0]?.params).toMatchObject({ qualifier: 'none' });
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

  it('permerror: syntax error', () => {
    const r = run(site(['v=spf1 ip4:192.0.2.300 -all']));
    expect(variantsOf(r)).toEqual(['record-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'syntax' });
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

  it('Null MX with v=spf1 -all → no finding', () => {
    expect(variantsOf(run(site(['v=spf1 -all'], REJECT, nullMx)))).toEqual([]);
  });

  it('Null MX with ~all and DMARC reject → softfail-with-enforcement (matrix as usual)', () => {
    const r = run(site(['v=spf1 ~all'], REJECT, nullMx));
    expect(variantsOf(r)).toEqual(['softfail-with-enforcement']);
  });

  it('Null MX with ?all → permissive-qualifier; ptr is reported as usual', () => {
    expect(variantsOf(run(site(['v=spf1 ptr ?all'], REJECT, nullMx)))).toEqual([
      'permissive-qualifier',
      'ptr-mechanism',
    ]);
  });
});

describe('MAIL-02 errors', () => {
  it.each(['SERVFAIL', 'TIMEOUT'] as const)('%s on the SPF lookup → error, not missing', (rcode) => {
    const r = run(site(rcode));
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it('~all while the DMARC lookup failed → error (matrix undecidable)', () => {
    expect(run(site(['v=spf1 ~all'], 'SERVFAIL')).status).toBe('error');
  });

  it('all while the DMARC lookup failed → still decidable', () => {
    expect(run(site(['v=spf1 -all'], 'SERVFAIL')).status).toBe('completed');
  });

  it('redirect target failed → error (effective all unknown)', () => {
    const r = run(site(['v=spf1 redirect=_spf.example.net'], REJECT, { 'TXT _spf.example.net': 'SERVFAIL' }));
    expect(r.status).toBe('error');
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
