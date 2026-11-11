import { describe, expect, it } from 'vitest';
import { hdr02 } from '../../../../src/checks/http/hdr-02.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../src/core/data/messages.ts';
import { storedHeaderRecord } from '../../../../src/core/redaction/headers.ts';
import type { DocumentResponse } from '../../../../src/core/snapshot/http.ts';
import type { HeaderRecord } from '../../../../src/core/snapshot/index.ts';
import { sanitizeUrl } from '../../../../src/core/url/url.ts';
import {
  makeDocumentResponse,
  makeHttp,
  makeSnapshot,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';

const START = 'https://www.example.test/';
const IMPRESSUM = 'https://www.example.test/impressum';
const PRIVACY = 'https://www.example.test/datenschutz';

/** A header as the collector stores it. */
const header = (name: string, value: string): HeaderRecord =>
  storedHeaderRecord(name, value, START, sanitizeUrl);

const doc = (
  role: DocumentResponse['role'],
  url: string,
  headers: HeaderRecord[],
  p: Partial<DocumentResponse> = {},
) => makeDocumentResponse({ role, url, headers, ...p });

/** The stored value of a header evidence entry. */
const storedValue = (e: unknown): unknown => (e as { value?: unknown } | undefined)?.value;

const run = (documents: DocumentResponse[], extra: Parameters<typeof makeHttp>[0] = {}) =>
  runCheck(hdr02, makeSnapshot({ http: makeHttp({ documents, ...extra }) }));

const blocked = (url: string) => ({
  status: 403,
  error: { code: 'blocked', message: 'cloudflare: header:cf-mitigated', phase: 'http' as const, url },
});

describe('HDR-02 version headers', () => {
  it('the same product and version on two pages is one observation with both pages', () => {
    const r = run([
      doc('start', START, [header('x-powered-by', 'PHP/7.2.34'), header('server', 'nginx')]),
      doc('impressum', IMPRESSUM, [header('x-powered-by', 'PHP/7.2.34')]),
      doc('privacy', PRIVACY, [header('server', 'nginx')]),
    ]);

    expect(r.status).toBe('completed');
    expect(observationsOf(r)).toEqual([
      {
        checkId: 'HDR-02',
        variant: 'version-header',
        confidence: 'high',
        subject: 'x-powered-by|php/7.2.34',
        phases: ['http'],
        pages: [START, IMPRESSUM],
        evidence: [START, IMPRESSUM].map((url) => ({
          type: 'header',
          phase: 'http',
          page: url,
          url,
          name: 'x-powered-by',
          present: true,
          value: 'PHP/7.2.34',
        })),
        params: { url: START, count: 2, header: 'X-Powered-By', product: 'PHP', version: '7.2.34' },
      },
    ]);
    expect(r.outcome?.coverage).toEqual({ planned: 3, evaluated: 3 });
  });

  it('every pair of a header is its own observation; the comment is not part of any', () => {
    const r = run([doc('start', START, [header('server', 'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1f')])]);

    expect(observationsOf(r).map((o) => [o.subject, o.params.header, storedValue(o.evidence[0])])).toEqual([
      ['server|apache/2.4.41', 'Server', 'Apache/2.4.41'],
      ['server|openssl/1.1.1f', 'Server', 'OpenSSL/1.1.1f'],
    ]);
    expect(JSON.stringify(r.outcome)).not.toContain('Ubuntu');
  });

  it('two versions of one product on different pages stay apart', () => {
    const r = run([
      doc('start', START, [header('x-powered-by', 'PHP/7.2.34')]),
      doc('impressum', IMPRESSUM, [header('x-powered-by', 'PHP/8.2.1')]),
    ]);

    expect(observationsOf(r).map((o) => [o.subject, o.pages])).toEqual([
      ['x-powered-by|php/7.2.34', [START]],
      ['x-powered-by|php/8.2.1', [IMPRESSUM]],
    ]);
  });

  it('a header that implies the product shows the version as sent', () => {
    const r = run([doc('start', START, [header('x-aspnet-version', '4.0.30319')])]);

    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'x-aspnet-version|asp.net/4.0.30319',
      params: { header: 'X-AspNet-Version', product: 'ASP.NET', version: '4.0.30319' },
      evidence: [{ name: 'x-aspnet-version', value: '4.0.30319' }],
    });
  });

  it('the header of an error page names the version too', () => {
    const r = run([doc('start', START, [header('server', 'Apache/2.4.41')], { status: 404 })]);
    expect(variantsOf(r)).toEqual(['version-header']);
  });

  it('clean: a product without a version and no other product header', () => {
    const r = run([doc('start', START, [header('server', 'nginx'), header('x-redirect-by', 'WordPress')])]);
    expect(r.status).toBe('completed');
    expect(observationsOf(r)).toEqual([]);
  });

  it('clean: an older snapshot without any product header (the names are stored, so absence is known)', () => {
    const r = run([doc('start', START, [{ name: 'content-type', value: 'text/html' }])]);
    expect(r.status).toBe('completed');
  });

  it('a page whose product facts are missing limits the result, the others still count', () => {
    const r = run([
      doc('start', START, [header('x-powered-by', 'PHP/7.2.34')]),
      doc('impressum', IMPRESSUM, [{ name: 'x-powered-by', value: '[redacted]' }]),
    ]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['values-not-stored']);
    expect(variantsOf(r)).toEqual(['version-header']);
  });

  it('a challenge instead of the start page: inconclusive, its headers are the protection’s', () => {
    const r = run([doc('start', START, [header('server', 'cloudflare/1.0')], blocked(START))]);
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'blocked' });
    expect(r.outcome?.limitations).toEqual(['status:403']);
  });

  it('counterexample: product facts on a challenged subpage are not read', () => {
    const r = run([
      doc('start', START, [header('server', 'nginx')]),
      doc('impressum', IMPRESSUM, [header('x-powered-by', 'PHP/7.2.34')], blocked(IMPRESSUM)),
    ]);
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['document-blocked:impressum']);
    expect(observationsOf(r)).toEqual([]);
    expect(r.outcome?.coverage).toEqual({ planned: 2, evaluated: 1 });
  });

  it.each([
    ['timeout', 'timeout'],
    ['ECONNRESET', 'start-page-unavailable'],
  ])('a start page that did not answer (%s): inconclusive %s', (code, reason) => {
    const r = run([doc('start', START, [], { status: null, error: { code, message: code, phase: 'http' } })]);
    expect(r).toMatchObject({ status: 'inconclusive', reason });
  });

  it('a subpage that did not answer and a throttled host limit the result', () => {
    const r = run(
      [
        doc('start', START, [header('x-powered-by', 'PHP/7.2.34')]),
        doc('privacy', PRIVACY, [], {
          status: null,
          error: { code: 'timeout', message: 't', phase: 'http' },
        }),
      ],
      { throttled: true },
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['document-unavailable:privacy', 'throttled']);
    expect(variantsOf(r)).toEqual(['version-header']);
  });

  it.each(['de', 'en'] as const)('%s: the text names header, product and version as a fact', (lang) => {
    const r = run([
      doc('start', START, [header('x-powered-by', 'PHP/7.2.34')]),
      doc('impressum', IMPRESSUM, [header('x-powered-by', 'PHP/7.2.34')]),
    ]);
    const o = observationsOf(r)[0];
    const m = renderMessage(loadTexts(lang), 'HDR-02.version-header', o?.params ?? {});

    expect(m.title).toContain('X-Powered-By');
    expect(m.body).toContain('X-Powered-By');
    expect(m.body).toContain('PHP');
    expect(m.body).toContain('7.2.34');
    expect(m.body).toContain(START);
    expect(m.body).toMatch(lang === 'de' ? /2 Seiten/ : /2 pages/);
    expect(`${m.title} ${m.body}`).not.toMatch(/[{}]|CVE|\bEOL\b/);
  });
});
