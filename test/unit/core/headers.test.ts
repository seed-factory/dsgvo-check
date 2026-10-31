/**
 * L1: the header normalizer (D20, 5.3). Canary2 G42: a CSP over the stored limit is cut, so the facts the checks need
 * (`frame-ancestors`) are derived from the complete value before the cut and stored next to it.
 */
import { describe, expect, it } from 'vitest';
import {
  cspFrameAncestors,
  MAX_HEADER_VALUE,
  snapshotHeaderRecords,
  storedHeaderRecord,
} from '../../../src/core/headers.ts';

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

describe('snapshotHeaderRecords: values over the limit (G42)', () => {
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

  describe('the boundary of the limit (R12)', () => {
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
