/**
 * The header normalizer: a CSP over the stored limit is cut, so facts the checks need (`frame-ancestors`) are derived
 * from the complete value before the cut and stored next to it.
 */
import { describe, expect, it } from 'vitest';
import {
  cspFrameAncestors,
  MAX_HEADER_VALUE,
  snapshotHeaderRecords,
  storedHeaderRecord,
} from '../../../../src/core/redaction/headers.ts';

import { sanitizeUrl } from '../../../../src/core/url/url.ts';

const BASE = 'https://www.example.test/';
/** A CSP over the limit: a long `script-src` list, then `tail`. */
const longCsp = (tail: string) =>
  `default-src 'self'; script-src ${Array.from({ length: 120 }, (_, i) => `https://cdn${i}.example.test`).join(' ')}; ${tail}`;

describe('cspFrameAncestors', () => {
  it.each([
    ["default-src 'self'", { present: false, restricts: false, sources: [] }],
    ["frame-ancestors 'self'", { present: true, restricts: true, sources: ["'self'"] }],
    ["frame-ancestors 'none'", { present: true, restricts: true, sources: ["'none'"] }],
    ['frame-ancestors *', { present: true, restricts: false, sources: ['*'] }],
    [
      'frame-ancestors * https://a.example',
      { present: true, restricts: false, sources: ['*', 'https://a.example'] },
    ],
    ['frame-ancestors https:', { present: true, restricts: false, sources: ['https:'] }],
    // several policies in one value: one restricting policy is enough
    ["frame-ancestors *, frame-ancestors 'self'", { present: true, restricts: true, sources: ["'self'"] }],
    // the directive name is case-insensitive; a directive name inside a source list is no directive
    ["Frame-Ancestors 'self'", { present: true, restricts: true, sources: ["'self'"] }],
    ["default-src 'self'; report-uri /frame-ancestors", { present: false, restricts: false, sources: [] }],
  ])('%j', (value, expected) => {
    expect(cspFrameAncestors(value)).toEqual(expected);
  });

  it('caps the stored sources', () => {
    const many = Array.from({ length: 50 }, (_, i) => `https://a${i}.example.test`).join(' ');
    const fact = cspFrameAncestors(`frame-ancestors ${many}`);
    expect(fact.sources.length).toBeLessThanOrEqual(20);
    expect(fact.restricts).toBe(true);
  });
});

describe('snapshotHeaderRecords: values over the limit', () => {
  it('a long CSP with frame-ancestors at the end: truncated, the fact comes from the full value', () => {
    const value = longCsp("frame-ancestors 'self'");
    expect(value.length).toBeGreaterThan(MAX_HEADER_VALUE);
    const [rec] = snapshotHeaderRecords([{ name: 'Content-Security-Policy', value }], BASE);
    expect(rec?.value).toHaveLength(MAX_HEADER_VALUE);
    expect(rec?.value).not.toContain('frame-ancestors');
    expect(rec).toMatchObject({
      name: 'content-security-policy',
      truncated: true,
      frameAncestors: { present: true, restricts: true, sources: ["'self'"] },
    });
  });

  it('a long CSP without frame-ancestors: truncated, the fact says the directive is absent', () => {
    const [rec] = snapshotHeaderRecords(
      [{ name: 'content-security-policy', value: longCsp("img-src 'self'") }],
      BASE,
    );
    expect(rec).toMatchObject({ truncated: true, frameAncestors: { present: false, restricts: false } });
  });

  it('the report-only policy gets the same facts (the check decides what counts)', () => {
    const [rec] = snapshotHeaderRecords(
      [{ name: 'content-security-policy-report-only', value: longCsp("frame-ancestors 'none'") }],
      BASE,
    );
    expect(rec).toMatchObject({ truncated: true, frameAncestors: { present: true, restricts: true } });
  });

  it('a short CSP stays as it was: no flag, no fact when the directive is absent', () => {
    const [rec] = snapshotHeaderRecords(
      [{ name: 'content-security-policy', value: "default-src 'self'" }],
      BASE,
    );
    expect(rec).toEqual({ name: 'content-security-policy', value: "default-src 'self'" });
  });

  it('a short CSP with the directive carries the fact too', () => {
    const [rec] = snapshotHeaderRecords(
      [{ name: 'content-security-policy', value: "frame-ancestors 'self'" }],
      BASE,
    );
    expect(rec).toMatchObject({ frameAncestors: { present: true, restricts: true } });
    expect(rec?.truncated).toBeUndefined();
  });

  describe('the boundary of the limit', () => {
    /** A CSP of exactly `length` characters without URLs (the sanitizer does not change its length). */
    const cspOf = (length: number, tail = '') => {
      const head = "default-src 'self'; x-pad ";
      return head + 'a'.repeat(length - head.length - tail.length) + tail;
    };
    const record = (value: string) => storedHeaderRecord('content-security-policy', value, BASE, (u) => u);

    it('a complete CSP of exactly the limit without the directive: no cut, the fact says it is absent', () => {
      const value = cspOf(MAX_HEADER_VALUE);
      expect(value).toHaveLength(MAX_HEADER_VALUE);
      const rec = record(value);
      expect(rec.value).toBe(value);
      expect(rec.truncated).toBeUndefined();
      expect(rec.frameAncestors).toEqual({ present: false, restricts: false, sources: [] });
    });

    it('counterexample: one character under the limit stays without a fact', () => {
      const value = cspOf(MAX_HEADER_VALUE - 1);
      expect(record(value)).toEqual({ name: 'content-security-policy', value });
    });

    it('counterexample: one character over the limit is cut and carries the fact', () => {
      const rec = record(cspOf(MAX_HEADER_VALUE + 1));
      expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
      expect(rec).toMatchObject({ truncated: true, frameAncestors: { present: false, restricts: false } });
    });

    it("counterexample: exactly the limit with the directive keeps the value and the fact, no 'truncated'", () => {
      const rec = record(cspOf(MAX_HEADER_VALUE, "; frame-ancestors 'self'"));
      expect(rec.truncated).toBeUndefined();
      expect(rec.value).toContain("frame-ancestors 'self'");
      expect(rec.frameAncestors).toMatchObject({ present: true, restricts: true });
    });

    it('the report-only policy at the limit gets the fact too', () => {
      const rec = storedHeaderRecord(
        'content-security-policy-report-only',
        cspOf(MAX_HEADER_VALUE),
        BASE,
        (u) => u,
      );
      expect(rec.frameAncestors).toMatchObject({ present: false });
    });
  });

  it('another long value is cut and flagged, without facts', () => {
    const rec = storedHeaderRecord('permissions-policy', `camera=(${'a'.repeat(3000)})`, BASE, (u) => u);
    expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
    expect(rec.truncated).toBe(true);
    expect(rec.frameAncestors).toBeUndefined();
  });

  it('keeps no value of a non-allowlisted header, whatever its length', () => {
    const [rec] = snapshotHeaderRecords([{ name: 'x-trace', value: 'x'.repeat(5000) }], BASE);
    expect(rec).toEqual({ name: 'x-trace', value: '[redacted]' });
  });
});

const SECRET = 'alice';
const CSP = 'content-security-policy';

/** A CSP whose `frame-ancestors` sits behind more than the stored limit, so the value itself never shows it. */
const behindLimit = (directive: string) =>
  `default-src 'self'; x-pad ${'x'.repeat(MAX_HEADER_VALUE + 252)}; ${directive}`;

const noSanitizer = () => {
  throw new Error('the URL sanitizer must not be needed for the fact');
};

describe('sources of the frameAncestors fact', () => {
  it('a scheme-less source with an encoded e-mail in its path, behind the limit', () => {
    const raw = behindLimit('frame-ancestors portal.invalid/users/alice%40mail.invalid');
    const rec = storedHeaderRecord(CSP, raw, BASE, (u) => u);
    expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
    expect(rec.truncated).toBe(true);
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: ['portal.invalid'] });
    expect(JSON.stringify(rec)).not.toContain(SECRET);
  });

  it('the same source in a short CSP: neither the fact nor the stored value keeps the address', () => {
    const rec = storedHeaderRecord(
      CSP,
      'frame-ancestors portal.invalid/users/alice%40mail.invalid',
      BASE,
      sanitizeUrl,
    );
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: ['portal.invalid'] });
    expect(JSON.stringify(rec)).not.toContain(SECRET);
    expect(rec.value).toBe('frame-ancestors portal.invalid');
  });

  it.each([
    ['userinfo with a scheme', 'https://alice:secret@portal.invalid/p', 'https://portal.invalid'],
    ['userinfo without a scheme', 'alice:secret@portal.invalid:8443/p', 'portal.invalid:8443'],
    ['a bare e-mail address (the domain stays)', 'alice@mail.invalid', 'mail.invalid'],
    ['an e-mail with special characters in the local part', "a+b'c#d@mail.invalid", 'mail.invalid'],
    [
      'a plain e-mail in the path of a source with a scheme',
      'https://portal.invalid/u/alice@mail.invalid',
      'https://portal.invalid',
    ],
    ['query and fragment', 'https://portal.invalid/p?user=alice&x=1#alice', 'https://portal.invalid'],
    ['an encoded e-mail in the host position', 'alice%40mail.invalid', '[redacted]'],
    ['an encoded e-mail with a scheme and no host', 'https://alice%40mail.invalid', '[redacted]'],
    ['a quoted token that is no keyword', "'nonce-alice@mail.invalid'", '[redacted]'],
    ['an encoded slash makes the token no host', 'portal.invalid%2Fusers', '[redacted]'],
  ])('%s', (_label, source, expected) => {
    const fact = cspFrameAncestors(`frame-ancestors ${source}`);
    expect(fact.present).toBe(true);
    expect(fact.sources[0]).toBe(expected);
    expect(JSON.stringify(fact)).not.toContain(SECRET);
  });

  it('counterexample: ordinary sources keep scheme, host, port and their spelling', () => {
    const fact = cspFrameAncestors(
      "frame-ancestors 'self' https://A.Example *.b.example:8443 c.example [::1]:3000 http://d.example:* https: data:",
    );
    expect(fact).toEqual({
      present: true,
      restricts: false, // `https:` matches every https origin
      sources: [
        "'self'",
        'https://A.Example',
        '*.b.example:8443',
        'c.example',
        '[::1]:3000',
        'http://d.example:*',
        'https:',
        'data:',
      ],
    });
  });

  it("counterexample: 'none' and 'self' stay readable", () => {
    expect(cspFrameAncestors("frame-ancestors 'none'").sources).toEqual(["'none'"]);
    expect(cspFrameAncestors("FRAME-ANCESTORS 'SELF'").sources).toEqual(["'SELF'"]);
  });

  it('counterexample: unrelated directives keep their paths out of the fact (nothing is read from them)', () => {
    const fact = cspFrameAncestors(
      "script-src cdn.example.test/alice%40mail.invalid; frame-ancestors 'self'; report-uri /r/alice%40mail.invalid",
    );
    expect(fact).toEqual({ present: true, restricts: true, sources: ["'self'"] });
  });

  it('is idempotent: the stored sources, read again as a policy, give the same sources', () => {
    const first = cspFrameAncestors(
      "frame-ancestors 'self' https://u:p@a.example/x alice@mail.invalid alice%40mail.invalid [::1]:3000 *.b.example:*",
    );
    const again = cspFrameAncestors(`frame-ancestors ${first.sources.join(' ')}`);
    expect(again).toEqual(first);
  });

  it('keeps the cap of 20 sources and 200 characters', () => {
    const many = Array.from({ length: 50 }, (_, i) => `a${i}.example.test`).join(' ');
    const fact = cspFrameAncestors(`frame-ancestors ${many}`);
    expect(fact.sources).toHaveLength(20);

    const long = cspFrameAncestors(`frame-ancestors https://${'a'.repeat(300)}.example.test`);
    expect(long.sources[0]?.length).toBeLessThanOrEqual(200);
  });

  it('a bare scheme token is cut at 200 characters as every other source is', () => {
    const fact = cspFrameAncestors(`frame-ancestors ${'a'.repeat(5000)}: https://b.example.test`);

    expect(fact.sources[0]?.length).toBeLessThanOrEqual(200);
    expect(fact.sources[1]).toBe('https://b.example.test');

    // twenty such tokens are no 100 KB fact
    const many = cspFrameAncestors(`frame-ancestors ${`${'a'.repeat(5000)}:  `.repeat(30)}`);
    expect(many.sources).toHaveLength(20);
    expect(JSON.stringify(many).length).toBeLessThan(20 * 220);

    // applied to its own output it changes nothing
    expect(cspFrameAncestors(`frame-ancestors ${fact.sources.join(' ')}`).sources).toEqual(fact.sources);

    // counterexample: a real scheme source and `*` stay as they are
    expect(cspFrameAncestors('frame-ancestors https: * data:').sources).toEqual(['https:', '*', 'data:']);
  });
});

describe('present and restricts come from the policy as sent', () => {
  it('the verdict does not depend on what the URL sanitizer returns', () => {
    // A sanitizer that adds a wildcard source to every URL it touches: `restricts` must not follow it.
    const hostile = () => 'https://a.example/ *';
    const rec = storedHeaderRecord(CSP, 'frame-ancestors https://a.example/p', BASE, hostile);
    expect(rec.frameAncestors).toMatchObject({ present: true, restricts: true });
    const open = storedHeaderRecord(
      CSP,
      'frame-ancestors * https://a.example/p',
      BASE,
      () => 'https://a.example/',
    );
    expect(open.frameAncestors).toMatchObject({ present: true, restricts: false });
  });

  it('the fact needs no sanitizer call for a scheme-less source (fail-fast sanitizer)', () => {
    const rec = storedHeaderRecord(
      CSP,
      behindLimit('frame-ancestors portal.invalid/users/alice%40mail.invalid'),
      BASE,
      noSanitizer,
    );
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: ['portal.invalid'] });
  });

  it('a wildcard next to an address still means open framing, and the address is not stored', () => {
    const fact = cspFrameAncestors('frame-ancestors * alice@mail.invalid');
    expect(fact).toEqual({ present: true, restricts: false, sources: ['*', 'mail.invalid'] });
  });

  it('the report-only policy is treated alike', () => {
    const rec = storedHeaderRecord(
      'content-security-policy-report-only',
      behindLimit('frame-ancestors alice@mail.invalid/x'),
      BASE,
      (u) => u,
    );
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: ['mail.invalid'] });
  });
});

describe('the stored CSP value', () => {
  const stored = (value: string, sanitize = sanitizeUrl) =>
    storedHeaderRecord(CSP, value, BASE, sanitize).value;

  it.each([
    ['frame-ancestors portal.invalid/users/alice%40mail.invalid', 'frame-ancestors portal.invalid'],
    ["script-src 'self' cdn.example.test/js/alice@mail.invalid", "script-src 'self' cdn.example.test"],
    ['frame-ancestors alice@mail.invalid', 'frame-ancestors mail.invalid'],
    ['frame-ancestors alice%40mail.invalid', 'frame-ancestors [redacted]'],
    ['connect-src a.example.test:8443/x?user=alice', 'connect-src a.example.test:8443'],
  ])('%s', (value, expected) => {
    expect(stored(value)).toBe(expected);
  });

  it.each([
    ['connect-src wss://api.invalid/users/alice%40mail.invalid', 'connect-src wss://api.invalid'],
    ['connect-src ftp://alice:pw@api.invalid/x', 'connect-src ftp://api.invalid'],
    ['connect-src ws://alice@mail.invalid:8080', 'connect-src ws://mail.invalid:8080'],
    ['connect-src wss://api.invalid/stream?user=alice', 'connect-src wss://api.invalid'],
    [
      "connect-src 'self' wss://api.invalid/a https://x.test/ b.test/p",
      "connect-src 'self' wss://api.invalid https://x.test/ b.test",
    ],
  ])('a source with a scheme other than http(s) is reduced to scheme and host: %s', (value, expected) => {
    expect(stored(value, (u) => u)).toBe(expected);
  });

  it('counterexample: sources with a scheme but nothing personal are kept as sent', () => {
    const value =
      "connect-src wss://api.example.test wss://api.example.test:8443 ws://localhost:35729 blob: data: 'self'";
    expect(stored(value, (u) => u)).toBe(value);
  });

  it('counterexample: a policy without personal data is stored exactly as sent', () => {
    const value =
      "default-src 'self'; script-src 'self' cdn.example.test *.example.test:8443 data: 'nonce-Zm9v+/=='; " +
      "frame-ancestors 'self' https://a.example/; report-uri /csp-report; sandbox allow-forms; " +
      'plugin-types application/pdf; img-src [::1]:3000 blob:';
    expect(stored(value, (u) => u)).toBe(value);
  });

  it('counterexample: http(s) sources still go through the URL sanitizer of the collector', () => {
    const seen: string[] = [];
    const rec = storedHeaderRecord(
      CSP,
      'script-src https://cdn.example.test/a.js?x=1; frame-ancestors portal.invalid',
      BASE,
      (u) => {
        seen.push(u);
        return u.replace('x=1', 'x=[redacted]');
      },
    );
    expect(seen).toEqual(['https://cdn.example.test/a.js?x=1']);
    expect(rec.value).toBe(
      'script-src https://cdn.example.test/a.js?x=[redacted]; frame-ancestors portal.invalid',
    );
  });

  it('a scheme-less source with a path next to a sanitized http(s) token is reduced by itself', () => {
    const seen: string[] = [];
    const rec = storedHeaderRecord(
      CSP,
      'script-src https://cdn.example.test/a.js?x=1; frame-ancestors portal.invalid/p',
      BASE,
      (u) => {
        seen.push(u);
        return u.replace('x=1', 'x=[redacted]');
      },
    );
    expect(seen).toEqual(['https://cdn.example.test/a.js?x=1']);
    expect(rec.value).toBe(
      'script-src https://cdn.example.test/a.js?x=[redacted]; frame-ancestors portal.invalid',
    );
  });

  it('counterexample: other headers are unchanged (allowlisted values, everything else redacted)', () => {
    const [pp, trace, xfo] = snapshotHeaderRecords(
      [
        { name: 'Permissions-Policy', value: 'camera=(self "https://a.example/x"), geolocation=()' },
        { name: 'x-trace', value: 'alice@mail.invalid' },
        { name: 'x-frame-options', value: 'SAMEORIGIN' },
      ],
      BASE,
    );
    expect(pp?.value).toBe('camera=(self "https://a.example/x"), geolocation=()');
    expect(trace?.value).toBe('[redacted]');
    expect(xfo?.value).toBe('SAMEORIGIN');
  });
});

describe('product headers: only product and version are stored next to a redacted value', () => {
  const record = (name: string, value: string) => storedHeaderRecord(name, value, BASE, sanitizeUrl);

  it.each([
    ['x-powered-by', 'PHP/7.2.34', [{ product: 'PHP', version: '7.2.34' }]],
    [
      'server',
      'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f',
      [
        { product: 'Apache', version: '2.4.41' },
        { product: 'OpenSSL', version: '1.1.1f' },
      ],
    ],
    ['server', 'nginx', []],
    ['server', 'nginx/1.18.0 (Ubuntu)', [{ product: 'nginx', version: '1.18.0' }]],
    ['server', 'Microsoft-IIS/10.0', [{ product: 'Microsoft-IIS', version: '10.0' }]],
    ['x-powered-by', 'PHP/8.1.2-1ubuntu2.14', [{ product: 'PHP', version: '8.1.2-1ubuntu2.14' }]],
    ['server', 'Jetty/9.4.43.v20210629', [{ product: 'Jetty', version: '9.4.43.v20210629' }]],
    ['server', 'OpenSSL/1.0.2k-fips', [{ product: 'OpenSSL', version: '1.0.2k-fips' }]],
    ['x-powered-by', 'PHP/5.6.40-0+deb8u12', [{ product: 'PHP', version: '5.6.40-0+deb8u12' }]],
    [
      'server',
      'Oracle-Application-Server-10g/10.1.3',
      [{ product: 'Oracle-Application-Server-10g', version: '10.1.3' }],
    ],
    [
      'server',
      'Werkzeug/2.0.1 Python/3.9.5',
      [
        { product: 'Werkzeug', version: '2.0.1' },
        { product: 'Python', version: '3.9.5' },
      ],
    ],
    // the header name implies the product, the value is the version alone
    ['x-aspnet-version', '4.0.30319', [{ product: 'ASP.NET', version: '4.0.30319' }]],
    ['x-aspnetmvc-version', '5.2', [{ product: 'ASP.NET MVC', version: '5.2' }]],
    ['X-AspNet-Version', ' 4.0.30319 ', [{ product: 'ASP.NET', version: '4.0.30319' }]],
    ['x-aspnet-version', 'unknown', []],
    // comments are dropped, also nested ones; an unclosed comment hides the rest of the value
    [
      'server',
      'Apache/2.4.41 (Ubuntu (focal)) PHP/7.4',
      [
        { product: 'Apache', version: '2.4.41' },
        { product: 'PHP', version: '7.4' },
      ],
    ],
    ['server', 'Apache/2.4.41 (Ubuntu PHP/7.4', [{ product: 'Apache', version: '2.4.41' }]],
    // a comment needs a blank before and after it: text glued to it belongs to no product token
    ['server', 'nginx/1.18.0(Ubuntu)', []],
    ['server', '(Ubuntu)PHP/7.4 OpenSSL/1.1.1f', [{ product: 'OpenSSL', version: '1.1.1f' }]],
    [
      'server',
      'Apache/2.4.41 (a \\) PHP/7.4) mod_ssl/2.4.41',
      [
        { product: 'Apache', version: '2.4.41' },
        { product: 'mod_ssl', version: '2.4.41' },
      ],
    ],
    // product tokens without a version name no version
    ['x-generator', 'Drupal 10 (https://www.drupal.org)', []],
    ['x-redirect-by', 'WordPress', []],
    ['x-powered-by', 'ASP.NET', []],
    // at most four pairs; repeated pairs count once
    [
      'server',
      'a/1 b/2 c/3 d/4 e/5',
      [
        { product: 'a', version: '1' },
        { product: 'b', version: '2' },
        { product: 'c', version: '3' },
        { product: 'd', version: '4' },
      ],
    ],
    ['server', 'PHP/7.4 PHP/7.4', [{ product: 'PHP', version: '7.4' }]],
    // several fields of one header, joined by a comma or a line break
    ['x-powered-by', 'PHP/7.4, PleskLin', [{ product: 'PHP', version: '7.4' }]],
    ['x-powered-by', 'PleskLin\nPHP/7.4', [{ product: 'PHP', version: '7.4' }]],
    [
      'server',
      'Apache/2.4.41 (Ubuntu), PHP/7.4',
      [
        { product: 'Apache', version: '2.4.41' },
        { product: 'PHP', version: '7.4' },
      ],
    ],
    // a comma without a blank after it belongs to the token, as inside a URL path
    ['x-powered-by', 'PHP/7.4,PleskLin', []],
    // version suffixes and dotted labels that versions use
    ['x-powered-by', 'PHP/1.2.3-rc.1', [{ product: 'PHP', version: '1.2.3-rc.1' }]],
    ['server', 'App/1.0-20210629', [{ product: 'App', version: '1.0-20210629' }]],
  ])('%s: %j', (name, value, expected) => {
    const rec = record(name, value);
    expect(rec.name).toBe(name.toLowerCase());
    expect(rec.value).toBe('[redacted]');
    expect(rec.productVersions).toEqual(expected);
  });

  it('the comment of the operating system appears nowhere in the record', () => {
    const rec = record('server', 'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f');
    expect(JSON.stringify(rec)).not.toContain('Ubuntu');
  });

  it.each([
    [
      'an appended e-mail address',
      'PHP/7.2.34 zq7admin@example.test',
      [{ product: 'PHP', version: '7.2.34' }],
    ],
    ['an e-mail address as product', 'zq7admin@example.test/1.0', []],
    ['an internal hostname', 'zq7web01.internal.example.test', []],
    ['an internal hostname as product', 'zq7web01.internal.example.test/1.0', []],
    ['a hostname as version', 'node/1.zq7internal.example', []],
    [
      'a hostname in a comment',
      'Apache/2.4.41 (zq7web01.internal.example.test)',
      [{ product: 'Apache', version: '2.4.41' }],
    ],
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
    ['an unclosed quote', 'PHP/7.4 "zq7alice zq7session/123', [{ product: 'PHP', version: '7.4' }]],
    ['a host label of one letter and digits', 'proxy/10.0.0.w3b01', []],
    ['a UUID as product', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/1.0', []],
    ['a short hash as product', 'deadbeef/1.0', []],
    ['a split hash as version suffix', 'PHP/8.1.2-a1b2c3d4-e5f6a7b8', []],
    ['a short hash as version suffix', 'PHP/8.1.2-deadbeef', []],
    ['an IPv4 address in octal notation', 'proxy/0177.0.0.1', []],
  ])('%s: nothing beyond product and version is stored', (_label, value, expected) => {
    const rec = record('x-powered-by', value);
    expect(rec.value).toBe('[redacted]');
    expect(rec.productVersions).toEqual(expected);
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
    for (const name of ['x-request-id', 'via', 'x-served-by', 'x-trace']) {
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
