/**
 * L1 (S-net-2): the `frameAncestors` fact of a CSP header and the stored CSP value carry no e-mail address,
 * credentials or path of a source. A CSP host-source may come without a scheme and with a path
 * (`portal.invalid/users/alice%40mail.invalid`), which the URL sanitizer of the header values (http(s):// tokens)
 * does not see. `present` and `restricts` are decided on the policy as the server sent it, before any editing.
 * Synthetic names only (`*.invalid`, `*.test`).
 */
import { describe, expect, it } from 'vitest';
import {
  cspFrameAncestors,
  MAX_HEADER_VALUE,
  snapshotHeaderRecords,
  storedHeaderRecord,
} from '../../../src/core/headers.ts';
import { sanitizeUrl } from '../../../src/core/url.ts';

const BASE = 'https://www.example.test/';
const SECRET = 'alice';
const CSP = 'content-security-policy';

/** A CSP whose `frame-ancestors` sits behind more than the stored limit, so the value itself never shows it. */
const behindLimit = (directive: string) =>
  `default-src 'self'; x-pad ${'x'.repeat(MAX_HEADER_VALUE + 252)}; ${directive}`;

const noSanitizer = () => {
  throw new Error('the URL sanitizer must not be needed for the fact');
};

describe('S-net-2: sources of the frameAncestors fact', () => {
  it('Sol repro: a scheme-less source with an encoded e-mail in its path, behind the limit', () => {
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

  it('N-REV-1: a bare scheme token is cut at 200 characters as every other source is', () => {
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

describe('S-net-2: present and restricts come from the policy as sent', () => {
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

describe('S-net-2: the stored CSP value', () => {
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
