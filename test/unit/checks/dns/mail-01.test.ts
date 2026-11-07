import { describe, expect, it } from 'vitest';
import { mail01 } from '../../../../src/checks/dns/mail-01.ts';
import { makeSnapshot, observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, siteZone as site, type ZoneEntry, type ZoneSpec } from './zone.ts';

const RUA = 'rua=mailto:[redacted]@example.de';

const run = (spec: ZoneSpec) => runCheck(mail01, dnsSnapshot(spec));

describe('MAIL-01 DMARC: warning variants', () => {
  it('no record anywhere on the walk → record-not-found', () => {
    const r = run(site('NXDOMAIN'));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['record-not-found']);
    const o = observationsOf(r)[0];
    expect(o).toMatchObject({
      checkId: 'MAIL-01',
      confidence: 'high',
      subject: 'dmarc',
      phases: ['dns'],
      pages: [],
      params: { domain: 'example.de', inherited: 'none' },
    });
    const walk = o?.evidence.find((e) => e.type === 'dns' && e.treeWalk);
    expect(walk).toMatchObject({
      type: 'dns',
      qname: '_dmarc.de',
      treeWalk: ['_dmarc.www.example.de', '_dmarc.example.de', '_dmarc.de'],
      resolver: 'system',
    });
  });

  // Without rua the policy-none text does not claim that reports are requested, and a second weak-option item
  // would repeat its first step: policy-none names the missing rua itself.
  it.each([
    ['with rua', 'no', `v=DMARC1; p=none; ${RUA}`],
    ['without rua', 'yes', 'v=DMARC1; p=none'],
  ])('p=none %s → only policy-none (noRua %s)', (_label, noRua, record) => {
    const r = run(site([record]));
    expect(variantsOf(r)).toEqual(['policy-none']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ noRua });
  });

  it.each([
    [['v=DMARC1; p=reject', 'v=DMARC1; p=none'], 'multiple-records'],
    [['v=DMARC1; p=rejectt'], 'p-invalid'],
    [['v=DMARC1; rua=mailto:[redacted]@example.de'], 'p-missing'],
    [['p=reject; v=DMARC1'], 'version-not-first'],
  ] as const)('%j → record-invalid (%s)', (records, reason) => {
    const r = run(site(records));
    expect(variantsOf(r)).toEqual(['record-invalid']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason });
  });

  it('only a public-suffix (PSD) policy → record-not-found for the domain itself', () => {
    const r = run(site('NXDOMAIN', { 'TXT _dmarc.de': ['v=DMARC1; p=reject; psd=y'] }));
    expect(variantsOf(r)).toEqual(['record-not-found']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ inherited: 'psd' });
  });
});

describe('MAIL-01 DMARC: info variants and clean records', () => {
  it.each([
    ['p=reject with rua', `v=DMARC1; p=reject; ${RUA}`],
    ['p=quarantine with rua', `v=DMARC1; p=quarantine; ${RUA}`],
    ['pct=100 is not partial', `v=DMARC1; p=reject; pct=100; ${RUA}`],
  ])('%s → no finding', (_label, record) => {
    const r = run(site([record]));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('sp=none while p≠none → weak-option (info) listing sp=none', () => {
    const r = run(site([`v=DMARC1; p=quarantine; sp=none; ${RUA}`]));
    expect(variantsOf(r)).toEqual(['weak-option']);
    expect(observationsOf(r)[0]?.params).toMatchObject({
      policy: 'quarantine',
      count: 1,
      spNone: 'yes',
      testing: 'no',
      noRua: 'no',
    });
  });

  it('sp=none, t=y and no rua are one weak-option finding with the list (§3.10)', () => {
    const r = run(site(['v=DMARC1; p=reject; sp=none; t=y']));
    expect(observationsOf(r)).toHaveLength(1);
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'weak-option',
      params: { policy: 'reject', count: 3, spNone: 'yes', testing: 'yes', noRua: 'yes' },
    });
  });

  it('t=y → weak-option; legacy pct<100 → legacy-pct', () => {
    const t = run(site([`v=DMARC1; p=reject; t=y; ${RUA}`]));
    expect(variantsOf(t)).toEqual(['weak-option']);
    expect(observationsOf(t)[0]?.params).toMatchObject({ testing: 'yes', count: 1 });
    const r = run(site([`v=DMARC1; p=reject; pct=20; ${RUA}`]));
    expect(variantsOf(r)).toEqual(['legacy-pct']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ pct: 20, policy: 'reject' });
  });

  it('no rua → weak-option (info)', () => {
    const r = run(site(['v=DMARC1; p=reject']));
    expect(variantsOf(r)).toEqual(['weak-option']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ noRua: 'yes', count: 1 });
  });

  it('neighbour false finding: sp=none with p=none is only policy-none (no weak-option)', () => {
    expect(variantsOf(run(site([`v=DMARC1; p=none; sp=none; ${RUA}`])))).toEqual(['policy-none']);
  });

  it('a record published on the host itself is evaluated', () => {
    const r = run({
      'MX example.de': ['10 mx.example.de'],
      'TXT _dmarc.www.example.de': ['v=DMARC1; p=none'],
    });
    expect(variantsOf(r)).toEqual(['policy-none']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ domain: 'www.example.de' });
  });
});

describe('MAIL-01 Null MX (RFC 7505)', () => {
  const nullMx = (dmarc: ZoneEntry, extra: ZoneSpec = {}) =>
    site(dmarc, { 'MX example.de': ['0 .'], ...extra });

  it.each([
    ['no DMARC (not warning record-not-found)', 'missing', nullMx('NXDOMAIN')],
    ['p=none (and no policy-none)', 'none', nullMx(['v=DMARC1; p=none'])],
    [
      "only a PSD p=reject, which is not the domain's own policy",
      'missing',
      nullMx('NXDOMAIN', { 'TXT _dmarc.de': ['v=DMARC1; p=reject; psd=y'] }),
    ],
  ])('a Null-MX domain with %s → only info weak-option (Null MX, policy %s)', (_label, policy, spec) => {
    const r = run(spec);
    expect(variantsOf(r)).toEqual(['weak-option']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ kind: 'null-mx', policy });
  });

  it('p=reject on a Null-MX domain → no finding (rua not required)', () => {
    expect(variantsOf(run(nullMx(['v=DMARC1; p=reject'])))).toEqual([]);
  });
});

describe('MAIL-01 errors are never "no record"', () => {
  it.each(['SERVFAIL', 'TIMEOUT', 'REFUSED'] as const)('%s on the organizational name → error', (rcode) => {
    const r = run(site(rcode));
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
    expect(r.error?.message).toMatch(rcode);
  });

  it('walk not complete (query missing from the snapshot) → error', () => {
    const r = run({ 'MX example.de': ['10 mx.example.de'], 'TXT _dmarc.www.example.de': 'NXDOMAIN' });
    expect(r.status).toBe('error');
  });

  it('SERVFAIL on the host name is an error even when the organizational record has p=reject', () => {
    const r = run(site([`v=DMARC1; p=reject; ${RUA}`], { 'TXT _dmarc.www.example.de': 'SERVFAIL' }));
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
    expect(r.error?.message).toMatch('_dmarc.www.example.de SERVFAIL');
    expect(variantsOf(r)).toEqual([]);
  });

  it('MX unknown → evaluated as a mail domain, partial with limitation', () => {
    const r = run(site('NXDOMAIN', { 'MX example.de': 'SERVFAIL' }));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['mx-unknown']);
    expect(variantsOf(r)).toEqual(['record-not-found']);
  });
});

describe('MAIL-01 applicability and missing data', () => {
  it('IP target → not_applicable', () => {
    const r = runCheck(mail01, dnsSnapshot({}, { notApplicable: 'ip-target', domain: '192.0.2.1' }));
    expect(r).toMatchObject({ status: 'not_applicable', reason: 'ip-target' });
  });

  it('collector skipped → skipped with its reason', () => {
    const snap = makeSnapshot({
      collection: { dns: { status: 'skipped', reason: 'not-implemented', durationMs: 0 } },
    });
    expect(runCheck(mail01, snap)).toMatchObject({ status: 'skipped', reason: 'not-implemented' });
  });

  it('collector ok without section → error', () => {
    const snap = makeSnapshot({ collection: { dns: { status: 'ok', durationMs: 0 } } });
    expect(runCheck(mail01, snap)).toMatchObject({ status: 'error', reason: 'collector-error:dns' });
  });

  it('uses target.host when the section has no host (older snapshots)', () => {
    const spec = site([`v=DMARC1; p=reject; ${RUA}`]);
    const r = runCheck(mail01, dnsSnapshot(spec, { host: undefined }, 'https://www.example.de/'));
    expect(r.status).toBe('completed');
  });

  it('evidence carries masked records only', () => {
    const r = run(site(['v=DMARC1; p=none; rua=mailto:[redacted]@example.de']));
    const json = JSON.stringify(observationsOf(r));
    expect(json).toContain('mailto:[redacted]@example.de');
    expect(json).not.toMatch(/mailto:(?!\[redacted\])/);
  });
});
