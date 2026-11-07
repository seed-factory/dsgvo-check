import { describe, expect, it } from 'vitest';
import {
  analyzeSpf,
  isSpfCandidate,
  isSpfRecord,
  parseSpfRecord,
} from '../../../../src/checks/dns/lib/spf.ts';
import { type ZoneSpec, zone } from './zone.ts';

describe('isSpfRecord / isSpfCandidate', () => {
  it.each([
    ['v=spf1 -all', true],
    ['v=spf1', true],
    ['V=SPF1 ~all', true],
    ['v=spf10 -all', false],
    ['v=spf1-all', false],
    [' v=spf1 -all', false],
    ['google-site-verification=abc', false],
  ])('%s → %s', (txt, ok) => {
    expect(isSpfRecord(txt)).toBe(ok);
  });

  it('keeps near misses as candidates (for evidence), drops unrelated TXT', () => {
    expect(isSpfCandidate(' v=spf1 -all')).toBe(true);
    expect(isSpfCandidate('v=spf1-all')).toBe(true);
    expect(isSpfCandidate('MS=ms12345')).toBe(false);
  });
});

describe('parseSpfRecord (RFC 7208 §4.6, §5, §6)', () => {
  it('parses mechanisms with qualifiers and modifiers', () => {
    const r = parseSpfRecord(
      'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 a mx:mail.example.de/24 include:_spf.google.com ?ptr -all exp=explain.example.de',
    );
    expect(r.errors).toEqual([]);
    expect(r.mechanisms.map((m) => `${m.qualifier}${m.name}${m.value ? `:${m.value}` : ''}`)).toEqual([
      '+ip4:192.0.2.0/24',
      '+ip6:2001:db8::/32',
      '+a',
      '+mx:mail.example.de',
      '+include:_spf.google.com',
      '?ptr',
      '-all',
    ]);
    expect(r.exp).toBe('explain.example.de');
  });

  it.each([
    '::',
    '::1',
    '2001:db8::',
    '2001:db8::/32',
    '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7::',
    '::2:3:4:5:6:7:8',
    'fe80::0:1/128',
    '::ffff:192.0.2.1',
    '64:ff9b::192.0.2.1/96',
    '1:2:3:4:5:6:192.0.2.1',
    'ABCD:ef01::1',
  ])('valid ip6 %s', (ip) => {
    expect(parseSpfRecord(`v=spf1 ip6:${ip} -all`).errors).toEqual([]);
  });

  it('parses redirect and ignores unknown modifiers', () => {
    const r = parseSpfRecord('v=spf1  redirect=_spf.example.net   foo=bar');
    expect(r.errors).toEqual([]);
    expect(r.redirect).toBe('_spf.example.net');
  });

  it.each([
    ['v=spf1 foo:bar -all', 'unknown-mechanism'],
    ['v=spf1 ip4:300.1.1.1 -all', 'invalid-ip4'],
    ['v=spf1 ip4:192.0.2.0/33 -all', 'invalid-ip4'],
    ['v=spf1 ip6:zz::1 -all', 'invalid-ip6'],
    // syntactically impossible IPv6 addresses (hextet length, group count, misplaced IPv4 tail).
    ['v=spf1 ip6:12345::1 -all', 'invalid-ip6'],
    ['v=spf1 ip6:1:2:3:4:5:6:7:8:9 -all', 'invalid-ip6'],
    ['v=spf1 ip6:1:2:3:4:5:6:7 -all', 'invalid-ip6'],
    ['v=spf1 ip6:1:2:3:4:5:6:7:8::1 -all', 'invalid-ip6'],
    ['v=spf1 ip6:1::2::3 -all', 'invalid-ip6'],
    ['v=spf1 ip6:2001:db8:::1 -all', 'invalid-ip6'],
    ['v=spf1 ip6::1 -all', 'invalid-ip6'],
    ['v=spf1 ip6:1.2.3.4::1 -all', 'invalid-ip6'],
    ['v=spf1 ip6:::ffff:300.1.1.1 -all', 'invalid-ip6'],
    ['v=spf1 ip6:2001:db8::/129 -all', 'invalid-ip6'],
    ['v=spf1 include: -all', 'missing-domain'],
    ['v=spf1 include -all', 'missing-domain'],
    ['v=spf1 all:x', 'invalid-all'],
    ['v=spf1 redirect=a.de redirect=b.de', 'duplicate-modifier'],
    ['v=spf1 redirect= -all', 'missing-domain'],
  ])('%s → %s', (txt, code) => {
    expect(parseSpfRecord(txt).errors[0]).toMatch(new RegExp(`^${code}`));
  });
});

const spf = (spec: ZoneSpec, domain = 'example.de') => analyzeSpf(domain, zone(spec));
const ok = (txt: string) => [txt] as const;

describe('analyzeSpf', () => {
  it('no record (NXDOMAIN, NODATA or only other TXT) → none', () => {
    expect(spf({ 'TXT example.de': 'NXDOMAIN' }).state).toBe('none');
    expect(spf({ 'TXT example.de': 'NODATA' }).state).toBe('none');
    expect(spf({ 'TXT example.de': [] }).state).toBe('none');
  });

  it('two v=spf1 records → multiple', () => {
    const a = spf({ 'TXT example.de': ['v=spf1 -all', 'v=spf1 include:x.de ~all'] });
    expect(a.state).toBe('multiple');
    expect(a.records).toHaveLength(2);
  });

  it('SERVFAIL on the domain → failed (not none)', () => {
    expect(spf({ 'TXT example.de': 'SERVFAIL' }).state).toBe('failed');
  });

  it('missing top-level query → pending', () => {
    const a = spf({});
    expect(a.state).toBe('pending');
    expect(a.pending).toEqual([{ qname: 'example.de', type: 'TXT', purpose: 'spf' }]);
  });

  it('follows includes; the all qualifier of an include does not leak', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 include:_spf.provider.net ~all'),
      'TXT _spf.provider.net': ok('v=spf1 ip4:192.0.2.1 -all'),
    });
    expect(a).toMatchObject({ state: 'found', all: '~', allSource: 'record', lookups: 1, permerrors: [] });
    expect(a.complete).toBe(true);
  });

  it('lists unresolved include targets as pending', () => {
    const a = spf({ 'TXT example.de': ok('v=spf1 include:_spf.provider.net -all') });
    expect(a.complete).toBe(false);
    expect(a.pending).toEqual([{ qname: '_spf.provider.net', type: 'TXT', purpose: 'spf-include' }]);
  });

  it('counts lookups across the tree: 11 → permerror too-many-lookups', () => {
    const includes = Array.from({ length: 6 }, (_, i) => `include:i${i}.example.net`).join(' ');
    const spec: ZoneSpec = { 'TXT example.de': ok(`v=spf1 ${includes} -all`) };
    for (let i = 0; i < 6; i++) spec[`TXT i${i}.example.net`] = ok(`v=spf1 include:n${i}.example.net -all`);
    for (let i = 0; i < 6; i++) spec[`TXT n${i}.example.net`] = ok('v=spf1 ip4:192.0.2.1 -all');
    const a = spf(spec);
    expect(a.permerrors[0]?.reason).toBe('too-many-lookups');
    expect(a.lookups).toBe(11);
    expect(a.pending).toEqual([]);
  });

  it('exactly 10 lookups is fine', () => {
    const includes = Array.from({ length: 10 }, (_, i) => `include:i${i}.example.net`).join(' ');
    const spec: ZoneSpec = { 'TXT example.de': ok(`v=spf1 ${includes} -all`) };
    for (let i = 0; i < 10; i++) spec[`TXT i${i}.example.net`] = ok('v=spf1 ip4:192.0.2.1 -all');
    const a = spf(spec);
    expect(a.lookups).toBe(10);
    expect(a.permerrors).toEqual([]);
  });

  it('detects include loops', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 include:a.example.net -all'),
      'TXT a.example.net': ok('v=spf1 include:example.de -all'),
    });
    expect(a.permerrors.map((p) => p.reason)).toContain('loop');
  });

  it('include without an SPF record → permerror include-no-record (and a void lookup)', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 include:gone.example.net -all'),
      'TXT gone.example.net': 'NXDOMAIN',
    });
    expect(a.permerrors[0]).toMatchObject({ reason: 'include-no-record', domain: 'gone.example.net' });
    expect(a.voidLookups).toBe(1);
  });

  it('more than 2 void lookups → permerror void-lookups', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 a:v1.example.de mx:v2.example.de exists:v3.example.de ip4:192.0.2.1 -all'),
      'A v1.example.de': 'NXDOMAIN',
      'MX v2.example.de': 'NODATA',
      'A v3.example.de': 'NXDOMAIN',
    });
    expect(a.voidLookups).toBe(3);
    expect(a.permerrors.map((p) => p.reason)).toEqual(['void-lookups']);
  });

  it('2 void lookups are tolerated', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 a:v1.example.de mx:v2.example.de -all'),
      'A v1.example.de': 'NXDOMAIN',
      'MX v2.example.de': 'NODATA',
    });
    expect(a.voidLookups).toBe(2);
    expect(a.permerrors).toEqual([]);
  });

  it('a and mx without a domain use the current domain (MX from the mail check is reused)', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 a mx -all'),
      'MX example.de': ['10 mx.example.de'],
    });
    expect(a.pending).toEqual([{ qname: 'example.de', type: 'A', purpose: 'spf-void-check' }]);
  });

  it('macros are counted but not resolved', () => {
    const a = spf({ 'TXT example.de': ok('v=spf1 exists:%{i}._spf.example.de -all') });
    expect(a).toMatchObject({ lookups: 1, pending: [], complete: true });
  });

  it('redirect provides the all qualifier', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 redirect=_spf.example.net'),
      'TXT _spf.example.net': ok('v=spf1 ip4:192.0.2.0/24 ~all'),
    });
    expect(a).toMatchObject({ all: '~', allSource: 'redirect', lookups: 1 });
  });

  it('redirect is ignored when the record has all; terms after all are ignored', () => {
    const a = spf({ 'TXT example.de': ok('v=spf1 -all include:x.example.net redirect=y.example.net') });
    expect(a).toMatchObject({ all: '-', lookups: 0, pending: [] });
  });

  it('redirect to a domain without SPF → permerror redirect-no-record', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 redirect=gone.example.net'),
      'TXT gone.example.net': 'NODATA',
    });
    expect(a.permerrors[0]?.reason).toBe('redirect-no-record');
    expect(a.all).toBeNull();
  });

  it('no all and no redirect → default neutral', () => {
    expect(spf({ 'TXT example.de': ok('v=spf1 ip4:192.0.2.1') })).toMatchObject({
      all: '?',
      allSource: 'default',
    });
  });

  it('syntax error → permerror syntax', () => {
    const a = spf({ 'TXT example.de': ok('v=spf1 ip4:192.0.2.1 includ:x.de -all') });
    expect(a.permerrors[0]).toMatchObject({ reason: 'syntax', domain: 'example.de' });
  });

  it('ptr counts only in the owner record and its redirect chain', () => {
    expect(spf({ 'TXT example.de': ok('v=spf1 ptr -all') }).ptr).toBe(true);
    const viaInclude = spf({
      'TXT example.de': ok('v=spf1 include:p.example.net -all'),
      'TXT p.example.net': ok('v=spf1 ptr -all'),
    });
    expect(viaInclude.ptr).toBe(false);
  });

  it('a temporary failure in an include is kept apart from the result', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 include:p.example.net ~all'),
      'TXT p.example.net': 'SERVFAIL',
    });
    expect(a).toMatchObject({ state: 'found', all: '~', complete: false, permerrors: [] });
    expect(a.failures.map((q) => q.qname)).toEqual(['p.example.net']);
  });

  it('a nested include with two SPF records → permerror', () => {
    const a = spf({
      'TXT example.de': ok('v=spf1 include:p.example.net -all'),
      'TXT p.example.net': ['v=spf1 -all', 'v=spf1 ~all'],
    });
    expect(a.permerrors[0]?.reason).toBe('include-multiple-records');
  });
});
