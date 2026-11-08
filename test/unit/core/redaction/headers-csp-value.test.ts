import { describe, expect, it } from 'vitest';
import { snapshotHeaderRecords, storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';

const BASE = 'https://www.example.test/';
const CSP = 'content-security-policy';

describe('the stored CSP value', () => {
  const stored = (value: string, sanitize = sanitizeUrl) =>
    storedHeaderRecord(CSP, value, BASE, sanitize).value;

  it.each([
    ["script-src 'self' cdn.example.test/js/alice@mail.invalid", "script-src 'self' [redacted]"],
    ['script-src cdn.example.test/js/"alice@mail.invalid', 'script-src cdn.example.test'],
    ['frame-ancestors alice@mail.invalid', 'frame-ancestors [redacted]'],
    ['frame-ancestors alice%40mail.invalid', 'frame-ancestors [redacted]'],
    ['connect-src a.example.test:8443/x?user=alice', 'connect-src a.example.test:8443'],
  ])('%s', (value, expected) => {
    expect(stored(value)).toBe(expected);
  });

  it.each([
    ['connect-src wss://api.invalid/users/alice%40mail.invalid', 'connect-src [redacted]'],
    ['connect-src ftp://alice:pw@api.invalid/x', 'connect-src [redacted]'],
    ['connect-src ws://alice@mail.invalid:8080', 'connect-src [redacted]'],
    ['connect-src wss://api.invalid/stream?user=alice', 'connect-src wss://api.invalid'],
    [
      "connect-src 'self' wss://api.invalid/a https://x.test/ b.test/p",
      "connect-src 'self' wss://api.invalid https://x.test/ b.test",
    ],
  ])(
    'a source with a scheme other than http(s) is reduced to scheme and host, user info is no host source: %s',
    (value, expected) => {
      expect(stored(value, (u) => u)).toBe(expected);
    },
  );

  it('counterexample: sources with a scheme but nothing personal are kept as sent', () => {
    const value =
      "connect-src wss://api.example.test wss://api.example.test:8443 ws://localhost:35729 blob: data: 'self'";
    expect(stored(value, (u) => u)).toBe(value);
  });

  it('counterexample: a policy without personal data is stored as sent, a nonce keeps no payload', () => {
    const value =
      "default-src 'self'; script-src 'self' cdn.example.test *.example.test:8443 data: 'nonce-Zm9v+/=='; " +
      "frame-ancestors 'self' https://a.example/; report-uri /csp-report; sandbox allow-forms; " +
      'plugin-types application/pdf; img-src [::1]:3000 blob:';
    expect(stored(value, (u) => u)).toBe(value.replace('Zm9v+/==', '[redacted]'));
  });

  it.each([
    [
      'counterexample: http(s) sources still go through the URL sanitizer of the collector, without query and fragment',
      'portal.invalid',
    ],
    [
      'a scheme-less source with a path next to a sanitized http(s) token is reduced by itself',
      'portal.invalid/p',
    ],
  ])('%s', (_label, ancestor) => {
    const seen: string[] = [];
    const value = stored(`script-src https://cdn.example.test/a.js?x=1; frame-ancestors ${ancestor}`, (u) => {
      seen.push(u);
      return u.replace('a.js', 'b.js');
    });
    expect(seen).toEqual(['https://cdn.example.test/a.js']);
    expect(value).toBe('script-src https://cdn.example.test/b.js; frame-ancestors portal.invalid');
  });

  const UUID = '3f2b9c1e-7d4a-4e8f-9b6c-0a1d2e3f4a5b';

  it.each([
    [
      'a path-relative report-uri with a query',
      `default-src 'self'; report-uri /csp-report?source%5Buuid%5D=${UUID}&visitor=zq7alice`,
      "default-src 'self'; report-uri https://www.example.test/csp-report?source%5Buuid%5D=[redacted]&visitor=[redacted]",
    ],
    [
      'a network-path report-uri',
      'report-uri //r.example.test/csp?visitor=zq7alice',
      'report-uri https://r.example.test/csp?visitor=[redacted]',
    ],
    [
      'an address in a relative path',
      'report-uri /r/zq7alice@mail.invalid',
      'report-uri https://www.example.test/r/[redacted]@mail.invalid',
    ],
    [
      'an address encoded twice in a relative path',
      'report-uri /r/zq7alice%2540mail.invalid',
      'report-uri https://www.example.test/r/[redacted]@mail.invalid',
    ],
    [
      'a dot segment that the parser resolves away',
      'report-uri /r/zq7alice%2540mail.invalid/../csp',
      'report-uri https://www.example.test/r/csp',
    ],
    [
      'an address encoded twice in a backslash path',
      'report-uri \\\\r.example.test\\r\\zq7alice%2540mail.invalid',
      'report-uri https://r.example.test/r/[redacted]@mail.invalid',
    ],
    [
      'an @ the sanitizer reads as no address (no dot)',
      "default-src 'self'; report-uri /u/zq7carol@intranet",
      "default-src 'self'; report-uri [redacted]",
    ],
    [
      'an encoded @ the sanitizer reads as no address',
      'report-uri /r/zq7alice%40intranet',
      'report-uri [redacted]',
    ],
    [
      'an @ without a dot after it in a network path',
      'report-uri //r.example.test/u/zq7alice@intranet',
      'report-uri [redacted]',
    ],
    ['an @ with nothing after it', 'report-uri /~zq7alice@', 'report-uri [redacted]'],
    ['a fragment of a relative URL', 'report-uri /csp#zq7alice', 'report-uri /csp'],
    [
      'a relative URL without a slash',
      'report-uri csp?u=zq7alice',
      'report-uri https://www.example.test/csp?u=[redacted]',
    ],
    [
      'an address encoded twice in a relative URL without a slash',
      'report-uri csp/zq7carol%2540mail.invalid',
      'report-uri https://www.example.test/csp/[redacted]@mail.invalid',
    ],
    [
      'an address encoded twice after a dot segment',
      'report-uri ../r/zq7alice%2540mail.invalid',
      'report-uri https://www.example.test/r/[redacted]@mail.invalid',
    ],
    [
      'an address encoded twice as the whole token',
      'report-uri zq7alice%2540mail.invalid',
      'report-uri https://www.example.test/[redacted]@mail.invalid',
    ],
    [
      'an address in the (at) form in a relative URL',
      'report-uri r/zq7alice(at)mail.invalid',
      'report-uri [redacted]@mail.invalid',
    ],
    [
      'a quoted local part with a blank',
      'report-uri "zq7 alice"@mail.invalid',
      'report-uri [redacted]@mail.invalid',
    ],
    [
      'a host source with a query and no path',
      'connect-src a.example.test?u=zq7alice',
      'connect-src a.example.test',
    ],
    [
      'a quote and an address glued to an http(s) URL',
      "default-src 'self'; report-uri https://r.example.test/csp\"zq7carol@mail.example",
      "default-src 'self'; report-uri https://r.example.test",
    ],
    [
      'an apostrophe before a query',
      "report-uri https://r.example.test/x'?visitor=zq7query",
      'report-uri https://r.example.test',
    ],
    [
      'an apostrophe before a path with a query',
      "report-uri https://r.example.test/x'/r?token=zq7secret",
      'report-uri https://r.example.test',
    ],
    [
      'an address in angle brackets glued to an http(s) URL',
      'report-uri https://r.example.test/x<zq7alice@mail.example>',
      'report-uri https://r.example.test',
    ],
    [
      'a comma in the query of a relative URL',
      'report-uri /r?u=a,zq7tail',
      'report-uri https://www.example.test/r?u=[redacted]',
    ],
    [
      'a comma in the query of an http(s) URL',
      'report-uri https://r.example.test/r?u=a,zq7tail',
      'report-uri https://r.example.test/r?u=[redacted]',
    ],
  ])('%s: the token is resolved or cut, no visitor data is stored', (_label, value, expected) => {
    const rec = storedHeaderRecord(CSP, value, BASE, sanitizeUrl);
    expect(rec.value).toBe(expected);
    expect(JSON.stringify(rec)).not.toMatch(new RegExp(`zq7|${UUID}`));
  });

  it.each([
    'report-uri /csp-report',
    'report-uri /csp-report?v=2',
    'report-uri //r.example.test/csp',
    "default-src 'self'; report-uri /a/b.php; report-to csp-endpoint",
    'report-uri csp/report',
    'report-uri ../csp-report',
    "script-src 'self' https://cdn.example.test/npm/@scope/pkg@1.2.3/",
    "report-uri /csp-report?v=2, frame-ancestors 'none'",
  ])('counterexample: a URL without visitor data stays as written: %s', (value) => {
    expect(stored(value)).toBe(value);
  });

  it('report-only records the raw frame-ancestors and sanitizes a relative report-uri', () => {
    const rec = storedHeaderRecord(
      'content-security-policy-report-only',
      "frame-ancestors 'self'; report-uri /csp?visitor=zq7alice",
      BASE,
      sanitizeUrl,
    );
    expect(rec).toEqual({
      name: 'content-security-policy-report-only',
      value: "frame-ancestors 'self'; report-uri https://www.example.test/csp?visitor=[redacted]",
      frameAncestors: { present: true, restricts: true, sources: ["'self'"] },
    });
  });

  it('counterexample: other headers are unchanged (allowlisted values, everything else redacted)', () => {
    const [pp, trace, xfo] = snapshotHeaderRecords(
      [
        { name: 'Permissions-Policy', value: 'camera=(self "https://a.example/"), geolocation=()' },
        { name: 'x-trace', value: 'alice@mail.invalid' },
        { name: 'x-frame-options', value: 'SAMEORIGIN' },
      ],
      BASE,
    );
    expect(pp?.value).toBe('camera=(self "https://a.example/"), geolocation=()');
    expect(trace?.value).toBe('[redacted]');
    expect(xfo?.value).toBe('SAMEORIGIN');
  });
});
