import { describe, expect, it } from 'vitest';
import { hdr01 } from '../../../../src/checks/http/hdr-01.ts';
import type { DocumentResponse } from '../../../../src/collectors/http/types.ts';
import { MAX_HEADER_VALUE, storedHeaderRecord } from '../../../../src/core/headers.ts';
import type { HeaderRecord } from '../../../../src/core/snapshot.ts';
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

describe('HDR-01 security headers', () => {
  it.each(['sameorigin, SAMEORIGIN', 'SAMEORIGIN, ALLOW-FROM https://example.test'])(
    'accepts combined XFO %s',
    (value) => {
      const headers = [...without('x-frame-options'), { name: 'x-frame-options', value }];
      expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).not.toContain('anti-framing-missing');
    },
  );
  describe('X-Frame-Options ALLOWALL', () => {
    const withXfo = (value: string) => [...without('x-frame-options'), { name: 'x-frame-options', value }];
    const xfoVariants = (value: string) => variantsOf(runCheck(hdr01, snap([start(withXfo(value))])));

    it.each(['ALLOWALL', 'allowall', 'ALLOWALL, ALLOWALL'])(
      'a single ALLOWALL "%s" protects nothing',
      (value) => {
        expect(xfoVariants(value)).toEqual(['anti-framing-missing']);
      },
    );

    it.each([
      'ALLOWALL, DENY',
      'DENY, ALLOWALL',
      'ALLOWALL, SAMEORIGIN',
      'ALLOWALL, ALLOW-FROM https://example.test',
    ])('conflicting values with ALLOWALL "%s": the browser blocks the frame', (value) => {
      expect(xfoVariants(value)).toEqual([]);
    });

    it('counterexample: a list without any recognised value is no protection', () => {
      expect(xfoVariants('ALLOW-FROM https://a.example, ALLOW-FROM https://b.example')).toEqual([
        'anti-framing-missing',
      ]);
    });
  });

  it('uses only the first combined HSTS field', () => {
    const headers = [
      ...without('strict-transport-security'),
      { name: 'strict-transport-security', value: 'max-age=15768000, max-age=31536000; includeSubDomains' },
    ];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).not.toContain('hsts-missing');
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

  it('frame-ancestors in the CSP header counts as anti-framing (no X-Frame-Options needed)', () => {
    const headers = [
      ...without('x-frame-options', 'content-security-policy'),
      { name: 'content-security-policy', value: "default-src 'self'; frame-ancestors 'self'" },
    ];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).toEqual([]);
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

  it('counterexample: frame-ancestors in a report-only CSP does not count', () => {
    const headers = [
      ...without('x-frame-options'),
      { name: 'content-security-policy-report-only', value: "frame-ancestors 'none'" },
    ];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).toEqual(['anti-framing-missing']);
  });

  describe('a CSP over the stored limit', () => {
    const cut = (extra: Partial<HeaderRecord> = {}): HeaderRecord => ({
      name: 'content-security-policy',
      value: `default-src 'self'; ${'x'.repeat(2040)}`.slice(0, 2048),
      ...extra,
    });
    const run = (csp: HeaderRecord) =>
      runCheck(hdr01, snap([start([...without('x-frame-options', 'content-security-policy'), csp])]));

    it('truncated, but frame-ancestors seen in the full value: no anti-framing finding', () => {
      const r = run(
        cut({ truncated: true, frameAncestors: { present: true, restricts: true, sources: ["'self'"] } }),
      );
      expect(variantsOf(r)).toEqual([]);
      expect(r.status).toBe('completed');
    });

    it('truncated, directive absent in the full value: the finding stays (complete knowledge)', () => {
      const r = run(
        cut({ truncated: true, frameAncestors: { present: false, restricts: false, sources: [] } }),
      );
      expect(variantsOf(r)).toEqual(['anti-framing-missing']);
    });

    it('truncated without facts (older snapshot): no finding, partial with a limitation', () => {
      const r = run(cut());
      expect(variantsOf(r)).toEqual([]);
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['csp-truncated']);
    });

    it('counterexample: a complete CSP without the directive still gives the finding, completed', () => {
      const r = run({ name: 'content-security-policy', value: "default-src 'self'" });
      expect(variantsOf(r)).toEqual(['anti-framing-missing']);
      expect(r.status).toBe('completed');
    });

    describe('the boundary of the limit : the record comes from the collector', () => {
      /** A CSP of exactly `length` characters without URLs, stored the way the collectors store it. */
      const stored = (length: number, tail = '') => {
        const head = "default-src 'self'; x-pad ";
        const value = head + 'a'.repeat(length - head.length - tail.length) + tail;
        return storedHeaderRecord('content-security-policy', value, 'https://www.example.test/', (u) => u);
      };

      it('exactly the limit, complete, no directive: anti-framing-missing, completed, no limitation', () => {
        const r = run(stored(MAX_HEADER_VALUE));
        expect(variantsOf(r)).toEqual(['anti-framing-missing']);
        expect(r.status).toBe('completed');
        expect(r.outcome?.limitations).toBeUndefined();
      });

      it.each([MAX_HEADER_VALUE - 1, MAX_HEADER_VALUE + 1])(
        'counterexample: %i characters without the directive give the same finding',
        (length) => {
          const r = run(stored(length));
          expect(variantsOf(r)).toEqual(['anti-framing-missing']);
          expect(r.status).toBe('completed');
        },
      );

      it('counterexample: exactly the limit with the directive at the end: no finding', () => {
        const r = run(stored(MAX_HEADER_VALUE, "; frame-ancestors 'self'"));
        expect(variantsOf(r)).toEqual([]);
        expect(r.status).toBe('completed');
      });

      it('counterexample: a record of an older snapshot at the limit without the fact stays undecided', () => {
        const old = stored(MAX_HEADER_VALUE);
        delete old.frameAncestors;
        const r = run(old);
        expect(variantsOf(r)).toEqual([]);
        expect(r.status).toBe('partial');
        expect(r.outcome?.limitations).toEqual(['csp-truncated']);
      });
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

  it('X-Frame-Options ALLOW-FROM is obsolete and does not count', () => {
    const headers = [
      ...without('x-frame-options'),
      { name: 'x-frame-options', value: 'ALLOW-FROM https://a.de' },
    ];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).toEqual(['anti-framing-missing']);
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

  it('a report-only CSP satisfies "CSP present"', () => {
    const headers = [
      ...without('content-security-policy'),
      { name: 'content-security-policy-report-only', value: "default-src 'self'" },
    ];
    expect(variantsOf(runCheck(hdr01, snap([start(headers)])))).toEqual([]);
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
  ])('HSTS "%s" has no effect → hsts-missing (%s)', (value, problem) => {
    const headers = [...without('strict-transport-security'), { name: 'strict-transport-security', value }];
    const r = runCheck(hdr01, snap([start(headers)]));
    expect(variantsOf(r)).toEqual(['hsts-missing']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ problem });
    expect(observationsOf(r)[0]?.evidence[0]).toMatchObject({ present: true, value });
  });

  describe('combined HSTS fields: the first one decides (RFC 6797 §8.1)', () => {
    const hstsRun = (value: string) =>
      runCheck(
        hdr01,
        snap([
          start([...without('strict-transport-security'), { name: 'strict-transport-security', value }]),
        ]),
      );

    it('first field max-age=0, second positive → hsts-missing (max-age-zero)', () => {
      const r = hstsRun('max-age=0, max-age=31536000');
      expect(variantsOf(r)).toEqual(['hsts-missing']);
      expect(observationsOf(r)[0]?.params).toMatchObject({ problem: 'max-age-zero' });
    });

    it('counterexample: first field positive, second max-age=0 → no finding', () => {
      expect(variantsOf(hstsRun('max-age=31536000, max-age=0'))).toEqual([]);
    });

    it('first field without max-age, second positive → hsts-missing (no-max-age)', () => {
      const r = hstsRun('includeSubDomains, max-age=31536000');
      expect(variantsOf(r)).toEqual(['hsts-missing']);
      expect(observationsOf(r)[0]?.params).toMatchObject({ problem: 'no-max-age' });
    });
  });

  it.each([
    ['unsafe-url', ['referrer-policy-permissive:referrer-policy']],
    ['no-referrer-when-downgrade', ['referrer-policy-permissive:referrer-policy']],
    ['no-referrer, unsafe-url', ['referrer-policy-permissive:referrer-policy']],
    ['unsafe-url, strict-origin', []],
    ['origin-when-cross-origin', []],
    ['bogus', ['header-missing:referrer-policy']],
  ])('Referrer-Policy "%s" → %j', (value, findings) => {
    const headers = [...without('referrer-policy'), { name: 'referrer-policy', value }];
    expect(findingsOf(runCheck(hdr01, snap([start(headers)])))).toEqual(findings);
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
    const headers = [
      ...without('x-content-type-options'),
      { name: 'x-content-type-options', value: 'sniff' },
    ];
    expect(findingsOf(runCheck(hdr01, snap([start(headers)])))).toEqual([
      'header-missing:x-content-type-options',
    ]);
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

  it('inconclusive: start page timed out', () => {
    const r = runCheck(
      hdr01,
      snap([start([], { status: null, error: { code: 'timeout', message: 'headers timeout' } })]),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'timeout' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('inconclusive: start page answered 503 (headers of an error page are not evaluated)', () => {
    const r = runCheck(hdr01, snap([start([], { status: 503 })]));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'start-page-status' });
  });

  it('inconclusive: invalid certificate on the start page (likely a hoster default page)', () => {
    const r = runCheck(
      hdr01,
      snap([start([], { tlsAuthorized: false, tlsAuthorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' })]),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'tls-invalid' });
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
