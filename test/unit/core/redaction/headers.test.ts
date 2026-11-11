import { describe, expect, it } from 'vitest';
import {
  MAX_HEADER_VALUE,
  snapshotHeaderRecords,
  storedHeaderRecord,
} from '../../../../src/core/redaction/headers.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';

const BASE = 'https://www.example.test/';
const CSP = 'content-security-policy';

describe('snapshotHeaderRecords: values over the limit', () => {
  it('another long value is cut and flagged, without facts', () => {
    const rec = storedHeaderRecord('permissions-policy', `camera=(${'self '.repeat(600)})`, BASE, (u) => u);
    expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
    expect(rec.truncated).toBe(true);
    expect(rec.frameAncestors).toBeUndefined();
  });

  it('keeps no value of a non-allowlisted header, whatever its length', () => {
    const [rec] = snapshotHeaderRecords([{ name: 'x-trace', value: 'x'.repeat(5000) }], BASE);
    expect(rec).toEqual({ name: 'x-trace', value: '[redacted]' });
  });
});

describe('the stored Link value: text outside the targets is reduced too', () => {
  const stored = (value: string) => storedHeaderRecord('link', value, BASE, sanitizeUrl).value;

  it.each([
    [
      'a URL after a closed target',
      '</a.css>; rel=preload, https://cdn.example.test/p?uid=zq7alice123',
      '<https://www.example.test/a.css>; rel=preload, [redacted]',
    ],
    ['an unclosed target', '<https://open.example.test/?token=zq7abc', '[redacted]'],
    [
      'an unclosed relative target after a closed one',
      '</a.css>; rel=preload, </p?uid=zq7alice',
      '<https://www.example.test/a.css>; rel=preload, [redacted]',
    ],
    [
      'a relative URL in a parameter',
      '</a.css>; rel=preload; anchor="/p?uid=zq7alice"',
      '<https://www.example.test/a.css>; rel=preload; anchor="https://www.example.test/p?uid=[redacted]"',
    ],
    [
      'an address in a parameter',
      '</a.css>; rel=author; title="zq7alice@mail.invalid"',
      '<https://www.example.test/a.css>; rel=author; title=[redacted]',
    ],
    [
      'a percent-encoded address in an extended parameter (RFC 8187)',
      "</team/max>; rel=author; title*=UTF-8''zq7max.mustermann%40example.test",
      '<https://www.example.test/team/max>; rel=author; title*=[redacted]',
    ],
    [
      'an encoded address in a relative URL in a parameter',
      '</a.css>; rel=preload; anchor="/u/zq7alice%40mail.invalid"',
      '<https://www.example.test/a.css>; rel=preload; anchor="https://www.example.test/u/[redacted]@mail.invalid"',
    ],
    [
      'a comma in the query of a relative URL in a parameter',
      '</a.css>; rel=preload; anchor="/p?ids=1,zq7tail"',
      '<https://www.example.test/a.css>; rel=preload; anchor="https://www.example.test/p?ids=[redacted]"',
    ],
    [
      'a fragment in a parameter',
      '</a.css>; rel=preload; anchor="#access_token=zq7anchor"',
      '<https://www.example.test/a.css>; rel=preload; anchor=""',
    ],
    [
      'a query glued to a closing bracket',
      '<https://a.example.test/x>; rel=next; title=(bar)?u=zq7secret',
      '<https://a.example.test/x>; rel=next; title=[redacted]',
    ],
  ])('%s', (_label, value, expected) => {
    expect(stored(value)).toBe(expected);
  });

  it.each([
    '<https://fonts.example.test/>; rel=preconnect',
    '<https://www.example.test/a.css>; rel="preload"; as=style, <https://www.example.test/b.js>; rel=modulepreload',
    '<https://fonts.example.test/>; rel=preconnect; crossorigin',
    '<https://www.example.test/team/max>; rel=author',
    '<https://www.example.test/a.css>; rel=preload; anchor="/de/"',
    '<https://www.example.test/fonts/a.woff2>; rel=preload; as=font; type=font/woff2; crossorigin',
    '<https://www.example.test/p/3>; rel=next,<https://www.example.test/p/1>; rel=prev',
  ])('counterexample: an ordinary Link value is stored as sent: %s', (value) => {
    expect(stored(value)).toBe(value);
  });
});

describe('the other kept values: addresses masked, URLs with a query sanitized', () => {
  it.each([
    ['x-frame-options', 'ALLOW-FROM zq7max.mustermann@example.test', 'ALLOW-FROM [redacted]'],
    ['content-language', 'mailto:zq7max.mustermann@example.test', '[redacted]'],
    [
      'x-xss-protection',
      '1; mode=block; report=/xss-report?u=zq7alice',
      '1; mode=block; report=https://www.example.test/xss-report?u=[redacted]',
    ],
    [
      'permissions-policy',
      'geolocation=(self "wss://ws.example.test/x?token=zq7abc")',
      'geolocation=(self "wss://ws.example.test/")',
    ],
    [
      'strict-transport-security',
      'max-age=31536000; report-uri="//r.example.test/hsts?u=zq7alice"',
      'max-age=31536000; [redacted]',
    ],
    ['referrer-policy', 'no-referrer, zq7alice(at)mail.invalid', 'no-referrer, [redacted]'],
    ['x-frame-options', 'ALLOW-FROM /embed/zq7alice%40mail.invalid', 'ALLOW-FROM [redacted]'],
    [
      'x-xss-protection',
      '1; mode=block; report=/xss/zq7bob%40mail.invalid',
      '1; mode=block; report=https://www.example.test/xss/[redacted]@mail.invalid',
    ],
    [
      'x-xss-protection',
      '1; mode=block; report=wss://r.example.test/r/zq7alice%40mail.invalid',
      '1; mode=block; report=wss:[redacted]',
    ],
    [
      'permissions-policy',
      'geolocation=(self "//maps.example.test/u/zq7dave%40mail.invalid")',
      'geolocation=(self [redacted])',
    ],
    ['x-frame-options', 'ALLOW-FROM /u/zq7carol@intranet', 'ALLOW-FROM [redacted]'],
    ['x-frame-options', 'ALLOW-FROM zq7carol@intranet', 'ALLOW-FROM [redacted]'],
    ['x-frame-options', 'ALLOW-FROM zq7alice%2540mail.invalid', 'ALLOW-FROM [redacted]'],
    ['content-language', 'de-DE, zq7alice%40mail.invalid', 'de-DE, [redacted]'],
    ['x-frame-options', 'ALLOW-FROM /embed?ids=12,zq7tail', 'ALLOW-FROM [redacted],[redacted]'],
    [
      'x-xss-protection',
      '1; mode=block; report=/xss-report?q=O(zq7tail)',
      '1; mode=block; report=https://www.example.test/xss-report?q=[redacted]',
    ],
    [
      'x-xss-protection',
      "1; mode=block; report=/r?u=abc'zq7tail",
      '1; mode=block; report=https://www.example.test/r?u=[redacted]',
    ],
    [
      'x-xss-protection',
      '1; mode=block; report=https://r.example.test/r?u=abc,zq7tail',
      '1; mode=block; report=https://r.example.test/r?u=[redacted]',
    ],
    [
      'x-xss-protection',
      "1; mode=block; report=https://r.example.test/r?u=abc'zq7tail",
      '1; mode=block; report=https://r.example.test/r?u=[redacted]',
    ],
    [
      'x-xss-protection',
      "1; mode=block; report=https://r.example.test/r#a'zq7tail",
      '1; mode=block; report=https://r.example.test/r',
    ],
    [
      'permissions-policy',
      'geolocation=(self "wss://ws.example.test/x?token=a"zq7tail")',
      'geolocation=(self [redacted])',
    ],
    ['permissions-policy', 'geolocation=(self)?u=zq7secret', '[redacted]'],
    ['x-frame-options', 'ALLOW-FROM (x)?u=zq7secret', 'ALLOW-FROM [redacted]'],
    ['x-frame-options', 'ALLOW-FROM <x>?u=zq7secret', 'ALLOW-FROM [redacted]'],
  ])('%s: %s', (name, value, expected) => {
    const rec = storedHeaderRecord(name, value, BASE, sanitizeUrl);
    expect(rec.value).toBe(expected);
    expect(JSON.stringify(rec)).not.toContain('zq7');
  });

  it.each([
    ['x-frame-options', 'DENY'],
    ['x-frame-options', 'SAMEORIGIN'],
    ['x-frame-options', 'ALLOW-FROM https://a.example.test/'],
    ['strict-transport-security', 'max-age=31536000; includeSubDomains; preload'],
    ['x-content-type-options', 'nosniff'],
    ['x-xss-protection', '1; mode=block'],
    ['x-xss-protection', '1; mode=block; report=/xss-report'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    ['referrer-policy', 'no-referrer, strict-origin-when-cross-origin'],
    ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
    ['permissions-policy', 'geolocation=(self "https://maps.example.test/"), fullscreen=*'],
    ['x-xss-protection', '1; mode=block; report=/xss-report?v=2'],
    ['cross-origin-opener-policy', 'same-origin; report-to="coop"'],
    ['cross-origin-embedder-policy', 'require-corp'],
    ['cross-origin-resource-policy', 'same-site'],
    ['content-type', 'text/html; charset=utf-8'],
    ['content-language', 'de-DE'],
    ['content-language', 'de-DE, en'],
    ['retry-after', '120'],
    ['retry-after', 'Fri, 30 Oct 2026 12:00:10 GMT'],
  ])('counterexample: %s %j is stored as sent', (name, value) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(value);
  });

  it.each([
    [
      'permissions-policy',
      'geolocation=(self "https://maps.example.test/embed"), camera=(self "wss://ws.example.test/x?v=2")',
      'geolocation=(self "https://maps.example.test/"), camera=(self "wss://ws.example.test/")',
    ],
    [
      'permissions-policy',
      'geolocation=(self "//maps.example.test/embed"), fullscreen=*',
      'geolocation=(self [redacted]), fullscreen=*',
    ],
    [
      'content-type',
      'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW',
      'multipart/form-data; boundary=[redacted]',
    ],
    [
      'content-type',
      'application/ld+json; profile=urn:example:profile',
      'application/ld+json; profile=[redacted]',
    ],
  ])('a part outside the grammar is redacted, the rest stays: %s %j', (name, value, expected) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(expected);
  });
});

describe('values a real site sends are stored as sent', () => {
  it.each([
    ['x-frame-options', 'ALLOWALL'],
    ['permissions-policy', 'geolocation=(), camera=(self)'],
  ])('%s: %s', (name, value) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(value);
  });

  it.each([
    [
      'a CSP of a large site: the sanitizer writes a trailing slash after a bare origin',
      CSP,
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://*.google-analytics.com; img-src * data:; frame-ancestors 'self' https://partner.example.test; upgrade-insecure-requests; report-uri /csp-report",
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com/ https://*.google-analytics.com/; img-src * data:; frame-ancestors 'self' https://partner.example.test/; upgrade-insecure-requests; report-uri /csp-report",
    ],
    [
      'a Permissions-Policy origin is written as the sanitizer writes an origin',
      'permissions-policy',
      'geolocation=(), camera=(self "https://maps.example.test")',
      'geolocation=(), camera=(self "https://maps.example.test/")',
    ],
  ])('%s', (_label, name, value, expected) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(expected);
  });
});
