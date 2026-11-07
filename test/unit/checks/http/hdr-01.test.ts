import { describe, expect, it } from 'vitest';
import { hdr01 } from '../../../../src/checks/http/hdr-01.ts';
import { MAX_HEADER_VALUE, storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import type { DocumentResponse } from '../../../../src/core/snapshot/http.ts';
import type { HeaderRecord } from '../../../../src/core/snapshot/index.ts';
import {
  makeChain,
  makeDocumentResponse,
  makeHop,
  makeHttp,
  makeSnapshot,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';

const GOOD: HeaderRecord[] = [
  { name: 'strict-transport-security', value: 'max-age=31536000; includeSubDomains' },
  { name: 'x-frame-options', value: 'SAMEORIGIN' },
  { name: 'content-security-policy', value: "default-src 'self'" },
  { name: 'x-content-type-options', value: 'nosniff' },
  { name: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
  { name: 'permissions-policy', value: 'camera=(), geolocation=()' },
];

const without = (...names: string[]) => GOOD.filter((h) => !names.includes(h.name));

function snap(docs: Partial<DocumentResponse>[], extra: Parameters<typeof makeHttp>[0] = {}) {
  return makeSnapshot({
    http: makeHttp({
      documents: docs.map((d) => makeDocumentResponse({ url: 'https://www.example.de/', ...d })),
      ...extra,
    }),
  });
}

/** `variant:subject` of every observation (header-missing is one variant for several headers). */
const findingsOf = (r: ReturnType<typeof runCheck>) =>
  observationsOf(r)
    .map((o) => `${o.variant}:${o.subject}`)
    .sort();

const start = (headers: HeaderRecord[], p: Partial<DocumentResponse> = {}) => ({
  role: 'start' as const,
  headers,
  ...p,
});

/** The start page with GOOD, one header set to `value`. */
const runWith = (name: string, value: string) =>
  runCheck(hdr01, snap([start([...without(name), { name, value }])]));

describe('HDR-01 security headers', () => {
  it.each([
    ['sameorigin, SAMEORIGIN', [], 'combined values that agree'],
    ['SAMEORIGIN, ALLOW-FROM https://example.test', [], 'combined values, the obsolete one ignored'],
    ['ALLOWALL', ['anti-framing-missing'], 'a single ALLOWALL protects nothing'],
    ['allowall', ['anti-framing-missing'], 'a single ALLOWALL protects nothing'],
    ['ALLOWALL, ALLOWALL', ['anti-framing-missing'], 'a single ALLOWALL protects nothing'],
    ['ALLOWALL, DENY', [], 'conflicting values: the browser blocks the frame'],
    ['DENY, ALLOWALL', [], 'conflicting values: the browser blocks the frame'],
    ['ALLOWALL, SAMEORIGIN', [], 'conflicting values: the browser blocks the frame'],
    ['ALLOWALL, ALLOW-FROM https://example.test', [], 'conflicting values: the browser blocks the frame'],
    [
      'ALLOW-FROM https://a.example, ALLOW-FROM https://b.example',
      ['anti-framing-missing'],
      'counterexample: a list without any recognised value is no protection',
    ],
    ['ALLOW-FROM https://a.de', ['anti-framing-missing'], 'ALLOW-FROM is obsolete and does not count'],
  ])('X-Frame-Options "%s" → %j: %s', (value, variants) => {
    expect(variantsOf(runWith('x-frame-options', value))).toEqual(variants);
  });

  it('violation: nothing set → one observation per mechanism', () => {
    const r = runCheck(hdr01, snap([start([])]));
    expect(r.status).toBe('completed');
    expect(findingsOf(r)).toEqual([
      'anti-framing-missing:anti-framing',
      'header-missing:content-security-policy',
      'header-missing:permissions-policy',
      'header-missing:referrer-policy',
      'header-missing:x-content-type-options',
      'hsts-missing:strict-transport-security',
    ]);
    const hsts = observationsOf(r).find((o) => o.variant === 'hsts-missing');
    expect(hsts).toMatchObject({
      subject: 'strict-transport-security',
      phases: ['http'],
      pages: ['https://www.example.de/'],
      params: { url: 'https://www.example.de/', count: 1, problem: 'absent' },
      confidence: 'high',
    });
    const csp = observationsOf(r).find((o) => o.subject === 'content-security-policy');
    expect(csp?.params).toMatchObject({
      header: 'Content-Security-Policy',
      mechanism: 'content-security-policy',
    });
    expect(hsts?.evidence).toEqual([
      {
        type: 'header',
        phase: 'http',
        page: 'https://www.example.de/',
        url: 'https://www.example.de/',
        name: 'strict-transport-security',
        present: false,
        value: null,
      },
    ]);
  });

  it('clean: full set of headers', () => {
    const r = runCheck(hdr01, snap([start(GOOD)]));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: frame-ancestors only in a meta CSP does not count', () => {
    const r = runCheck(
      hdr01,
      snap([
        start(without('x-frame-options'), {
          metaHttpEquiv: [{ name: 'content-security-policy', value: "frame-ancestors 'none'" }],
        }),
      ]),
    );
    expect(variantsOf(r)).toEqual(['anti-framing-missing']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ hint: 'meta-csp' });
  });

  it.each([
    [
      'frame-ancestors does not count as anti-framing',
      'x-frame-options',
      "frame-ancestors 'none'",
      ['anti-framing-missing'],
    ],
    ['it satisfies "CSP present"', 'content-security-policy', "default-src 'self'", []],
  ] as const)('a report-only CSP: %s', (_label, replaced, value, variants) => {
    const headers = [...without(replaced), { name: 'content-security-policy-report-only', value }];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).toEqual(variants);
  });

  describe('a CSP over the stored limit', () => {
    const cut = (extra: Partial<HeaderRecord> = {}): HeaderRecord => ({
      name: 'content-security-policy',
      value: `default-src 'self'; ${'x'.repeat(2040)}`.slice(0, 2048),
      ...extra,
    });
    /** A CSP of exactly `length` characters without URLs, stored the way the collectors store it. */
    const stored = (length: number, tail = '') => {
      const head = "default-src 'self'; x-pad ";
      const value = head + 'a'.repeat(length - head.length - tail.length) + tail;
      return storedHeaderRecord('content-security-policy', value, 'https://www.example.test/', (u) => u);
    };
    /** The record as an older snapshot stored it: without the frame-ancestors fact. */
    const older = (record: HeaderRecord) => {
      const old = { ...record };
      delete old.frameAncestors;
      return old;
    };
    const run = (csp: HeaderRecord) =>
      runCheck(hdr01, snap([start([...without('x-frame-options', 'content-security-policy'), csp])]));

    // The rows built with `stored` sit at the boundary of the limit: the record comes from the collector.
    it.each([
      [
        'truncated, but frame-ancestors seen in the full value: no anti-framing finding',
        cut({ truncated: true, frameAncestors: { present: true, restricts: true, sources: ["'self'"] } }),
        [],
      ],
      [
        'truncated, directive absent in the full value: the finding stays (complete knowledge)',
        cut({ truncated: true, frameAncestors: { present: false, restricts: false, sources: [] } }),
        ['anti-framing-missing'],
      ],
      [
        'counterexample: a complete CSP without the directive still gives the finding',
        { name: 'content-security-policy', value: "default-src 'self'" },
        ['anti-framing-missing'],
      ],
      ['exactly the limit, complete, no directive', stored(MAX_HEADER_VALUE), ['anti-framing-missing']],
      [
        `counterexample: ${MAX_HEADER_VALUE - 1} characters without the directive give the same finding`,
        stored(MAX_HEADER_VALUE - 1),
        ['anti-framing-missing'],
      ],
      [
        `counterexample: ${MAX_HEADER_VALUE + 1} characters without the directive give the same finding`,
        stored(MAX_HEADER_VALUE + 1),
        ['anti-framing-missing'],
      ],
      [
        'counterexample: exactly the limit with the directive at the end: no finding',
        stored(MAX_HEADER_VALUE, "; frame-ancestors 'self'"),
        [],
      ],
    ])('%s → %j, completed without a limitation', (_label, csp, variants) => {
      const r = run(csp);
      expect(variantsOf(r)).toEqual(variants);
      expect(r.status).toBe('completed');
      expect(r.outcome?.limitations).toBeUndefined();
    });

    it.each([
      ['truncated without facts (older snapshot)', cut()],
      [
        'counterexample: a record of an older snapshot at the limit without the fact',
        older(stored(MAX_HEADER_VALUE)),
      ],
    ])('%s stays undecided: no finding, partial with a limitation', (_label, csp) => {
      const r = run(csp);
      expect(variantsOf(r)).toEqual([]);
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['csp-truncated']);
    });

    it('counterexample: X-Frame-Options settles it even when the CSP is truncated', () => {
      const r = runCheck(hdr01, snap([start([...without('content-security-policy'), cut()])]));
      expect(variantsOf(r)).toEqual([]);
      expect(r.status).toBe('completed');
    });

    it('counterexample: a truncated report-only policy does not count', () => {
      const ro: HeaderRecord = {
        name: 'content-security-policy-report-only',
        value: cut().value,
        truncated: true,
        frameAncestors: { present: true, restricts: true, sources: ["'none'"] },
      };
      const r = runCheck(
        hdr01,
        snap([start([...without('x-frame-options', 'content-security-policy'), ro])]),
      );
      expect(variantsOf(r)).toEqual(['anti-framing-missing']);
    });
  });

  it.each([
    ['frame-ancestors *', ['anti-framing-missing']],
    ['frame-ancestors * https://a.example', ['anti-framing-missing']],
    ['frame-ancestors https:', ['anti-framing-missing']],
    ["frame-ancestors 'self' https://a.example", []],
    ["frame-ancestors 'none'", []],
  ])('CSP "%s" → %j (a wildcard source allows every framer)', (directive, variants) => {
    const headers = [
      ...without('x-frame-options', 'content-security-policy'),
      { name: 'content-security-policy', value: `default-src 'self'; ${directive}` },
    ];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).toEqual(variants);
  });

  it('a meta CSP satisfies "CSP present" (but not anti-framing)', () => {
    const r = runCheck(
      hdr01,
      snap([
        start(without('content-security-policy'), {
          metaHttpEquiv: [{ name: 'content-security-policy', value: "default-src 'self'" }],
        }),
      ]),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('HSTS is only evaluated on https responses (http document: no HSTS finding)', () => {
    const r = runCheck(
      hdr01,
      snap([start(without('strict-transport-security'), { url: 'http://www.example.de/' })]),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: HSTS sent on the http redirect does not count for the https document', () => {
    const httpChain = makeChain({
      startUrl: 'http://www.example.de/',
      hops: [
        makeHop({
          url: 'http://www.example.de/',
          status: 301,
          location: 'https://www.example.de/',
          headers: [{ name: 'strict-transport-security', value: 'max-age=31536000' }],
        }),
      ],
    });
    const r = runCheck(hdr01, snap([start(without('strict-transport-security'))], { chains: [httpChain] }));
    expect(variantsOf(r)).toEqual(['hsts-missing']);
  });

  it.each([
    ['max-age=0', 'max-age-zero'],
    ['includeSubDomains', 'no-max-age'],
    ['max-age=abc', 'no-max-age'],
    ['max-age=31536000; max-age=0', 'repeated-directive'],
    ['max-age=31536000; includeSubDomains; includesubdomains', 'repeated-directive'],
    // Combined fields: the first one decides (RFC 6797 §8.1).
    ['max-age=0, max-age=31536000', 'max-age-zero'],
    ['includeSubDomains, max-age=31536000', 'no-max-age'],
  ])('HSTS "%s" has no effect → hsts-missing (%s)', (value, problem) => {
    const r = runWith('strict-transport-security', value);
    expect(variantsOf(r)).toEqual(['hsts-missing']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ problem });
    expect(observationsOf(r)[0]?.evidence[0]).toMatchObject({ present: true, value });
  });

  it.each([
    ['max-age=31536000; includeSubDomains; preload; preload', 'it repeats a directive the browser ignores'],
    ['max-age=31536000; foo; foo', 'it repeats a directive the browser ignores'],
    // Combined fields: the first one decides (RFC 6797 §8.1).
    ['max-age=15768000, max-age=31536000; includeSubDomains', 'only the first combined field counts'],
    ['max-age=31536000, max-age=0', 'only the first combined field counts'],
  ])('counterexample: HSTS "%s" is in force (%s) → no finding', (value) => {
    expect(variantsOf(runWith('strict-transport-security', value))).toEqual([]);
  });

  it.each([
    ['unsafe-url', ['referrer-policy-permissive:referrer-policy']],
    ['no-referrer-when-downgrade', ['referrer-policy-permissive:referrer-policy']],
    ['no-referrer, unsafe-url', ['referrer-policy-permissive:referrer-policy']],
    ['unsafe-url, strict-origin', []],
    ['origin-when-cross-origin', []],
    ['bogus', ['header-missing:referrer-policy']],
  ])('Referrer-Policy "%s" → %j', (value, findings) => {
    expect(findingsOf(runWith('referrer-policy', value))).toEqual(findings);
  });

  it('meta referrer counts as a Referrer-Policy and overrides the header', () => {
    const r = runCheck(hdr01, snap([start(without('referrer-policy'), { metaReferrer: 'unsafe-url' })]));
    expect(variantsOf(r)).toEqual(['referrer-policy-permissive']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ policy: 'unsafe-url' });
    expect(
      variantsOf(runCheck(hdr01, snap([start(without('referrer-policy'), { metaReferrer: 'same-origin' })]))),
    ).toEqual([]);
  });

  it('nosniff must be exactly "nosniff"', () => {
    const r = runWith('x-content-type-options', 'sniff');
    expect(findingsOf(r)).toEqual(['header-missing:x-content-type-options']);
  });

  it('legal pages: one finding per mechanism, pages united', () => {
    const r = runCheck(
      hdr01,
      snap([
        start(without('x-content-type-options')),
        {
          role: 'impressum',
          url: 'https://www.example.de/impressum',
          headers: without('x-content-type-options', 'permissions-policy'),
        },
      ]),
    );
    expect(r.status).toBe('completed');
    expect(findingsOf(r)).toEqual([
      'header-missing:permissions-policy',
      'header-missing:x-content-type-options',
    ]);
    const nosniff = observationsOf(r).find((o) => o.subject === 'x-content-type-options');
    expect(nosniff?.pages).toEqual(['https://www.example.de/', 'https://www.example.de/impressum']);
    expect(nosniff?.params).toMatchObject({ count: 2, url: 'https://www.example.de/' });
    expect(nosniff?.evidence).toHaveLength(2);
  });

  it('legal page not loaded → partial with limitation', () => {
    const r = runCheck(
      hdr01,
      snap([
        start(GOOD),
        {
          role: 'privacy',
          url: 'https://www.example.de/datenschutz',
          status: null,
          error: { code: 'timeout', message: 't' },
        },
      ]),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['document-unavailable:privacy']);
  });

  it.each([
    ['answered 503 (headers of an error page are not evaluated)', { status: 503 }, 'start-page-status'],
    ['counterexample: answered 429 without a challenge signature', { status: 429 }, 'start-page-status'],
    [
      'has an invalid certificate (likely a hoster default page)',
      { tlsAuthorized: false, tlsAuthorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' },
      'tls-invalid',
    ],
  ] as const)('inconclusive: the start page %s → %s', (_label, p, reason) => {
    expect(runCheck(hdr01, snap([start([], p)]))).toMatchObject({ status: 'inconclusive', reason });
  });

  describe('a bot or WAF challenge instead of the site (rule 5: inconclusive, never a finding)', () => {
    const blocked = { code: 'blocked', message: 'waf-block: header:x-vercel-mitigated' };

    it('on the start page → inconclusive (blocked), even with a 2xx status', () => {
      for (const status of [429, 200]) {
        const r = runCheck(hdr01, snap([start([], { status, error: blocked })]));
        expect(r).toMatchObject({ status: 'inconclusive', reason: 'blocked' });
        expect(r.outcome?.limitations).toEqual([`status:${status}`]);
        expect(variantsOf(r)).toEqual([]);
      }
    });

    it('on a legal page → partial, that page is not judged', () => {
      const r = runCheck(
        hdr01,
        snap([
          start(GOOD),
          { role: 'privacy', url: 'https://www.example.de/datenschutz', status: 403, error: blocked },
        ]),
      );
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['document-blocked:privacy']);
      expect(variantsOf(r)).toEqual([]);
    });
  });

  it('an incomplete chain does not stop the evaluation (browsers accept it)', () => {
    const r = runCheck(
      hdr01,
      snap([start(GOOD, { tlsAuthorized: false, tlsAuthorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })]),
    );
    expect(r.status).toBe('completed');
  });

  it('no start document in the section → error (collector contract broken)', () => {
    const r = runCheck(hdr01, snap([]));
    expect(r).toMatchObject({ status: 'error', reason: 'exception' });
  });

  it('http collector skipped → check skipped with that reason', () => {
    const s = makeSnapshot({
      collection: { http: { status: 'skipped', reason: 'not-implemented', durationMs: 0 } },
    });
    expect(runCheck(hdr01, s)).toMatchObject({ status: 'skipped', reason: 'not-implemented' });
  });
});
