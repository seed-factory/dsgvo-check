import { describe, expect, it } from 'vitest';
import { tls01 } from '../../../../src/checks/http/tls-01.ts';
import type { HttpHop, RedirectChain } from '../../../../src/core/snapshot/http.ts';
import {
  makeHttp,
  makeSnapshot,
  makeTarget,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';
import { BIG, chain, httpsOk, redirect301, snap } from './tls-01-fixtures.ts';

/** TLS-01 on the http entry of www.example.de with these hops, beside the https chain (working unless given). */
const entry = (hops: Partial<HttpHop>[], https: RedirectChain = httpsOk()) =>
  runCheck(tls01, snap(chain('http://www.example.de/', hops), https));

describe('TLS-01 http → https', () => {
  it('reports missing HTTP probe for a redirected final host', () => {
    const snapshot = makeSnapshot({
      target: makeTarget('https://www.example.de/', 'https://other.test/'),
      http: makeHttp({ chains: [redirect301(), httpsOk()] }),
    });
    const result = runCheck(tls01, snapshot);
    expect(result.status).toBe('partial');
    expect(result.outcome?.limitations).toContain('final-host-not-probed');
  });

  it('distinguishes an off-host HTTPS first hop from an HTTP first hop', () => {
    const offHost = runCheck(tls01, snap(redirect301('www.example.de', 'https://other.test/'), httpsOk()));
    expect(observationsOf(offHost)[0]?.params.reason).toBe('other-host');
    const detour = chain('http://www.example.de/', [
      { status: 301, location: 'http://www.example.de/next' },
      { url: 'http://www.example.de/next', status: 301, location: 'https://www.example.de/' },
      { url: 'https://www.example.de/', status: 200 },
    ]);
    expect(observationsOf(runCheck(tls01, snap(detour, httpsOk())))[0]?.params.reason).toBe('http-first-hop');
  });

  it('violation (warning): http serves content without redirect while https works', () => {
    const r = entry([{ status: 200, bodyBytes: BIG, bodyKind: 'html' }]);
    expect(variantsOf(r)).toEqual(['no-redirect']);
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'http-entry:final',
      phases: ['http'],
      pages: ['http://www.example.de/'],
      params: { host: 'www.example.de', url: 'http://www.example.de/' },
    });
    expect(observationsOf(r)[0]?.evidence[0]).toMatchObject({ type: 'redirect-chain', outcome: 'ok' });
  });

  it.each([
    ['connection-refused', 'unavailable'],
    ['dns-error', 'unavailable'],
    ['tls-error', 'invalid'],
  ] as const)('violation (critical): http content and https %s', (outcome, reason) => {
    const https = chain('https://www.example.de/', [], { outcome, error: { code: 'X', message: 'x' } });
    const r = entry([{ status: 200, bodyBytes: BIG }], https);
    expect(variantsOf(r)).toEqual(['https-unavailable']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason, downgrade: 'no' });
  });

  it('violation (critical): https answers with an invalid certificate (expired)', () => {
    const https = chain('https://www.example.de/', [
      { status: 200, tlsAuthorized: false, tlsAuthorizationError: 'CERT_HAS_EXPIRED' },
    ]);
    const r = entry([{ status: 200, bodyBytes: BIG }], https);
    expect(variantsOf(r)).toEqual(['https-unavailable']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'invalid' });
  });

  it('an incomplete chain on https counts as working https (browsers complete it)', () => {
    const https = chain('https://www.example.de/', [
      { status: 200, tlsAuthorized: false, tlsAuthorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    ]);
    expect(variantsOf(entry([{ status: 200, bodyBytes: BIG }], https))).toEqual(['no-redirect']);
  });

  it('violation (critical): form on an http page', () => {
    const r = entry([{ status: 200, bodyBytes: BIG, hasForm: true }]);
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
    expect(observationsOf(r).find((o) => o.variant === 'form-on-http-page')?.subject).toBe(
      'http-entry:final',
    );
  });

  it('violation (warning): redirect only via meta refresh / JS', () => {
    const r = entry([
      { status: 200, bodyBytes: 300, clientRedirect: { kind: 'meta', url: 'https://www.example.de/' } },
    ]);
    expect(variantsOf(r)).toEqual(['client-side-redirect-only']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ kind: 'meta' });
  });

  it.each([
    [
      'a client redirect to http is not an upgrade (content served over http)',
      { status: 200, bodyBytes: BIG, clientRedirect: { kind: 'js', url: 'http://www.example.de/home' } },
      ['no-redirect'],
    ],
    ['counterexample: a stub of ≤ 1 KiB on http gives no finding', { status: 200, bodyBytes: 512 }, []],
    [
      'a cut body with ≤ 1 KiB read is not a stub (its real size is unknown)',
      { status: 200, bodyBytes: 512, bodyTruncated: true },
      ['no-redirect'],
    ],
    ['http error status (404) is not content', { status: 404, bodyBytes: BIG }, []],
  ] as const)('%s', (_label, hop, variants) => {
    expect(variantsOf(entry([hop]))).toEqual(variants);
  });

  it('info: 301 to https on another host (first hop off-host)', () => {
    const r = runCheck(
      tls01,
      snap(redirect301('example.de', 'https://www.example.de/', 'apex'), redirect301(), httpsOk()),
    );
    expect(variantsOf(r)).toEqual(['redirect-chain-detail']);
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'http-entry:pair',
      params: { host: 'example.de', location: 'https://www.example.de/' },
    });
  });

  it('info: first hop stays on http, https is reached later', () => {
    const c = chain('http://www.example.de/', [
      { status: 301, location: 'http://www.example.de/de/' },
      { url: 'http://www.example.de/de/', status: 301, location: 'https://www.example.de/de/' },
      { url: 'https://www.example.de/de/', status: 200 },
    ]);
    expect(variantsOf(runCheck(tls01, snap(c, httpsOk())))).toEqual(['redirect-chain-detail']);
  });

  it('http → http redirect ending in content is evaluated like no redirect', () => {
    const r = entry([
      { status: 302, location: 'http://www.example.de/start' },
      { url: 'http://www.example.de/start', status: 200, bodyBytes: BIG },
    ]);
    expect(variantsOf(r)).toEqual(['no-redirect']);
    expect(observationsOf(r)[0]?.pages).toEqual(['http://www.example.de/start']);
  });

  describe('apex and www that end on the same http page', () => {
    const page = 'http://www.example.de/';
    const content = { url: page, status: 200, bodyBytes: BIG, bodyKind: 'html' as const };
    const apexToWww = (last: Partial<HttpHop> = {}) =>
      chain(
        'http://example.de/',
        [
          { status: 301, location: page },
          { ...content, ...last },
        ],
        {
          hostVariant: 'apex',
        },
      );
    const www = (last: Partial<HttpHop> = {}) =>
      chain(page, [{ ...content, ...last }], { hostVariant: 'target' });
    const httpsApex = chain(
      'https://example.de/',
      [
        { status: 301, location: 'https://www.example.de/' },
        { url: 'https://www.example.de/', status: 200, tlsAuthorized: true },
      ],
      { hostVariant: 'apex' },
    );

    it('no-redirect of each entry names the address typed and the page it ends on', () => {
      const r = runCheck(tls01, snap(www(), httpsOk(), apexToWww(), httpsApex));
      const params = observationsOf(r)
        .filter((o) => o.variant === 'no-redirect')
        .map((o) => o.params);
      expect(params).toEqual([
        { host: 'www.example.de', url: page, page, redirected: 'no', downgrade: 'no' },
        { host: 'example.de', url: 'http://example.de/', page, redirected: 'yes', downgrade: 'no' },
      ]);
    });

    it('a form on that page is one finding, reported for the first entry', () => {
      const r = runCheck(
        tls01,
        snap(www({ hasForm: true }), httpsOk(), apexToWww({ hasForm: true }), httpsApex),
      );
      const forms = observationsOf(r).filter((o) => o.variant === 'form-on-http-page');
      expect(forms).toHaveLength(1);
      expect(forms[0]).toMatchObject({ pages: [page], params: { host: 'www.example.de', url: page } });
    });
  });

  describe('a chain that reaches https and returns to http is evaluated on its final http page', () => {
    const downgrade = (last: Partial<HttpHop>) =>
      chain('http://www.example.de/', [
        { status: 301, location: 'https://www.example.de/' },
        {
          url: 'https://www.example.de/',
          status: 302,
          location: 'http://www.example.de/form',
          tlsAuthorized: true,
        },
        { url: 'http://www.example.de/form', status: 200, bodyBytes: BIG, ...last },
      ]);

    it('http → https (same host) → http 200 with a form → form-on-http-page and no-redirect', () => {
      const r = runCheck(tls01, snap(downgrade({ hasForm: true }), httpsOk()));
      expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
      const form = observationsOf(r).find((o) => o.variant === 'form-on-http-page');
      expect(form).toMatchObject({
        pages: ['http://www.example.de/form'],
        params: { url: 'http://www.example.de/form', downgrade: 'yes' },
      });
    });

    it('downgrade without a form → no-redirect on the final http page', () => {
      const r = runCheck(tls01, snap(downgrade({}), httpsOk()));
      expect(variantsOf(r)).toEqual(['no-redirect']);
      expect(observationsOf(r)[0]?.params).toMatchObject({ downgrade: 'yes' });
    });

    it('the https hop of the downgrade chain proves working https when the https chain is undecided', () => {
      const https = chain('https://www.example.de/', [], { outcome: 'timeout' });
      expect(variantsOf(runCheck(tls01, snap(downgrade({}), https)))).toEqual(['no-redirect']);
    });

    it('downgrade to a stub page ≤ 1 KiB → no finding', () => {
      expect(variantsOf(runCheck(tls01, snap(downgrade({ bodyBytes: 300 }), httpsOk())))).toEqual([]);
    });

    it('http → https → https 200 stays clean (the chain ends on https)', () => {
      const c = chain('http://www.example.de/', [
        { status: 301, location: 'https://www.example.de/' },
        { url: 'https://www.example.de/', status: 302, location: 'https://www.example.de/de/' },
        { url: 'https://www.example.de/de/', status: 200 },
      ]);
      expect(variantsOf(runCheck(tls01, snap(c, httpsOk())))).toEqual([]);
    });
  });

  it('www / apex without DNS are ignored', () => {
    const www = chain('http://www.example.de/', [], { hostVariant: 'www', outcome: 'dns-error' });
    const r = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('https://example.de/'),
        http: makeHttp({ chains: [redirect301('example.de'), httpsOk('example.de'), www] }),
      }),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('inconclusive: http content while https timed out (cannot tell critical from warning)', () => {
    const r = entry(
      [{ status: 200, bodyBytes: BIG }],
      chain('https://www.example.de/', [], { outcome: 'timeout' }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'timeout' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('partial: a non-target host variant timed out', () => {
    const apex = chain('http://example.de/', [], { hostVariant: 'apex', outcome: 'timeout' });
    const r = runCheck(tls01, snap(redirect301(), httpsOk(), apex));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['undecided:apex']);
  });

  it('error: the target http chain is missing (collector contract broken)', () => {
    expect(runCheck(tls01, snap(httpsOk()))).toMatchObject({ status: 'error', reason: 'exception' });
  });
});

describe('TLS-01 subject by host role, independent of how the target was typed (5.4)', () => {
  const noRedirect = (host: string, hv: 'target' | 'www' | 'apex') =>
    chain(`http://${host}/`, [{ status: 200, bodyBytes: BIG, bodyKind: 'html' }], { hostVariant: hv });

  it('the http entry of www.example.de is `http-entry:final` whether example.de or www.example.de was typed', () => {
    const viaApex = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('http://example.de/', 'https://www.example.de/'),
        http: makeHttp({
          chains: [
            redirect301('example.de', 'https://www.example.de/', 'target'),
            noRedirect('www.example.de', 'www'),
            httpsOk('www.example.de', 'www'),
          ],
        }),
      }),
    );
    const direct = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('http://www.example.de/', 'https://www.example.de/'),
        http: makeHttp({ chains: [noRedirect('www.example.de', 'target'), httpsOk()] }),
      }),
    );
    const subjectOf = (r: ReturnType<typeof runCheck>, variant: string) =>
      observationsOf(r).find((o) => o.variant === variant)?.subject;
    expect(subjectOf(viaApex, 'no-redirect')).toBe('http-entry:final');
    expect(subjectOf(direct, 'no-redirect')).toBe('http-entry:final');
    expect(subjectOf(viaApex, 'redirect-chain-detail')).toBe('http-entry:pair');
  });
});
