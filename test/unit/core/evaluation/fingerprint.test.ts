import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_VERSION,
  fingerprint,
  subjects,
  tlsHostRole,
} from '../../../../src/core/evaluation/fingerprint.ts';

describe('fingerprint (5.4)', () => {
  it('is sha256 over JCS({v, checkId, variantGroup, subject})', () => {
    const input = { checkId: 'EMBED-01', variantGroup: 'fonts-loaded', subject: 'google-fonts' };
    const expected = createHash('sha256')
      .update(canonicalize({ v: FINGERPRINT_VERSION, ...input }) as string)
      .digest('hex');
    expect(fingerprint(input)).toBe(`sha256:${expected}`);
    expect(fingerprint(input)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable regardless of property order', () => {
    expect(fingerprint({ subject: 's', variantGroup: 'g', checkId: 'HDR-01' })).toBe(
      fingerprint({ checkId: 'HDR-01', variantGroup: 'g', subject: 's' }),
    );
  });

  it('differs by checkId, variantGroup and subject', () => {
    const a = fingerprint({
      checkId: 'HDR-01',
      variantGroup: 'missing',
      subject: 'strict-transport-security',
    });
    expect(fingerprint({ checkId: 'HDR-01', variantGroup: 'missing', subject: 'x-frame-options' })).not.toBe(
      a,
    );
    expect(
      fingerprint({ checkId: 'HDR-01', variantGroup: 'weak', subject: 'strict-transport-security' }),
    ).not.toBe(a);
    expect(
      fingerprint({ checkId: 'TLS-01', variantGroup: 'missing', subject: 'strict-transport-security' }),
    ).not.toBe(a);
  });

  it('does not depend on the target host (preview deploys keep fingerprints)', () => {
    // A first-party cookie on two different targets has the same subject and fingerprint.
    const onProd = subjects.cookie({
      name: '_ga',
      firstParty: true,
      etld1: 'example.de',
      path: '/',
      partitioned: false,
    });
    const onPreview = subjects.cookie({
      name: '_ga',
      firstParty: true,
      etld1: 'pr-42.example.vercel.app',
      path: '/',
      partitioned: false,
    });
    expect(onProd).toBe(onPreview);
    expect(onProd).not.toContain('example');
    const fp = (s: string) =>
      fingerprint({ checkId: 'CONSENT-02', variantGroup: 'tracking-cookie', subject: s });
    expect(fp(onProd)).toBe(fp(onPreview));
  });

  it('subject helpers follow table 5.4', () => {
    expect(subjects.service('google-analytics-4')).toBe('google-analytics-4');
    expect(subjects.service(null, 'Tracker.EXAMPLE')).toBe('unknown:tracker.example');
    expect(
      subjects.cookie({
        name: '_fbp',
        firstParty: false,
        etld1: 'facebook.com',
        path: '/',
        partitioned: true,
      }),
    ).toBe('_fbp|facebook.com|/|partitioned');
    expect(subjects.header('Strict-Transport-Security')).toBe('strict-transport-security');
    expect(subjects.record('DMARC')).toBe('dmarc');
    expect(subjects.document('impressum')).toBe('impressum');
    expect(subjects.consentUi()).toBe('consent-ui');
  });

  it('TLS subjects use host roles relative to the final host, not the way the target was typed (5.4)', () => {
    expect(subjects.tlsEndpoint('certificate', 'final')).toBe('certificate:final');
    expect(subjects.tlsEndpoint('http-entry', 'pair')).toBe('http-entry:pair');
    expect(tlsHostRole('www.example.de', 'www.example.de')).toBe('final');
    expect(tlsHostRole('WWW.Example.DE.', 'www.example.de')).toBe('final');
    expect(tlsHostRole('example.de', 'www.example.de')).toBe('pair');
    expect(tlsHostRole('www.example.de', 'example.de')).toBe('pair');
    // neither the final host nor its www/apex counterpart (target was a subdomain)
    expect(tlsHostRole('www.example.de', 'shop.example.de')).toBe('www');
    expect(tlsHostRole('example.de', 'shop.example.de')).toBe('apex');

    // example.de → redirect to www.example.de, and www.example.de typed directly: same subject for the www cert
    const viaApex = subjects.tlsEndpoint('certificate', tlsHostRole('www.example.de', 'www.example.de'));
    const direct = subjects.tlsEndpoint('certificate', tlsHostRole('www.example.de', 'www.example.de'));
    expect(viaApex).toBe(direct);
    const fp = (s: string) => fingerprint({ checkId: 'TLS-02', variantGroup: 'expiry', subject: s });
    expect(fp(subjects.tlsEndpoint('certificate', tlsHostRole('example.de', 'www.example.de')))).toBe(
      fp(subjects.tlsEndpoint('certificate', tlsHostRole('www.example.de', 'example.de'))),
    );
  });
});
