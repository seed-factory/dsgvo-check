import { describe, expect, it } from 'vitest';
import {
  formatAnswer,
  isFailure,
  isVoid,
  lookupFromQueries,
  mxState,
  normalizeName,
} from '../../../../src/checks/dns/lib/records.ts';
import { makeDnsQuery } from '../../../utils/snapshot-builder.ts';
import { zone, zoneQuery } from './zone.ts';

describe('names, rcodes and lookups', () => {
  it('normalizes names', () => {
    expect(normalizeName('_DMARC.Example.DE.')).toBe('_dmarc.example.de');
  });

  it('classifies rcodes', () => {
    expect(isFailure('SERVFAIL')).toBe(true);
    expect(isFailure('TIMEOUT')).toBe(true);
    expect(isFailure('REFUSED')).toBe(true);
    expect(isFailure('ERROR')).toBe(true);
    expect(isFailure('NXDOMAIN')).toBe(false);
    expect(isVoid(zoneQuery('TXT a.de', 'NXDOMAIN'))).toBe(true);
    expect(isVoid(zoneQuery('TXT a.de', 'NODATA'))).toBe(true);
    // NOERROR with only irrelevant (filtered) answers is not a void lookup
    expect(isVoid(zoneQuery('TXT a.de', []))).toBe(false);
  });

  it('looks up by type and normalized name; the first record wins', () => {
    const first = makeDnsQuery({ qname: 'Example.de.', type: 'TXT', rcode: 'NXDOMAIN' });
    const second = makeDnsQuery({ qname: 'example.de', type: 'TXT', rcode: 'NOERROR' });
    const lookup = lookupFromQueries([first, second]);
    expect(lookup('EXAMPLE.DE', 'TXT')).toBe(first);
    expect(lookup('example.de', 'MX')).toBeUndefined();
  });

  it('formats answers for evidence', () => {
    expect(formatAnswer({ type: 'MX', value: 'mx.example.de', priority: 10 })).toBe('10 mx.example.de');
    expect(formatAnswer({ type: 'TXT', value: 'v=spf1 -all' })).toBe('v=spf1 -all');
  });
});

describe('mxState (RFC 7505 Null MX)', () => {
  it.each([
    [{ 'MX example.de': ['10 mx1.example.de', '20 mx2.example.de'] }, 'present'],
    [{ 'MX example.de': ['0 .'] }, 'null'],
    [{ 'MX example.de': ['0 .', '10 mx.example.de'] }, 'present'],
    [{ 'MX example.de': 'NXDOMAIN' }, 'none'],
    [{ 'MX example.de': 'NODATA' }, 'none'],
    [{ 'MX example.de': 'SERVFAIL' }, 'unknown'],
    [{}, 'unknown'],
  ] as const)('%j → %s', (spec, state) => {
    expect(mxState(zone(spec)('example.de', 'MX'))).toBe(state);
  });
});
