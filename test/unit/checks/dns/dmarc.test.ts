import { describe, expect, it } from 'vitest';
import {
  analyzeDmarc,
  dmarcEnforcement,
  dmarcTreeWalkNames,
  parseDmarcRecord,
} from '../../../../src/checks/dns/lib/dmarc.ts';
import { type ZoneSpec, zone } from './zone.ts';

/** The DNS Tree Walk from `host` for the organizational domain example.de over these answers. */
const walk = (spec: ZoneSpec, host = 'www.example.de') => analyzeDmarc(host, 'example.de', zone(spec));

describe('parseDmarcRecord (RFC 9989 tags, legacy pct)', () => {
  it('parses a typical enforcing record', () => {
    const r = parseDmarcRecord('v=DMARC1; p=reject; rua=mailto:[redacted]@example.de; adkim=s; aspf=r');
    expect(r).toMatchObject({ invalid: null, p: 'reject', sp: null, np: null, t: null, pct: null });
    expect(r.rua).toEqual(['mailto:[redacted]@example.de']);
    expect(r.tags.adkim).toBe('s');
  });

  it('is case-insensitive for tag names and keyword values', () => {
    const r = parseDmarcRecord('V=dmarc1;P=Quarantine;SP=none;NP=reject;T=y;PCT=50;psd=n');
    expect(r).toMatchObject({
      invalid: null,
      p: 'quarantine',
      sp: 'none',
      np: 'reject',
      t: 'y',
      pct: 50,
      psd: 'n',
    });
  });

  it('splits multiple report URIs', () => {
    expect(parseDmarcRecord('v=DMARC1; p=none; rua=mailto:a@x.de, mailto:b@y.de').rua).toHaveLength(2);
  });

  it.each([
    ['v=DMARC1', 'p-missing'],
    ['v=DMARC1; rua=mailto:a@x.de', 'p-missing'],
    ['v=DMARC1; p=rejected', 'p-invalid'],
    ['v=DMARC1 p=reject', 'syntax'],
    ['v=DMARC1; p=reject; garbage', 'syntax'],
    ['p=reject; v=DMARC1', 'version-not-first'],
  ])('%s → invalid %s', (txt, reason) => {
    expect(parseDmarcRecord(txt).invalid).toBe(reason);
  });

  it('ignores unknown tags, empty segments and invalid optional values', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; ; fo=1; foo=bar; sp=sometimes; pct=abc;');
    expect(r.invalid).toBeNull();
    expect(r.sp).toBeNull();
    expect(r.pct).toBeNull();
  });
});

describe('dmarcTreeWalkNames (RFC 9989 §4.10 DNS Tree Walk)', () => {
  it.each([
    ['www.example.de', ['www.example.de', 'example.de', 'de']],
    ['example.de', ['example.de', 'de']],
    ['Shop.Example.DE.', ['shop.example.de', 'example.de', 'de']],
    ['a.b.example.de', ['a.b.example.de', 'b.example.de', 'example.de', 'de']],
    // x >= 5 labels: shorten to 4 labels in one step, then one label at a time
    ['x.a.b.example.de', ['x.a.b.example.de', 'a.b.example.de', 'b.example.de', 'example.de', 'de']],
    ['a.b.c.d.example.co.uk', ['a.b.c.d.example.co.uk', 'd.example.co.uk', 'example.co.uk', 'co.uk', 'uk']],
  ])('%s', (host, names) => {
    expect(dmarcTreeWalkNames(host)).toEqual(names);
  });

  it('never exceeds 8 names', () => {
    expect(dmarcTreeWalkNames('a.b.c.d.e.f.g.h.i.j.example.de').length).toBeLessThanOrEqual(8);
  });
});

describe('analyzeDmarc', () => {
  it('finds the organizational record through the walk (host has none)', () => {
    const a = walk({
      'TXT _dmarc.www.example.de': 'NXDOMAIN',
      'TXT _dmarc.example.de': ['v=DMARC1; p=reject; rua=mailto:[redacted]@example.de'],
    });
    expect(a.state).toBe('found');
    expect(a.found?.scope).toBe('org');
    expect(a.found?.record?.p).toBe('reject');
    expect(a.steps.map((s) => s.qname)).toEqual(['_dmarc.www.example.de', '_dmarc.example.de']);
  });

  it('stops at the host when the host has its own record', () => {
    const a = walk({ 'TXT _dmarc.www.example.de': ['v=DMARC1; p=none'] });
    expect(a.state).toBe('found');
    expect(a.found?.scope).toBe('host');
    expect(a.steps).toHaveLength(1);
  });

  it('reports missing after walking up to the TLD', () => {
    const a = walk({
      'TXT _dmarc.www.example.de': 'NXDOMAIN',
      'TXT _dmarc.example.de': 'NODATA',
      'TXT _dmarc.de': 'NXDOMAIN',
    });
    expect(a.state).toBe('missing');
    expect(a.steps).toHaveLength(3);
  });

  it('skips TXT records that are not DMARC', () => {
    const a = walk({ 'TXT _dmarc.example.de': ['hello world'], 'TXT _dmarc.de': 'NXDOMAIN' }, 'example.de');
    expect(a.state).toBe('missing');
  });

  it('asks for the next name when the walk is not complete', () => {
    const a = walk({ 'TXT _dmarc.www.example.de': 'NXDOMAIN' });
    expect(a.state).toBe('incomplete');
    expect(a.next).toEqual({ qname: '_dmarc.example.de', step: 1 });
  });

  it('SERVFAIL/TIMEOUT without any record found → failed, never missing', () => {
    const a = walk({
      'TXT _dmarc.www.example.de': 'NXDOMAIN',
      'TXT _dmarc.example.de': 'SERVFAIL',
      'TXT _dmarc.de': 'NXDOMAIN',
    });
    expect(a.state).toBe('failed');
    expect(a.failures.map((s) => s.qname)).toEqual(['_dmarc.example.de']);
  });

  it('a failure on a more specific name is not replaced by the parent policy → failed', () => {
    const a = walk({
      'TXT _dmarc.www.example.de': 'TIMEOUT',
      'TXT _dmarc.example.de': ['v=DMARC1; p=reject'],
    });
    expect(a.state).toBe('failed');
    expect(a.found).toBeNull();
    expect(a.failures.map((s) => s.qname)).toEqual(['_dmarc.www.example.de']);
    // The walk stops at the failure: the parent is not needed (and not queried by the collector).
    expect(a.steps.map((s) => s.qname)).toEqual(['_dmarc.www.example.de']);
    expect(a.next).toBeNull();
  });

  it('marks a record above the organizational domain as PSD scope', () => {
    const a = walk({
      'TXT _dmarc.www.example.de': 'NXDOMAIN',
      'TXT _dmarc.example.de': 'NXDOMAIN',
      'TXT _dmarc.de': ['v=DMARC1; p=reject; psd=y'],
    });
    expect(a.found?.scope).toBe('psd');
  });

  it('two DMARC records at one name → invalid multiple-records', () => {
    const a = walk({ 'TXT _dmarc.example.de': ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] }, 'example.de');
    expect(a.found).toMatchObject({ invalid: 'multiple-records', record: null });
  });

  it('a record with v=DMARC1 not first is found but invalid', () => {
    const a = walk({ 'TXT _dmarc.example.de': ['p=reject; v=DMARC1'] }, 'example.de');
    expect(a.found?.invalid).toBe('version-not-first');
  });
});

describe('dmarcEnforcement (for the MAIL-02 matrix)', () => {
  const at = (txt: string | 'NXDOMAIN' | 'SERVFAIL') =>
    dmarcEnforcement(
      walk(
        {
          'TXT _dmarc.example.de': txt === 'NXDOMAIN' || txt === 'SERVFAIL' ? txt : [txt],
          'TXT _dmarc.de': 'NXDOMAIN',
        },
        'example.de',
      ),
    );

  it.each([
    ['v=DMARC1; p=reject', 'reject'],
    ['v=DMARC1; p=quarantine', 'quarantine'],
    ['v=DMARC1; p=none', 'none'],
    ['v=DMARC1; p=bogus', 'invalid'],
    ['NXDOMAIN', 'missing'],
    ['SERVFAIL', 'unknown'],
  ] as const)('%s → %s', (txt, policy) => {
    expect(at(txt)).toBe(policy);
  });
});
