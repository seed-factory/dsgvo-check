import { describe, expect, it } from 'vitest';
import {
  cspFrameAncestors,
  MAX_HEADER_VALUE,
  snapshotHeaderRecords,
  storedHeaderRecord,
} from '../../../../src/core/redaction/headers.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';

const BASE = 'https://www.example.test/';
const SECRET = 'alice';
const CSP = 'content-security-policy';

/** A CSP over the limit: a long `script-src` list, then `tail`. */
const longCsp = (tail: string) =>
  `default-src 'self'; script-src ${Array.from({ length: 120 }, (_, i) => `https://cdn${i}.example.test`).join(' ')}; ${tail}`;

/** `length` characters of `*` sources: the grammar keeps them as sent, a double blank makes up an even length. */
const stars = (length: number) => `${'* '.repeat(Math.ceil(length / 2) - 1)}${length % 2 === 0 ? ' *' : '*'}`;

/** A CSP whose `frame-ancestors` sits behind more than the stored limit, so the value itself never shows it. */
const behindLimit = (directive: string) =>
  `default-src 'self'; img-src ${stars(MAX_HEADER_VALUE + 252)}; ${directive}`;

const noSanitizer = () => {
  throw new Error('the URL sanitizer must not be needed for the fact');
};

describe('cspFrameAncestors', () => {
  it.each([
    ["frame-ancestors 'self'", { present: true, restricts: true, sources: ["'self'"] }],
    ["frame-ancestors 'none'", { present: true, restricts: true, sources: ["'none'"] }],
    ['frame-ancestors *', { present: true, restricts: false, sources: ['*'] }],
    ['frame-ancestors https:', { present: true, restricts: false, sources: ['https:'] }],
    // several policies in one value: one restricting policy is enough
    ["frame-ancestors *, frame-ancestors 'self'", { present: true, restricts: true, sources: ["'self'"] }],
    // the directive name is case-insensitive; a directive name inside a source list is no directive
    ["FRAME-ANCESTORS 'SELF'", { present: true, restricts: true, sources: ["'SELF'"] }],
    ["default-src 'self'; report-uri /frame-ancestors", { present: false, restricts: false, sources: [] }],
  ])('%j', (value, expected) => {
    expect(cspFrameAncestors(value)).toEqual(expected);
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
});

describe('sources of the frameAncestors fact', () => {
  it('a scheme-less source with an encoded e-mail in its path, behind the limit', () => {
    const raw = behindLimit('frame-ancestors portal.invalid/users/alice%40mail.invalid');
    const rec = storedHeaderRecord(CSP, raw, BASE, noSanitizer);
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
    expect(open.frameAncestors).toEqual({
      present: true,
      restricts: false,
      sources: ['*', 'https://a.example'],
    });
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
    expect(rec.truncated).toBe(true);
    expect(rec.frameAncestors).toEqual({ present: true, restricts: true, sources: ['[redacted]'] });
  });
});
