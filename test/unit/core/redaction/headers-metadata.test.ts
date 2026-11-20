import { describe, expect, it } from 'vitest';
import { splitSetCookieNames } from '../../../../src/collectors/browser/recording/features.ts';
import { snapshotHeaders } from '../../../../src/collectors/http/response-head.ts';
import {
  setCookieName,
  snapshotHeaderRecords,
  storedCookieName,
  storedHeaderRecord,
} from '../../../../src/core/redaction/headers.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';

const BASE = 'https://www.example.test/';
const NAME_REDACTED = '[redacted]';

describe('Set-Cookie: only the name of a named cookie, by one rule for the HTTP collector and the browser', () => {
  it.each([
    [
      'a pair without "=" is a nameless cookie: its text is the value',
      '8f3a2c9d1e7b4a6f0c5d2e8b; Path=/; HttpOnly',
      null,
    ],
    ['a pair without "=" and without attributes', 'zq7value', null],
    ['an empty name', '=zq7value; Path=/', null],
    ['an empty name after blanks', '  = zq7value', null],
    ['counterexample: a named cookie keeps its name', 'sid=x; Path=/', 'sid'],
    ['counterexample: blanks around the name', ' plain = zq7value ; HttpOnly', 'plain'],
    ['counterexample: "=" in the value', 'a=zq7b=c', 'a'],
    ['counterexample: an empty value', '__Host-id=; Secure; Path=/', '__Host-id'],
  ])('%s', (_label, line, name) => {
    const expected = name === null ? [] : [name];
    const http = snapshotHeaders({ 'Set-Cookie': [line] });
    expect(http.setCookieNames).toEqual(expected);
    expect(splitSetCookieNames([line])).toEqual(expected);
    expect(JSON.stringify(http)).not.toMatch(/zq7|8f3a2c9d/);
  });

  it('the names of several cookies of one response, in order', () => {
    const lines = ['8f3a2c9d1e7b4a6f0c5d2e8b; Path=/', 'sid=zq7a; Path=/', '_pref=zq7b'];
    expect(snapshotHeaders({ 'Set-Cookie': lines }).setCookieNames).toEqual(['sid', '_pref']);
    expect(splitSetCookieNames([lines.join('\n')])).toEqual(['sid', '_pref']);
  });
});

describe('product headers: only product and version are stored next to a redacted value', () => {
  type ProductVersion = [product: string, version: string];

  const record = (name: string, value: string) => storedHeaderRecord(name, value, BASE, sanitizeUrl);

  it.each<[string, string, ProductVersion[]]>([
    ['x-powered-by', 'PHP/7.2.34', [['PHP', '7.2.34']]],
    [
      'server',
      'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f',
      [
        ['Apache', '2.4.41'],
        ['OpenSSL', '1.1.1f'],
      ],
    ],
    ['server', 'nginx', []],
    ['server', 'nginx/1.18.0 (Ubuntu)', [['nginx', '1.18.0']]],
    ['server', 'Microsoft-IIS/10.0', [['Microsoft-IIS', '10.0']]],
    ['x-powered-by', 'PHP/8.1.2-1ubuntu2.14', [['PHP', '8.1.2-1ubuntu2.14']]],
    ['server', 'Jetty/9.4.43.v20210629', [['Jetty', '9.4.43.v20210629']]],
    ['server', 'OpenSSL/1.0.2k-fips', [['OpenSSL', '1.0.2k-fips']]],
    ['x-powered-by', 'PHP/5.6.40-0+deb8u12', [['PHP', '5.6.40-0+deb8u12']]],
    ['server', 'Oracle-Application-Server-10g/10.1.3', [['Oracle-Application-Server-10g', '10.1.3']]],
    [
      'server',
      'Werkzeug/2.0.1 Python/3.9.5',
      [
        ['Werkzeug', '2.0.1'],
        ['Python', '3.9.5'],
      ],
    ],
    // the header name implies the product, the value is the version alone
    ['x-aspnet-version', '4.0.30319', [['ASP.NET', '4.0.30319']]],
    ['x-aspnetmvc-version', '5.2', [['ASP.NET MVC', '5.2']]],
    ['X-AspNet-Version', ' 4.0.30319 ', [['ASP.NET', '4.0.30319']]],
    ['x-aspnet-version', 'unknown', []],
    // comments are dropped, also nested ones; an unclosed comment hides the rest of the value
    [
      'server',
      'Apache/2.4.41 (Ubuntu (focal)) PHP/7.4',
      [
        ['Apache', '2.4.41'],
        ['PHP', '7.4'],
      ],
    ],
    ['server', 'Apache/2.4.41 (Ubuntu PHP/7.4', [['Apache', '2.4.41']]],
    // a comment needs a blank before and after it: text glued to it belongs to no product token
    ['server', 'nginx/1.18.0(Ubuntu)', []],
    ['server', '(Ubuntu)PHP/7.4 OpenSSL/1.1.1f', [['OpenSSL', '1.1.1f']]],
    [
      'server',
      'Apache/2.4.41 (a \\) PHP/7.4) mod_ssl/2.4.41',
      [
        ['Apache', '2.4.41'],
        ['mod_ssl', '2.4.41'],
      ],
    ],
    ['x-generator', 'Drupal 10 (https://www.drupal.org)', []],
    ['x-redirect-by', 'WordPress', []],
    ['x-powered-by', 'ASP.NET', []],
    // at most four pairs; repeated pairs count once
    [
      'server',
      'a/1 b/2 c/3 d/4 e/5',
      [
        ['a', '1'],
        ['b', '2'],
        ['c', '3'],
        ['d', '4'],
      ],
    ],
    ['server', 'PHP/7.4 PHP/7.4', [['PHP', '7.4']]],
    // several fields of one header, joined by a comma or a line break
    ['x-powered-by', 'PHP/7.4, PleskLin', [['PHP', '7.4']]],
    ['x-powered-by', 'PleskLin\nPHP/7.4', [['PHP', '7.4']]],
    [
      'server',
      'Apache/2.4.41 (Ubuntu), PHP/7.4',
      [
        ['Apache', '2.4.41'],
        ['PHP', '7.4'],
      ],
    ],
    // a comma without a blank after it belongs to the token, as inside a URL path
    ['x-powered-by', 'PHP/7.4,PleskLin', []],
    ['x-powered-by', 'PHP/1.2.3-rc.1', [['PHP', '1.2.3-rc.1']]],
    ['server', 'App/1.0-20210629', [['App', '1.0-20210629']]],
  ])('%s: %j', (name, value, expected) => {
    const rec = record(name, value);
    expect(rec.name).toBe(name.toLowerCase());
    expect(rec.value).toBe('[redacted]');
    expect(rec.productVersions).toEqual(expected.map(([product, version]) => ({ product, version })));
  });

  it('the comment of the operating system appears nowhere in the record', () => {
    const rec = record('server', 'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f');
    expect(JSON.stringify(rec)).not.toContain('Ubuntu');
  });

  it.each<[string, string, ProductVersion[]]>([
    ['an appended e-mail address', 'PHP/7.2.34 zq7admin@example.test', [['PHP', '7.2.34']]],
    ['an e-mail address as product', 'zq7admin@example.test/1.0', []],
    ['an internal hostname', 'zq7web01.internal.example.test', []],
    ['an internal hostname as product', 'zq7web01.internal.example.test/1.0', []],
    ['a hostname as version', 'node/1.zq7internal.example', []],
    ['a hostname in a comment', 'Apache/2.4.41 (zq7web01.internal.example.test)', [['Apache', '2.4.41']]],
    ['a private address', '10.0.0.1', []],
    ['an address as version', 'proxy/10.0.0.1', []],
    ['an IPv6 address', 'proxy/2001:db8::1', []],
    ['an IPv6 literal as product', '[2001:db8::1]/1.0', []],
    ['a URL with a token', 'https://zq7portal.example.test/x?token=zq7secret', []],
    ['a token after the version', 'PHP/7.2.34?token=zq7secret', []],
    ['a parameter after the version', 'PHP/7.2.34;user=zq7alice', []],
    ['a long number as version', 'build/4930123456789', []],
    ['a hash as version', 'build/8d7f6e5c4b3a29f1', []],
    ['a version over 30 characters', `PHP/7.${'1'.repeat(29)}`, []],
    ['a product over 40 characters', `${'a'.repeat(41)}/1.0`, []],
    ['a product that starts with a digit', '7zip/1.0', []],
    ['a version that does not start with a digit', 'PHP/v7.2', []],
    [
      'a path segment after parentheses in a URL',
      'https://portal.example.test/(route)zq7session/12345678',
      [],
    ],
    ['a hostname label after an address', 'proxy/10.0.0.zq7web01', []],
    ['a hostname label after a version', 'proxy/2.4.zq7web01', []],
    ['a hash as product', 'zq7e4f0d2b916a54c78a6b3cd0123456789/1.0', []],
    ['a hash with separators as product', 'zq7-e4f0d2b9-16a54c78-a6b3cd01/1.0', []],
    ['a hash as version suffix', 'PHP/1-zq7e4f0d2b916a54c78', []],
    [
      'a path segment after parentheses and a comma in a URL',
      'https://h.example.test/(r),zq7session/123',
      [],
    ],
    ['a quoted local part of an e-mail address', '"alice zq7session/123 bob"@example.test', []],
    ['an unclosed quote', 'PHP/7.4 "zq7alice zq7session/123', [['PHP', '7.4']]],
    ['a host label of one letter and digits', 'proxy/10.0.0.w3b01', []],
    ['a UUID as product', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/1.0', []],
    ['a short hash as product', 'deadbeef/1.0', []],
    ['a split hash as version suffix', 'PHP/8.1.2-a1b2c3d4-e5f6a7b8', []],
    ['a short hash as version suffix', 'PHP/8.1.2-deadbeef', []],
    ['an IPv4 address in octal notation', 'proxy/0177.0.0.1', []],
  ])('%s: nothing beyond product and version is stored', (_label, value, expected) => {
    const rec = record('x-powered-by', value);
    expect(rec.value).toBe('[redacted]');
    expect(rec.productVersions).toEqual(expected.map(([product, version]) => ({ product, version })));
    expect(JSON.stringify(rec)).not.toContain('zq7');
  });

  it('a 10 KB value stores the pairs it starts with and nothing else', () => {
    const rec = record('server', `Apache/2.4.41 (Ubuntu) ${'x'.repeat(10_000)} PHP/7.4`);
    expect(rec.productVersions).toEqual([
      { product: 'Apache', version: '2.4.41' },
      { product: 'PHP', version: '7.4' },
    ]);
    expect(JSON.stringify(rec).length).toBeLessThan(200);
  });

  it('counterexample: version-like text in another header is not read', () => {
    for (const name of ['x-request-id', 'via']) {
      expect(record(name, 'PHP/7.2.34')).toEqual({ name, value: '[redacted]' });
    }
  });

  it('counterexample: headers whose value is kept carry no product facts', () => {
    expect(record('content-type', 'text/html')).toEqual({ name: 'content-type', value: 'text/html' });
  });

  it('the browser path (another URL sanitizer) stores the same facts', () => {
    const [rec] = snapshotHeaderRecords([{ name: 'X-Powered-By', value: 'PHP/7.2.34' }], BASE, (u) => u);
    expect(rec).toEqual({
      name: 'x-powered-by',
      value: '[redacted]',
      productVersions: [{ product: 'PHP', version: '7.2.34' }],
    });
  });
});

describe('a kept header stores only what its grammar allows', () => {
  it.each(['alice@example.test=x', 'alice%252540example.test=x'])(
    'a cookie name with an address is redacted and still counted: %s',
    (line) => {
      expect(setCookieName(line)).toBe(line.slice(0, line.indexOf('=')));
      expect(snapshotHeaders({ 'Set-Cookie': [line] }).setCookieNames).toEqual(['[redacted]']);
      expect(splitSetCookieNames([line])).toEqual(['[redacted]']);
    },
  );
});

describe('values a real site sends are stored as sent', () => {
  it.each([
    'SESSabcdef0123456789abcdef0123456789',
    'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
    'TS01a2b3c4d5',
  ])('a cookie name with a site ID is kept: %s', (name) => {
    expect(setCookieName(`${name}=x`)).toBe(name);
  });
});

describe('stored by grammar: addresses hidden in a directive, opaque URLs, parameters and header names', () => {
  it('a header name with an ID-like run is not stored, the value of such a header is not either', () => {
    const [rec] = snapshotHeaderRecords(
      [{ name: 'X-Visitor-123e4567-e89b-12d3-a456-426614174000', value: '1' }],
      BASE,
    );
    expect(rec).toEqual({ name: NAME_REDACTED, value: NAME_REDACTED });
    expect(
      snapshotHeaders({ 'X-Visitor-123e4567-e89b-12d3-a456-426614174000': '' }, BASE).blankHeaderNames,
    ).toEqual([NAME_REDACTED]);
  });

  it('counterexample: ordinary header names are stored as sent', () => {
    const names = ['x-request-id', 'cf-cache-status', 'x-amz-cf-pop', 'strict-transport-security'];
    const out = snapshotHeaderRecords(
      names.map((name) => ({ name, value: 'x' })),
      BASE,
    );
    expect(out.map((r) => r.name)).toEqual(names);
  });

  it.each([
    'alice@\u200bexample.test',
    'alice@\u2060example.test',
    'alice@\u00adexample.test',
    'alice@[192.168.0.1]',
    'alice@1intranet',
    'alice@_intranet',
    'alice[at]1x',
    'alice(a\u200bt)1x',
    'alice(\u200bat)1x',
    'alice[a\u00adt]1x',
    'alice(at\u2060)_x',
  ])('a cookie name with a literal @ or (at) behind a non-letter is [redacted]: %j', (name) => {
    expect(storedCookieName(name)).toBe('[redacted]');
  });

  it('a cookie name with a full-width @ is not stored', () => {
    expect(storedCookieName('alice＠example.test')).toBe(NAME_REDACTED);
  });
});

describe('stored by grammar: ids in allowed query values, address markers in names, closed feature lists', () => {
  it.each([
    ['a local part without a domain', 'alice@intranet'],
    ['a local part with a dot-less host and a suffix', 'sid@host2'],
    ['an obfuscated local part', 'alice(at)intranet'],
  ])('a cookie name with %s is stored as [redacted] and still counted', (_label, name) => {
    expect(snapshotHeaders({ 'set-cookie': [`${name}=x`, 'plain=1'] }, BASE).setCookieNames).toEqual([
      NAME_REDACTED,
      'plain',
    ]);
    expect(splitSetCookieNames([`${name}=x`])).toEqual([NAME_REDACTED]);
  });

  it.each([
    ['an encoded address', 'x-alice%40mail.test'],
    ['an address encoded twice', 'x-alice%2540mail.test'],
    ['a full-width at sign', 'x-alice＠mail.test'],
    ['a local part without a domain', 'x-alice@intranet'],
  ])('a header name with %s is stored as [redacted], with its value and when it is blank', (_label, name) => {
    const [rec] = snapshotHeaderRecords([{ name, value: '1' }], BASE);
    expect(rec).toEqual({ name: NAME_REDACTED, value: NAME_REDACTED });
    expect(snapshotHeaders({ [name]: '' }, BASE).blankHeaderNames).toEqual([NAME_REDACTED]);
  });
});
