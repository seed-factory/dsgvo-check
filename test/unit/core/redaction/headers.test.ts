/**
 * The header normalizer: a CSP over the stored limit is cut, so facts the checks need (`frame-ancestors`) are derived
 * from the complete value before the cut and stored next to it. Kept values hold no visitor data (URLs with a query,
 * addresses, `mailto:`), and of `Set-Cookie` only the name of a named cookie is kept.
 */
import { describe, expect, it } from 'vitest';
import { hdr01 } from '../../../../src/checks/http/hdr-01.ts';
import { hstsOf } from '../../../../src/checks/http/shared.ts';
import { splitSetCookieNames } from '../../../../src/collectors/browser/recording/features.ts';
import { snapshotHeaders } from '../../../../src/collectors/http/response-head.ts';
import {
  cspFrameAncestors,
  MAX_HEADER_VALUE,
  setCookieName,
  snapshotHeaderRecords,
  storedCookieName,
  storedHeaderRecord,
} from '../../../../src/core/redaction/headers.ts';

import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import {
  makeDocumentResponse,
  makeHttp,
  makeSnapshot,
  observationsOf,
  runCheck,
} from '../../../utils/snapshot-builder.ts';

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
      const head = "default-src 'self'; img-src ";
      return head + stars(length - head.length - tail.length) + tail;
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

const SECRET = 'alice';
const CSP = 'content-security-policy';

/** `length` characters of `*` sources: the grammar keeps them as sent, a double blank makes up an even length. */
const stars = (length: number) => `${'* '.repeat(Math.ceil(length / 2) - 1)}${length % 2 === 0 ? ' *' : '*'}`;

/** A CSP whose `frame-ancestors` sits behind more than the stored limit, so the value itself never shows it. */
const behindLimit = (directive: string) =>
  `default-src 'self'; img-src ${stars(MAX_HEADER_VALUE + 252)}; ${directive}`;

const noSanitizer = () => {
  throw new Error('the URL sanitizer must not be needed for the fact');
};

describe('sources of the frameAncestors fact', () => {
  it('a scheme-less source with an encoded e-mail in its path, behind the limit', () => {
    const raw = behindLimit('frame-ancestors portal.invalid/users/alice%40mail.invalid');
    const rec = storedHeaderRecord(CSP, raw, BASE, (u) => u);
    expect(rec.value).toHaveLength(MAX_HEADER_VALUE);
    expect(rec.truncated).toBe(true);
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: [REDACTED] });
    expect(JSON.stringify(rec)).not.toContain(SECRET);
  });

  it('the same source in a short CSP: neither the fact nor the stored value keeps the address', () => {
    const rec = storedHeaderRecord(
      CSP,
      'frame-ancestors portal.invalid/users/alice%40mail.invalid',
      BASE,
      sanitizeUrl,
    );
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: [REDACTED] });
    expect(JSON.stringify(rec)).not.toContain(SECRET);
    expect(rec.value).toBe('frame-ancestors [redacted]');
  });

  it.each([
    ['userinfo with a scheme', 'https://alice:secret@portal.invalid/p', '[redacted]'],
    ['userinfo without a scheme', 'alice:secret@portal.invalid:8443/p', '[redacted]'],
    ['a bare e-mail address', 'alice@mail.invalid', '[redacted]'],
    ['an e-mail with special characters in the local part', "a+b'c#d@mail.invalid", '[redacted]'],
    [
      'a plain e-mail in the path of a source with a scheme',
      'https://portal.invalid/u/alice@mail.invalid',
      '[redacted]',
    ],
    [
      'an address that starts after a quote in the path leaves the host',
      'https://portal.invalid/u"alice@mail.invalid',
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
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: [REDACTED] });
  });

  it('a wildcard next to an address still means open framing, and the address is not stored', () => {
    const fact = cspFrameAncestors('frame-ancestors * alice@mail.invalid');
    expect(fact).toEqual({ present: true, restricts: false, sources: ['*', '[redacted]'] });
  });

  it('the report-only policy is treated alike', () => {
    const rec = storedHeaderRecord(
      'content-security-policy-report-only',
      behindLimit('frame-ancestors alice@mail.invalid/x'),
      BASE,
      (u) => u,
    );
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: ['[redacted]'] });
  });
});

describe('the stored CSP value', () => {
  const stored = (value: string, sanitize = sanitizeUrl) =>
    storedHeaderRecord(CSP, value, BASE, sanitize).value;

  it.each([
    ['frame-ancestors portal.invalid/users/alice%40mail.invalid', 'frame-ancestors [redacted]'],
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

  it('counterexample: http(s) sources still go through the URL sanitizer of the collector, without query and fragment', () => {
    const seen: string[] = [];
    const rec = storedHeaderRecord(
      CSP,
      'script-src https://cdn.example.test/a.js?x=1; frame-ancestors portal.invalid',
      BASE,
      (u) => {
        seen.push(u);
        return u.replace('a.js', 'b.js');
      },
    );
    expect(seen).toEqual(['https://cdn.example.test/a.js']);
    expect(rec.value).toBe('script-src https://cdn.example.test/b.js; frame-ancestors portal.invalid');
  });

  it('a scheme-less source with a path next to a sanitized http(s) token is reduced by itself', () => {
    const seen: string[] = [];
    const rec = storedHeaderRecord(
      CSP,
      'script-src https://cdn.example.test/a.js?x=1; frame-ancestors portal.invalid/p',
      BASE,
      (u) => {
        seen.push(u);
        return u.replace('a.js', 'b.js');
      },
    );
    expect(seen).toEqual(['https://cdn.example.test/a.js']);
    expect(rec.value).toBe('script-src https://cdn.example.test/b.js; frame-ancestors portal.invalid');
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
    for (const name of [CSP, 'content-security-policy-report-only']) {
      const rec = storedHeaderRecord(name, value, BASE, sanitizeUrl);
      expect(rec.value).toBe(expected);
      expect(JSON.stringify(rec)).not.toMatch(new RegExp(`zq7|${UUID}`));
    }
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

  it('frame-ancestors is read from the policy as sent, next to a relative report-uri', () => {
    const rec = storedHeaderRecord(
      CSP,
      "frame-ancestors 'self'; report-uri /csp?visitor=zq7alice",
      BASE,
      sanitizeUrl,
    );
    expect(rec).toEqual({
      name: CSP,
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
    for (const rec of [
      storedHeaderRecord(name, value, BASE, sanitizeUrl),
      ...snapshotHeaderRecords([{ name, value }], BASE),
    ]) {
      expect(rec.value).toBe(expected);
      expect(JSON.stringify(rec)).not.toContain('zq7');
    }
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

  it('counterexample: an origin without a path is stored as the URL sanitizer writes it', () => {
    expect(
      storedHeaderRecord(
        'permissions-policy',
        'geolocation=(self "https://maps.example.test")',
        BASE,
        sanitizeUrl,
      ).value,
    ).toBe('geolocation=(self "https://maps.example.test/")');
  });
});

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

describe('a kept header stores only what its grammar allows', () => {
  const LEAKS = [
    'alice',
    'visitorSecret',
    'secret',
    'QWxhZGRp',
    '123e4567',
    'first;',
    '4f3a9c1d2e7b4a9f',
    'smith',
    'ustermann',
    'Jürgen',
    'Müller',
    '+491701234567',
  ];

  it.each([
    [
      'an address in the (at) form after report-uri',
      CSP,
      'report-uri alice (at) example.test',
      'report-uri [redacted]@example.test',
    ],
    [
      'an address in the [at] form after report-uri',
      CSP,
      'report-uri alice [at] example.test',
      'report-uri [redacted]@example.test',
    ],
    [
      'an obfuscated address no mask reads, as sources',
      CSP,
      'script-src alice (at) www.example.test',
      'script-src [redacted] [redacted] [redacted]',
    ],
    [
      'a nonce keeps no payload',
      CSP,
      "script-src 'nonce-QWxhZGRpbjpvcGVuIHNlc2FtZQ=='",
      "script-src 'nonce-[redacted]'",
    ],
    [
      'a hash keeps no payload',
      CSP,
      "script-src 'sha256-QWxhZGRpbjpvcGVuIHNlc2FtZQ=='",
      "script-src 'sha256-[redacted]'",
    ],
    [
      'an origin with a quoted blank and an encoded @',
      'x-frame-options',
      'ALLOW-FROM "alice smith"%252540example.test',
      '[redacted]',
    ],
    [
      'an origin that is a long run before an @',
      'x-frame-options',
      `ALLOW-FROM visitorSecret${'a'.repeat(80)}@example.test`,
      'ALLOW-FROM [redacted]',
    ],
    [
      'a title with an address in the (at) form',
      'link',
      '</a>; title="alice (at) intranet"',
      '<https://www.example.test/a>; title=[redacted]',
    ],
    [
      'a title with an address before www',
      'link',
      '</a>; title="alice (at) www.example.test"',
      '<https://www.example.test/a>; title=[redacted]',
    ],
    [
      'a title that is an identifier',
      'link',
      '</a.css>; rel=preload; title="4f3a9c1d2e7b4a9f"',
      '<https://www.example.test/a.css>; rel=preload; title=[redacted]',
    ],
    [
      'a fragment of an anchor',
      'link',
      '</a>; anchor="/r#visitorSecret"',
      '<https://www.example.test/a>; anchor="/r"',
    ],
    [
      'a semicolon inside the quotes of an anchor',
      'link',
      '</a>; anchor="/r?x=first;visitorSecret"',
      '<https://www.example.test/a>; anchor="https://www.example.test/r?x=[redacted]"',
    ],
    [
      'a semicolon in the fragment of an anchor',
      'link',
      '</a>; anchor="/r#first;visitorSecret"',
      '<https://www.example.test/a>; anchor="/r"',
    ],
    [
      'a comma and a semicolon inside the quotes of another parameter',
      'link',
      '</a>; title="x,first;visitorSecret"',
      '<https://www.example.test/a>; title=[redacted]',
    ],
    [
      'a parameter value that is no token of the header',
      'content-type',
      'text/html; token=123e4567-e89b-12d3-a456-426614174000',
      'text/html; token=[redacted]',
    ],
  ])('%s', (_label, name, value, expected) => {
    const stored = storedHeaderRecord(name, value, BASE, sanitizeUrl).value;
    expect(stored).toBe(expected);
    for (const leak of LEAKS) expect(stored).not.toContain(leak);
  });

  it.each(['alice@example.test=x', 'alice%252540example.test=x'])(
    'a cookie name with an address is redacted and still counted: %s',
    (line) => {
      expect(setCookieName(line)).toBe(line.slice(0, line.indexOf('=')));
      expect(storedCookieName(line.slice(0, line.indexOf('=')))).toBe('[redacted]');
      expect(snapshotHeaders({ 'Set-Cookie': [line] }).setCookieNames).toEqual(['[redacted]']);
      expect(splitSetCookieNames([line])).toEqual(['[redacted]']);
    },
  );
});

describe('closed grammars: a value outside the grammar of its parameter, name or directive is redacted', () => {
  const LEAKS = [
    'alice',
    'visitorSecret',
    '123e4567',
    '4f3a9c1d2e7b4a9f',
    'smith',
    'ustermann',
    'Jürgen',
    'Müller',
    '+4917',
  ];
  const UUID = '123e4567-e89b-12d3-a456-426614174000';
  const L = '<https://www.example.test/a>';

  it.each([
    ['rel is an identifier', 'link', '</a>; rel=4f3a9c1d2e7b4a9f', `${L}; rel=[redacted]`],
    ['rel is a UUID', 'link', `</a>; rel="${UUID}"`, `${L}; rel=[redacted]`],
    [
      'rel holds a word after a relation',
      'link',
      '</a>; rel=next visitorSecret',
      `${L}; rel=next [redacted]`,
    ],
    ['rel holds a name', 'link', '</a>; rel="alice smith"', `${L}; rel="[redacted] [redacted]"`],
    ['crossorigin is a UUID', 'link', `</a>; crossorigin="${UUID}"`, `${L}; crossorigin=[redacted]`],
    [
      'fetchpriority is an identifier',
      'link',
      '</a>; fetchpriority=4f3a9c1d2e7b4a9f',
      `${L}; fetchpriority=[redacted]`,
    ],
    ['as is a name', 'link', '</a>; as=Max Mustermann', `${L}; as=[redacted] [redacted]`],
    ['hreflang is a name', 'link', '</a>; hreflang="Max Mustermann"', `${L}; hreflang=[redacted]`],
    [
      'media is words and an identifier',
      'link',
      '</a>; media="alice smith 4f3a9c1d2e7b4a9f"',
      `${L}; media=[redacted]`,
    ],
    ['a parameter name is a word', 'link', '</a>; visitorSecret', `${L}; [redacted]`],
    ['unknown parameters in a row are one', 'link', '</a>; alice-smith; Max', `${L}; [redacted]`],
    ['a parameter name is an identifier', 'link', '</a>; x4f3a9c1d2e7b4a9f', `${L}; [redacted]`],
    [
      'an unknown parameter after a known one',
      'link',
      '</a>; rel=next; visitorSecret=[redacted]',
      `${L}; rel=next; [redacted]`,
    ],
    [
      'an unquoted anchor with a semicolon in its query',
      'link',
      '</a>; anchor=/r?x=first;visitorSecret',
      `${L}; anchor=https://www.example.test/r?x=[redacted];[redacted]`,
    ],
    [
      'a directive name is a word',
      'content-security-policy',
      "default-src 'self'; aliceSmith",
      "default-src 'self'; [redacted]",
    ],
    [
      'a semicolon in the query of a source',
      'content-security-policy',
      'script-src https://cdn.example.test/a?x;visitorSecret',
      'script-src https://cdn.example.test/a;[redacted]',
    ],
    [
      'a semicolon in the query of a report-uri',
      'content-security-policy',
      'report-uri /r?x=1;visitorSecret',
      'report-uri https://www.example.test/r?x=[redacted];[redacted]',
    ],
    [
      'a semicolon in the fragment of a report-uri',
      'content-security-policy',
      'report-uri /r#x;visitorSecret',
      'report-uri /r;[redacted]',
    ],
    [
      'a comma before a word',
      'content-security-policy',
      'report-uri /csp,visitorSecret',
      'report-uri /csp,[redacted]',
    ],
    [
      'a word after a comma and a blank',
      'content-security-policy',
      'report-uri https://r.example.test/csp?ids=1, visitorSecret',
      'report-uri https://r.example.test/csp?ids=[redacted], [redacted]',
    ],
    ['an identifier as the only token', 'x-content-type-options', UUID, '[redacted]'],
    [
      'an identifier after a referrer policy',
      'referrer-policy',
      'strict-origin-when-cross-origin, 4f3a9c1d2e7b4a9f',
      'strict-origin-when-cross-origin, [redacted]',
    ],
    [
      'a reporting group that is an identifier',
      'cross-origin-opener-policy',
      'same-origin; report-to="visitorSecret4f3a9c1d2e7b4a9f"',
      'same-origin; [redacted]',
    ],
    ['a feature that is an identifier', 'permissions-policy', 'x4f3a9c1d2e7b4a9f=*', '[redacted]'],
    ['a feature that is a name', 'permissions-policy', 'alice-smith=(self)', '[redacted]'],
    [
      'a subtype and a charset that are identifiers',
      'content-type',
      'application/4f3a9c1d2e7b4a9f; charset=4f3a9c1d2e7b4a9f',
      '[redacted]; charset=[redacted]',
    ],
    ['a Retry-After of many digits', 'retry-after', '1234567890123456', '[redacted]'],
    [
      'two words as sources',
      'content-security-policy',
      'script-src Jürgen Müller',
      'script-src [redacted] [redacted]',
    ],
    [
      'two words as report-uri values',
      'content-security-policy',
      'report-uri Max Mustermann',
      'report-uri [redacted] [redacted]',
    ],
    [
      'words after a URL',
      'content-security-policy',
      'report-uri https://r.example.test/a b c',
      'report-uri https://r.example.test/a [redacted] [redacted]',
    ],
    ['a UUID as a source', 'content-security-policy', `script-src ${UUID}`, 'script-src [redacted]'],
    [
      'an opaque URL in report-uri',
      'content-security-policy',
      `report-uri x:4f3a9c1d2e7b4a9f-${UUID}`,
      'report-uri x:[redacted]',
    ],
    [
      'a phone number in report-uri',
      'content-security-policy',
      'report-uri tel:+491701234567',
      'report-uri tel:[redacted]',
    ],
    [
      'a path on a ws URL in report-uri',
      'content-security-policy',
      'report-uri ws://r.example.test/x/visitorSecret',
      'report-uri ws:[redacted]',
    ],
    ['an opaque Link target', 'link', '<x:visitorSecret>; rel=next', '<x:[redacted]>; rel=next'],
    ['an opaque anchor', 'link', '</a>; anchor="javascript:alice"', `${L}; anchor="javascript:[redacted]"`],
    ['an opaque report URL', 'x-xss-protection', '1; report=x:visitorSecret', '1; report=x:[redacted]'],
    [
      'several words and (dot) before an obfuscated address',
      'content-security-policy',
      'report-uri alice (dot) smith (at) mail.invalid',
      'report-uri [redacted] [redacted] [redacted]@mail.invalid',
    ],
    [
      'the same as sources',
      'content-security-policy',
      'script-src alice (dot) smith (at) mail.invalid',
      'script-src [redacted] [redacted] [redacted]',
    ],
    [
      'the German marker for the dot',
      'content-security-policy',
      'report-uri max (punkt) mustermann (at) firma.de',
      'report-uri [redacted] [redacted] [redacted]@firma.de',
    ],
    [
      'a word before the local part',
      'content-security-policy',
      'report-uri alice smith (at) mail.invalid',
      'report-uri [redacted] [redacted]@mail.invalid',
    ],
    [
      'an @ with blanks around it',
      'content-security-policy',
      'report-uri alice @ mail.invalid',
      'report-uri [redacted] [redacted] [redacted]',
    ],
    [
      'an @ with blanks around it, as sources',
      'content-security-policy',
      'script-src alice @ mail.invalid',
      'script-src [redacted] [redacted] [redacted]',
    ],
    [
      'a marker glued to the host',
      'content-security-policy',
      'script-src alice (at)www.example.test',
      'script-src [redacted] [redacted]',
    ],
    [
      'an address in a path segment of a source',
      'content-security-policy',
      'script-src https://cdn.example.test/u/alice@intranet',
      'script-src https://cdn.example.test/',
    ],
    [
      'a tilde name and @ in a path segment',
      'content-security-policy',
      'script-src https://cdn.example.test/u/~alice@',
      'script-src https://cdn.example.test',
    ],
    [
      'a name with @localhost in a path',
      'content-security-policy',
      'script-src https://cdn.example.test/u/alice@localhost/',
      'script-src https://cdn.example.test/',
    ],
    [
      'an identifier in a path segment of a source',
      'content-security-policy',
      'script-src https://cdn.example.test/u/4f3a9c1d2e7b4a9f/app.js',
      'script-src https://cdn.example.test/',
    ],
    [
      'a mask the server wrote itself in report-uri',
      'content-security-policy',
      'report-uri /u/alice[redacted]@mail.invalid',
      'report-uri [redacted]',
    ],
    [
      'a mask the server wrote itself before a single-label host',
      'content-security-policy',
      'report-uri alice[redacted]@intranet',
      'report-uri [redacted]',
    ],
    [
      'a mask the server wrote itself in an anchor',
      'link',
      '</a>; anchor="/u/alice[redacted]@intranet"',
      `${L}; anchor=[redacted]`,
    ],
    [
      'a mask the server wrote itself in a report URL',
      'x-xss-protection',
      '1; report=/u/alice[redacted]@mail.invalid',
      '1; report=[redacted]',
    ],
    [
      'a repeated max-age with a value that is no number',
      'strict-transport-security',
      'max-age=31536000; max-age=abc',
      'max-age=31536000; max-age=[redacted]',
    ],
    [
      'a repeated max-age without a value',
      'strict-transport-security',
      'max-age=31536000; max-age',
      'max-age=31536000; max-age',
    ],
    [
      'a repeated max-age with a negative value',
      'strict-transport-security',
      'max-age=31536000; max-age=-1',
      'max-age=31536000; max-age=[redacted]',
    ],
    [
      'a repeated max-age with an exponent',
      'strict-transport-security',
      'max-age=31536000; max-age=1e9',
      'max-age=31536000; max-age=[redacted]',
    ],
    [
      'a repeated includeSubDomains with a value',
      'strict-transport-security',
      'max-age=31536000; includeSubDomains; includeSubDomains=1',
      'max-age=31536000; includeSubDomains; includeSubDomains=[redacted]',
    ],
    [
      'a max-age of more digits than a browser tells apart',
      'strict-transport-security',
      'max-age=99999999999999999999999',
      'max-age=999999999999999',
    ],
  ])('%s', (_label, name, value, expected) => {
    const rec = storedHeaderRecord(name, value, BASE, sanitizeUrl);
    expect(rec.value).toBe(expected);
    for (const leak of LEAKS) expect(JSON.stringify(rec)).not.toContain(leak);
  });

  it.each([
    'max-age=31536000; max-age=abc',
    'max-age=31536000; max-age',
    'max-age=31536000; max-age=-1',
    'max-age=31536000; max-age=1e9',
    'max-age=31536000; includeSubDomains; includeSubDomains=1',
    'max-age=31536000; includeSubDomains; preload',
    'max-age=0',
    'includeSubDomains',
  ])('the HSTS verdict of the stored value is the verdict of the value as sent: %s', (value) => {
    const stored = storedHeaderRecord('strict-transport-security', value, BASE, sanitizeUrl);
    const raw = { name: 'strict-transport-security', value };
    expect(hstsOf([stored])).toEqual(hstsOf([raw]));
  });

  it.each([
    ['frame-ancestors * (at) x', 'frame-ancestors * [redacted] [redacted]'],
    ['frame-ancestors https: [at] x', 'frame-ancestors https: [redacted] [redacted]'],
  ])(
    'a hidden address keeps the wildcard and the scheme, so the stored value reads as open framing: %s',
    (value, expected) => {
      const rec = storedHeaderRecord(CSP, value, BASE, sanitizeUrl);
      expect(rec.value).toBe(expected);
      expect(cspFrameAncestors(rec.value).restricts).toBe(false);
      expect(cspFrameAncestors(value).restricts).toBe(false);
    },
  );

  it.each([
    [
      "frame-ancestors 'self' alice (at) mail.invalid",
      "frame-ancestors 'self' [redacted]",
      ["'self'", '[redacted]'],
    ],
    [
      'frame-ancestors alice (dot) smith (at) mail.invalid',
      'frame-ancestors [redacted] [redacted] [redacted]',
      ['[redacted]', '[redacted]', '[redacted]'],
    ],
    ['frame-ancestors alice@intranet', 'frame-ancestors [redacted]', ['[redacted]']],
  ])('the stored fact and the stored value agree on %s', (value, stored, sources) => {
    const rec = storedHeaderRecord(CSP, value, BASE, sanitizeUrl);
    expect(rec.value).toBe(stored);
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources });
    for (const leak of LEAKS) expect(JSON.stringify(rec)).not.toContain(leak);
  });

  it.each([
    ['x-frame-options', 'SAMEORIGIN;'],
    ['x-frame-options', '"DENY"'],
    ['link', '<https://www.example.test/wp-json/>; rel="https://api.w.org/"'],
    [
      'link',
      '<https://www.example.test/a.css>; rel="preload stylesheet"; as=style; referrerpolicy=no-referrer; blocking=render',
    ],
    [
      'link',
      '<https://www.example.test/a.css>; rel=preload; media="(min-width: 600px) and (orientation: landscape)"',
    ],
    ['link', '<https://www.example.test/a.css>; rel=alternate; hreflang=de-CH; type=text/css'],
    [
      'link',
      '<https://www.example.test/a.js>; rel=preload; as=script; crossorigin=anonymous; fetchpriority=high',
    ],
    ['permissions-policy', 'camera=(self "https://a.example.test/");report-to=main-endpoint'],
    ['content-language', 'de-CH-1996'],
    ['content-security-policy', "webrtc 'block'"],
    ['content-security-policy', "script-src-elem 'self' 'report-sha256'"],
    ['content-security-policy', 'script-src https://cdn.example.test/npm/jquery@3.7.1/dist/jquery.min.js'],
    ['strict-transport-security', 'max-age=31536000'],
  ])('counterexample: %s %j is stored as sent', (name, value) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(value);
  });

  it('counterexample: an integrity value keeps the algorithm and no hash', () => {
    expect(
      storedHeaderRecord('link', '</a.js>; rel=preload; integrity="sha384-Zm9vYmFy"', BASE, sanitizeUrl)
        .value,
    ).toBe('<https://www.example.test/a.js>; rel=preload; integrity="sha384-[redacted]"');
  });
});

describe('values a real site sends are stored as sent', () => {
  it.each([
    ['x-frame-options', 'DENY'],
    ['x-frame-options', 'SAMEORIGIN'],
    ['x-frame-options', 'ALLOWALL'],
    ['strict-transport-security', 'max-age=31536000; includeSubDomains; preload'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    ['content-type', 'text/html; charset=utf-8'],
    ['content-language', 'de-DE'],
    ['retry-after', '120'],
    ['link', '<https://fonts.example.test/>; rel=preconnect; crossorigin'],
    ['cross-origin-opener-policy', 'same-origin; report-to="coop"'],
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

  it.each([
    'SESSabcdef0123456789abcdef0123456789',
    'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
    'TS01a2b3c4d5',
  ])('a cookie name with a site ID is kept: %s', (name) => {
    expect(setCookieName(`${name}=x`)).toBe(name);
  });
});

describe('stored by grammar: addresses hidden in a directive, opaque URLs, parameters and header names', () => {
  const NAME_REDACTED = '[redacted]';
  const UUID = '123e4567-e89b-12d3-a456-426614174000';

  it.each([
    // a directive that hides an address keeps nothing glued behind the domain of the mask
    [
      'a query behind the mask',
      CSP,
      "default-src 'self'; report-uri alice (at) example.test?token=visitorSecret#frag",
      "default-src 'self'; report-uri [redacted]@example.test",
    ],
    [
      'a quoted local part with a query behind the mask',
      CSP,
      'report-uri "alice smith"@example.test?u=visitorSecret',
      'report-uri [redacted]@example.test',
    ],
    [
      'a fragment behind the mask',
      CSP,
      'report-uri alice [at] example.test#visitorSecret',
      'report-uri [redacted]@example.test',
    ],
    [
      'a path with an ID behind the mask',
      CSP,
      `report-uri alice(at)example.test/${UUID}`,
      'report-uri [redacted]@example.test',
    ],
    // a host with a dot may be the local part
    [
      'a dotted local part before (at)',
      CSP,
      'script-src alice.smith (at) www.example.test',
      'script-src [redacted] [redacted] [redacted]',
    ],
    [
      'a dotted local part before (at) and a (dot) domain',
      CSP,
      'script-src alice.smith (at) example (dot) test',
      'script-src [redacted] [redacted] [redacted] [redacted] [redacted]',
    ],
    [
      'a dotted local part before a blank @',
      CSP,
      'script-src alice.smith @ mail.example.test',
      'script-src [redacted] [redacted] [redacted]',
    ],
    [
      'a dotted local part before a glued @',
      CSP,
      'script-src alice.smith @mail.example.test',
      'script-src [redacted] [redacted]',
    ],
    [
      'a dotted local part before a blank %40',
      CSP,
      'script-src alice.smith %40 mail.example.test',
      'script-src [redacted] [redacted] [redacted]',
    ],
    [
      'a dotted local part before a blank %2540',
      CSP,
      'script-src alice.smith %2540 mail.example.test',
      'script-src [redacted] [redacted] [redacted]',
    ],
    // an address whose local part is the host
    ['? inside an address', CSP, 'script-src alice.smith?@mail.example.test', 'script-src [redacted]'],
    ['# inside an address', CSP, 'script-src alice.smith#@mail.example.test', 'script-src [redacted]'],
    ['/ inside an address', CSP, 'script-src alice.smith/@mail.example.test', 'script-src [redacted]'],
    [
      'a scheme before an address with #',
      CSP,
      'script-src https://alice.smith#@mail.example.test',
      'script-src [redacted]',
    ],
    // an @ in a path is a version only when a number follows
    [
      'a host-like version in a path',
      CSP,
      'script-src https://cdn.example.test/u/alice.smith@1x.example.de/a.js',
      'script-src https://cdn.example.test/',
    ],
    // a parameter name may be the local part of an address
    ['an address split at "="', 'content-type', 'text/html; alice=@example.test', 'text/html; [redacted]'],
    [
      'an address split at "=" with (at)',
      'content-type',
      'text/html; alice=(at) example.test',
      'text/html; [redacted]',
    ],
    [
      'an encoded address split at "="',
      'content-type',
      'text/html; alice_smith=%40example.test',
      'text/html; [redacted]',
    ],
    [
      'a quoted local part after a name',
      'content-type',
      'text/html; charset=utf-8; alice="smith"@example.test',
      'text/html; charset=utf-8; [redacted]',
    ],
    // the URL headers
    ['Location: tel:', 'location', 'tel:+4915112345678', 'tel:[redacted]'],
    ['Location: javascript:', 'location', 'javascript:visitorSecret', 'javascript:[redacted]'],
    ['Location: urn:', 'location', `urn:uuid:${UUID}`, 'urn:[redacted]'],
    ['Location: an app scheme', 'location', 'myapp://callback/visitorSecret', 'myapp:[redacted]'],
    ['Content-Location: about:', 'content-location', 'about:visitorSecret', 'about:[redacted]'],
    ['Location: @ in a path', 'location', '/u/alice@intranet', '[redacted]'],
    ['Content-Location: @ in a path', 'content-location', '/u/~alice@localhost/', '[redacted]'],
    [
      'Location: a visible [redacted] the server wrote',
      'location',
      'https://x.test/u/alice[redacted]@mail.invalid',
      '[redacted]',
    ],
    ['Link: @ in a path', 'link', '</u/alice@intranet>; rel=next', '<[redacted]>; rel=next'],
    ['Link: a bare @', 'link', '</u/~alice@>', '<[redacted]>'],
    ['Link: a host-like version', 'link', '</u/alice@2x.mail.test>', '<[redacted]>'],
    [
      'Refresh: javascript:',
      'refresh',
      "0; url=javascript:alert('visitorSecret')",
      '0; url=javascript:[redacted]',
    ],
    ['Refresh: tel:', 'refresh', '0; url=tel:+4915112345678', '0; url=tel:[redacted]'],
    // a URL starts after the controls and blanks the parser skips
    [
      'a control before a scheme in Link',
      'link',
      '<\u0001x:visitorSecret>; rel=next',
      '<x:[redacted]>; rel=next',
    ],
    ['a control before tel: in Link', 'link', '<\u0001tel:+4915112345678>', '<tel:[redacted]>'],
    [
      'a control before javascript: in report-uri',
      CSP,
      'report-uri \u0001javascript:alert(visitorSecret.x)',
      'report-uri javascript:[redacted]',
    ],
    [
      'a control before a scheme in anchor',
      'link',
      '</a>; anchor="\u0001javascript:visitorSecret.x"',
      '<https://www.example.test/a>; anchor="javascript:[redacted]"',
    ],
    [
      'a control before a scheme in report=',
      'x-xss-protection',
      '1; report=\u0001myapp:visitorSecret/x',
      '1; report=myapp:[redacted]',
    ],
    // a delay is a short number
    ['Refresh: a phone number as the delay', 'refresh', '4915112345678; url=/x', '[redacted]'],
    ['Refresh: a long fraction', 'refresh', '0.4915112345678', '[redacted]'],
    ['Refresh: counterexample, a fraction', 'refresh', '0.5; url=/x', '0.5; url=https://www.example.test/x'],
  ])('%s', (_label, name, value, expected) => {
    const out = storedHeaderRecord(name, value, BASE, sanitizeUrl).value;
    expect(out).toBe(expected);
    expect(out).not.toMatch(/alice|visitorSecret|4915112|123e4567/);
  });

  it.each([
    'frame-ancestors alice.smith (at) www.example.test',
    'frame-ancestors alice.smith @ mail.example.test',
    'frame-ancestors alice.smith?@mail.example.test',
    'frame-ancestors alice.smith/@mail.example.test',
  ])('the sources of the frameAncestors fact hold no local part: %s', (value) => {
    const sources = cspFrameAncestors(value).sources;
    expect(sources.join(' ')).not.toContain('alice');
    expect(JSON.stringify(storedHeaderRecord(CSP, value, BASE, sanitizeUrl))).not.toContain('alice');
  });

  it.each([
    [
      'a package scope and a numeric version in a path',
      'script-src https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.8/dist/umd/popper.min.js',
      'script-src https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.8/dist/umd/popper.min.js',
    ],
    [
      'a numeric version with a pre-release',
      'script-src https://cdn.example.test/npm/pkg@1.2.3-beta.1/a.js',
      'script-src https://cdn.example.test/npm/pkg@1.2.3-beta.1/a.js',
    ],
    [
      'scheme sources of apps, a dotted host after a hidden marker kept with its scheme',
      "default-src 'self' android-webview-video-poster: gap: file: content: capacitor:; form-action 'self' mailto: tel:",
      "default-src 'self' android-webview-video-poster: gap: file: content: capacitor:; form-action 'self' mailto: tel:",
    ],
    [
      'trusted-types policy names with # and .',
      "trusted-types angular#unsafe-bypass goog#html default 'allow-duplicates'",
      "trusted-types angular#unsafe-bypass goog#html default 'allow-duplicates'",
    ],
  ])('counterexample: %s', (_label, value, expected) => {
    expect(storedHeaderRecord(CSP, value, 'https://www.example.test/', (u) => u).value).toBe(expected);
  });

  it.each([
    'ch-ua-wow64=*',
    'vibrate=(), push=(), notifications=(), speaker=()',
    'layout-animations=(self), legacy-image-formats=(self), oversized-images=(self), unoptimized-images=(self), unsized-media=(self)',
    'private-aggregation=(), shared-storage=(), shared-storage-select-url=(), deferred-fetch=(), deferred-fetch-minimal=()',
    'digital-credentials-get=(), captured-surface-control=(), all-screens-capture=(), autofill=()',
    'language-detector=(), summarizer=(), translator=(), writer=(), rewriter=(), language-model=()',
    'local-network-access=(), popins=(), web-printing=(), on-device-speech-recognition=()',
  ])('counterexample: Permissions-Policy features of current browsers are kept: %s', (value) => {
    expect(storedHeaderRecord('permissions-policy', value, BASE, sanitizeUrl).value).toBe(value);
  });

  it.each([
    ['link', '</a>; rel=expect'],
    ['link', '</keys>; rel=ohttp-keys'],
  ])('counterexample: a link relation of the registry is kept: %s %s', (name, value) => {
    expect(storedHeaderRecord(name, value, BASE, (u) => u).value).toBe(
      value
        .replace('</a>', '<https://www.example.test/a>')
        .replace('</keys>', '<https://www.example.test/keys>'),
    );
  });

  it.each([
    'max-age=31536000; foo="x;max-age=0"',
    'max-age=31536000; a="; max-age=0',
    'max-age=31536000; a="; includeSubDomains; includeSubDomains',
    'max-age=0, "x; max-age=100',
    'max-age=0, x="a; max-age=5"',
    'max-age=1, x="a; max-age=2',
    'max-age="31536000"; includeSubDomains',
    'max-age=5", max-age=6',
    'max-age=1, max-age="2',
    'max-age=1; x="a,b"; max-age=2',
  ])('the HSTS verdict of the stored value follows the quotes like the value as sent: %s', (value) => {
    const stored = storedHeaderRecord('strict-transport-security', value, BASE, sanitizeUrl);
    expect(stored.value).not.toContain('"');
    expect(hstsOf([stored])).toEqual(hstsOf([{ name: 'strict-transport-security', value }]));
  });

  it.each([
    ['x-frame-options', '"x, DENY, y"', '[redacted], DENY, [redacted]'],
    ['referrer-policy', 'no-referrer, "a, unsafe-url, b"', 'no-referrer, [redacted], unsafe-url, [redacted]'],
  ])('a list without quoted strings splits at every comma: %s %s', (name, value, expected) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(expected);
  });

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
  const NAME_REDACTED = '[redacted]';
  const UUID = '123e4567-e89b-12d3-a456-426614174000';

  it.each([
    ['a UUID in an allowed query value', 'location', `/p?hl=${UUID}`, `${BASE}p?hl=[redacted]`],
    [
      'a token in an allowed query value',
      'content-location',
      '/p?hl=Xk2mQ9pLw8eR1tZ3aB4cD5',
      `${BASE}p?hl=[redacted]`,
    ],
    [
      'an address marker in an allowed query value',
      'location',
      '/p?hl=alice@intranet',
      `${BASE}p?hl=[redacted]`,
    ],
    [
      'an obfuscated marker in an allowed query value',
      'location',
      '/p?hl=alice(at)intranet',
      `${BASE}p?hl=[redacted]`,
    ],
    ['an address marker behind display=', 'location', '/p?display=alice@corp', `${BASE}p?display=[redacted]`],
    ['counterexample: a language in an allowed query value', 'location', '/p?hl=de-DE', `${BASE}p?hl=de-DE`],
    [
      'counterexample: versions in an allowed query value',
      'location',
      '/p?ver=6.4.2&v=2.1.0',
      `${BASE}p?ver=6.4.2&v=2.1.0`,
    ],
    [
      'counterexample: a tag id in an allowed query value',
      'location',
      '/gtag/js?id=G-ABCDEF1234',
      `${BASE}gtag/js?id=G-ABCDEF1234`,
    ],
  ])('%s', (_label, name, value, expected) => {
    expect(storedHeaderRecord(name, value, BASE, sanitizeUrl).value).toBe(expected);
  });

  it.each([
    ['a local part without a domain', 'alice@intranet'],
    ['a local part with a dot-less host and a suffix', 'sid@host2'],
    ['an obfuscated local part', 'alice(at)intranet'],
  ])('a cookie name with %s is stored as [redacted] and still counted', (_label, name) => {
    expect(storedCookieName(name)).toBe(NAME_REDACTED);
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

  it.each([
    ['an id behind a client hint', 'ch-ua-12345678901234567890=*'],
    ['a word behind a client hint', 'ch-ua-visitor=*'],
    ['a client hint that is not listed', 'ch-prefers-contrast=*'],
  ])('a Permissions-Policy feature that is %s is redacted', (_label, value) => {
    expect(storedHeaderRecord('permissions-policy', value, BASE, sanitizeUrl).value).toBe(NAME_REDACTED);
  });

  it.each([
    'ch-ua',
    'ch-ua-arch',
    'ch-ua-bitness',
    'ch-ua-form-factors',
    'ch-ua-full-version',
    'ch-ua-full-version-list',
    'ch-ua-mobile',
    'ch-ua-model',
    'ch-ua-platform',
    'ch-ua-platform-version',
    'ch-ua-wow64',
    'ch-device-memory',
    'ch-dpr',
    'ch-width',
    'ch-viewport-width',
    'ch-viewport-height',
    'ch-downlink',
    'ch-ect',
    'ch-rtt',
    'ch-save-data',
    'ch-prefers-color-scheme',
    'ch-prefers-reduced-motion',
    'ch-prefers-reduced-transparency',
  ])('counterexample: the client hint feature %s is kept', (feature) => {
    expect(storedHeaderRecord('permissions-policy', `${feature}=(self)`, BASE, sanitizeUrl).value).toBe(
      `${feature}=(self)`,
    );
  });

  it.each([
    ['a calendar extension', 'en-US-u-ca-gregory'],
    ['a private use extension', 'de-DE-x-private'],
    ['two extensions in a list', 'en-u-ca-gregory, de-x-private'],
  ])('Content-Language with %s is kept', (_label, value) => {
    expect(storedHeaderRecord('content-language', value, BASE, sanitizeUrl).value).toBe(value);
  });

  it.each([
    ['an id in a private use extension', 'de-x-4f3a9c1d', NAME_REDACTED],
    ['a subtag beyond eight characters', 'en-u-ca-gregorian1', NAME_REDACTED],
    ['an extension without a subtag', 'en-US-u', NAME_REDACTED],
    ['a tag beyond the length cap', `en-u-${'ca-'.repeat(12)}gregory`, NAME_REDACTED],
  ])('Content-Language with %s is redacted', (_label, value, expected) => {
    expect(storedHeaderRecord('content-language', value, BASE, sanitizeUrl).value).toBe(expected);
  });
});

describe('a run of unknown entries does not push the entry that decides the verdict out of the stored value', () => {
  const RAW_LIMIT = 65_536;
  /** `head`, then `entry` repeated until the value is `size` characters, then `tail`. */
  const built = (head: string, entry: string, tail: string, size: number) =>
    head + entry.repeat(Math.max(0, Math.floor((size - head.length - tail.length) / entry.length))) + tail;
  const stored = (name: string, value: string) => storedHeaderRecord(name, value, BASE, sanitizeUrl);

  it.each([
    ['the HSTS example', 'strict-transport-security', 'max-age=1;', 'x;', 'max-age=0'],
    ['a referrer list', 'referrer-policy', 'no-referrer,', 'x,', 'unsafe-url'],
    ['an XFO list', 'x-frame-options', 'ALLOWALL,', 'x,', 'DENY'],
  ])(
    '%s: the end of the value is stored at 400 bytes, 2 KiB and 64 KiB',
    (_label, name, head, entry, tail) => {
      for (const size of [400, MAX_HEADER_VALUE, RAW_LIMIT]) {
        const value = built(head, entry, tail, size);
        const record = stored(name, value);
        expect(record.truncated).toBeUndefined();
        expect(record.value.length).toBeLessThan(MAX_HEADER_VALUE);
        expect(record.value.endsWith(tail)).toBe(true);
      }
    },
  );

  it.each([
    ['strict-transport-security', 'max-age=1;', 'x;', 'max-age=0'],
    ['strict-transport-security', 'max-age=31536000;', 'x=1;', 'includeSubDomains'],
    ['referrer-policy', 'no-referrer,', 'x,', 'unsafe-url'],
    ['referrer-policy', 'unsafe-url,', 'x,', 'no-referrer'],
    ['x-frame-options', 'ALLOWALL,', 'x,', 'DENY'],
    ['x-frame-options', 'x,', 'x,', 'ALLOWALL'],
    ['permissions-policy', 'x=(),', 'x=(),', 'camera=()'],
  ])(
    'the verdicts of HDR-01 and the HSTS reading follow the stored %s as they follow the value as sent: %s…',
    (name, head, entry, tail) => {
      for (const size of [400, MAX_HEADER_VALUE, RAW_LIMIT]) {
        const value = built(head, entry, tail, size);
        const record = stored(name, value);
        expect(hstsOf([record])).toEqual(hstsOf([{ name, value }]));
        const doc = (v: string) =>
          runCheck(
            hdr01,
            makeSnapshot({
              http: makeHttp({
                documents: [
                  makeDocumentResponse({
                    url: 'https://www.example.de/',
                    role: 'start',
                    headers: [
                      { name: 'strict-transport-security', value: 'max-age=31536000' },
                      { name: 'x-frame-options', value: 'SAMEORIGIN' },
                      { name: 'content-security-policy', value: "default-src 'self'" },
                      { name: 'x-content-type-options', value: 'nosniff' },
                      { name: 'referrer-policy', value: 'strict-origin' },
                      { name: 'permissions-policy', value: 'camera=()' },
                    ].map((h) => (h.name === name ? { name, value: v } : h)),
                  }),
                ],
              }),
            }),
          );
        const findings = (r: ReturnType<typeof doc>) =>
          observationsOf(r)
            .map((o) => `${o.variant}:${o.subject}`)
            .sort();
        expect(findings(doc(record.value))).toEqual(findings(doc(value)));
      }
    },
  );

  it('Link parameters and CSP directives that are unknown are one entry each', () => {
    const link = stored('link', built('</a>', ';x', '; rel=preload', RAW_LIMIT));
    expect(link.value).toBe(
      `<${BASE.slice(0, -1)}/a>; [redacted]; rel=preload`.replace('; [redacted]', ';[redacted]'),
    );
    const csp = stored('content-security-policy', built('', 'x;', "frame-ancestors 'self'", RAW_LIMIT));
    expect(csp.value).toBe("[redacted];frame-ancestors 'self'");
    expect(csp.truncated).toBeUndefined();
    expect(csp.frameAncestors).toMatchObject({ present: true, restricts: true });
  });

  it('counterexample: entries that are not unknown stay as sent', () => {
    expect(stored('referrer-policy', 'origin, x, same-origin, y, z, no-referrer').value).toBe(
      'origin, [redacted], same-origin, [redacted], no-referrer',
    );
    expect(stored('x-xss-protection', 'x; 1; y').value).toBe('[redacted]; 1; [redacted]');
  });
});
