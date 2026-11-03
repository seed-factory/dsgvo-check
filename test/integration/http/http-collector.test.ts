/** The HTTP collector against local HTTP/HTTPS servers (test PKI), followed by the pure checks on its section. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hdr01 } from '../../../src/checks/http/hdr-01.ts';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { tls02 } from '../../../src/checks/http/tls-02.ts';
import { MAX_DECODED_BYTES } from '../../../src/collectors/http/client.ts';
import { createHttpCollector } from '../../../src/collectors/http/index.ts';
import { createTlsCollector } from '../../../src/collectors/tls/index.ts';
import { uaToken } from '../../../src/core/runtime/user-agent.ts';
import type { CollectorContext } from '../../../src/core/snapshot/collector.ts';
import type { HttpSection } from '../../../src/core/snapshot/http.ts';
import type { TlsSection } from '../../../src/core/snapshot/tls.ts';
import type { NetworkConfig } from '../../../src/core/url/net.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { makeSnapshot, makeTarget, runCheck, variantsOf } from '../../utils/snapshot-builder.ts';
import { closedPort, collectorContext, httpProxy, silentServer, withRoutes } from './helpers.ts';
import { ALL_ROUTES } from './sites.ts';

let server: FixtureServer;
let closed: number;
const fast = createHttpCollector({ minIntervalMs: 20 });
/** Production pacing: at most 2 requests per second to one host. */
const PACER_INTERVAL_MS = 500;
const START_JITTER_MS = 50;

beforeAll(async () => {
  server = await startFixtureServer({
    routes: ALL_ROUTES,
    tls: { 'www.expired.test': 'expired', 'www.moved.test': 'expired', 'shop.sib.test': 'expired' },
  });
  closed = await closedPort();
});

afterAll(async () => {
  await server?.close();
});

async function collect(
  url: string,
  routes: Record<string, number> = {},
  collector = fast,
  ctx: Partial<CollectorContext> = {},
) {
  const res = await collector(collectorContext(url, withRoutes(server.network(), routes), ctx));
  return res;
}

const evaluate = (url: string, http: HttpSection) => {
  const snapshot = makeSnapshot({ target: makeTarget(url), http });
  return { hdr: runCheck(hdr01, snapshot), tls: runCheck(tls01, snapshot) };
};

describe('HTTP collector: http → https redirect site', () => {
  it('records chains for target and apex, documents, TLS facts; UA token only; no cookies sent', async () => {
    server.reset();
    // The client calls `now` once per request, right after the pacer released it: the start of every request.
    const starts: number[] = [];
    const now = () => {
      const d = new Date();
      starts.push(d.getTime());
      return d;
    };
    const t0 = Date.now();
    const res = await collect('https://www.redirect.test/', {}, createHttpCollector(), { now });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe('ok');
    expect(res.fatal).toBeUndefined();
    const http = res.sections.http as HttpSection;

    expect(http.chains.map((c) => `${c.hostVariant}/${c.scheme}:${c.outcome}`).sort()).toEqual([
      'apex/http:ok',
      'apex/https:ok',
      'target/http:ok',
      'target/https:ok',
    ]);
    const targetHttp = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http');
    expect(targetHttp?.hops.map((h) => [h.url, h.status, h.location ?? null])).toEqual([
      ['http://www.redirect.test/', 301, 'https://www.redirect.test/'],
      ['https://www.redirect.test/', 200, null],
    ]);
    const final = targetHttp?.final;
    expect(final).toMatchObject({
      connectedIp: '127.0.0.1',
      tlsAuthorized: true,
      tlsAuthorizationError: null,
      tlsProtocol: 'TLSv1.3',
      bodyKind: 'html',
      setCookieNames: ['sid'],
    });
    expect(JSON.stringify(http)).not.toContain('fixture-secret');

    expect(http.documents.map((d) => [d.role, d.finalUrl, d.status])).toEqual([
      ['start', 'https://www.redirect.test/', 200],
      ['impressum', 'https://www.redirect.test/impressum', 200],
      ['privacy', 'https://www.redirect.test/datenschutz', 200],
    ]);
    expect(res.probes?.length).toBe(6);

    // Only the honest UA token is sent; cookie values never go back to the server.
    expect(new Set(server.requests.map((r) => r.userAgent))).toEqual(new Set([uaToken()]));
    expect(server.requests.every((r) => r.cookieNames.length === 0)).toBe(true);
    expect(server.unexpected).toEqual([]);

    // Each URL is requested once per scan (the four chains share https://www.redirect.test).
    const paths = server.requests.map((r) => `${r.scheme}://${r.host}${r.path}`);
    expect(paths.sort()).toEqual([
      'http://redirect.test/',
      'http://www.redirect.test/',
      'https://redirect.test/',
      'https://www.redirect.test/',
      'https://www.redirect.test/datenschutz',
      'https://www.redirect.test/impressum',
    ]);
    // ≤ 2 requests per second per host: starts to www.redirect.test are ≥ 500 ms apart. Measured at the client, where the
    // pacer acts (server arrival trails the start by TLS handshakes and machine load). The exact rule is tested with a
    // virtual clock in test/unit/checks/http/collector-client.test.ts; `START_JITTER_MS` covers descheduling and GC.
    const apexStarts = new Set(
      http.chains
        .flatMap((c) => c.hops)
        .filter((h) => new URL(h.url).hostname === 'redirect.test')
        .map((h) => Date.parse(h.requestedAt)),
    );
    const wwwStarts = [...starts];
    for (const t of apexStarts) wwwStarts.splice(wwwStarts.indexOf(t), 1);
    wwwStarts.sort((a, b) => a - b);
    expect(starts.length).toBe(6);
    expect(wwwStarts.length).toBe(4);
    for (let i = 1; i < wwwStarts.length; i++)
      expect((wwwStarts[i] as number) - (wwwStarts[i - 1] as number)).toBeGreaterThanOrEqual(
        PACER_INTERVAL_MS - START_JITTER_MS,
      );
    // Arrival at the server: wider, only to show that the requests are spread out and not bunched.
    const www = server.requestsTo('www.redirect.test').map((r) => r.at);
    expect(www.length).toBe(4);
    for (let i = 1; i < www.length; i++)
      expect((www[i] as number) - (www[i - 1] as number)).toBeGreaterThanOrEqual(PACER_INTERVAL_MS / 2);
    expect(elapsed).toBeGreaterThanOrEqual(3 * PACER_INTERVAL_MS - START_JITTER_MS);
    expect(http.requestsIssued).toBe(server.requests.length);

    const { hdr, tls } = evaluate('https://www.redirect.test/', http);
    expect(hdr.status).toBe('completed');
    expect(variantsOf(hdr)).toEqual(['header-missing']);
    expect(hdr.outcome?.observations[0]?.subject).toBe('x-content-type-options');
    expect(hdr.outcome?.observations[0]?.pages).toEqual(['https://www.redirect.test/impressum']);
    expect(variantsOf(tls)).toEqual(['redirect-chain-detail']);
  });
});

describe('HTTP collector: problem sites', () => {
  it('http without redirect and a form on the http page', async () => {
    const res = await collect('https://www.plain.test/', { 'plain.test': closed });
    const http = res.sections.http as HttpSection;
    const httpHop = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http')?.final;
    expect(httpHop).toMatchObject({ status: 200, hasForm: true, bodyKind: 'html' });
    expect(httpHop?.clientRedirect).toBeUndefined();
    expect(http.chains.find((c) => c.hostVariant === 'apex')?.outcome).toBe('connection-refused');
    expect(variantsOf(evaluate('https://www.plain.test/', http).tls)).toEqual([
      'form-on-http-page',
      'no-redirect',
    ]);
    expect(server.unexpected).toEqual([]);
  });

  it('http content while port 443 is closed → TLS-01 https-unavailable (critical)', async () => {
    const res = await collect('http://www.httponly.test/', {
      'www.httponly.test:443': closed,
      'httponly.test': closed,
    });
    expect(res.fatal).toBeUndefined();
    const http = res.sections.http as HttpSection;
    const https = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'https');
    expect(https).toMatchObject({ outcome: 'connection-refused', hops: [] });
    expect(https?.error?.code).toBe('ECONNREFUSED');
    const { tls, hdr } = evaluate('http://www.httponly.test/', http);
    expect(variantsOf(tls)).toEqual(['https-unavailable']);
    expect(tls.outcome?.observations[0]?.params).toMatchObject({ reason: 'unavailable' });
    // start document is the http page: HSTS is not evaluated on http.
    expect(variantsOf(hdr)).not.toContain('hsts-missing');
  });

  it('https with an expired certificate: request still made, Node verdict recorded', async () => {
    const res = await collect('https://www.expired.test/', { 'expired.test': closed });
    const http = res.sections.http as HttpSection;
    const https = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'https');
    expect(https?.final).toMatchObject({
      status: 200,
      tlsAuthorized: false,
      tlsAuthorizationError: 'CERT_HAS_EXPIRED',
    });
    const { tls, hdr } = evaluate('https://www.expired.test/', http);
    expect(variantsOf(tls)).toEqual(['https-unavailable']);
    expect(tls.outcome?.observations[0]?.params).toMatchObject({ reason: 'invalid' });
    expect(hdr).toMatchObject({ status: 'inconclusive', reason: 'tls-invalid' });
  });

  it('meta refresh to https on a small http page → client-side-redirect-only', async () => {
    const res = await collect('https://www.meta.test/', { 'meta.test': closed });
    const http = res.sections.http as HttpSection;
    const hop = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http')?.final;
    expect(hop?.clientRedirect).toEqual({ kind: 'meta', url: 'https://www.meta.test/' });
    expect(variantsOf(evaluate('https://www.meta.test/', http).tls)).toEqual(['client-side-redirect-only']);
  });

  it('redirect loop stops after 5 redirects', async () => {
    const res = await collect('https://www.loop.test/', { 'loop.test': closed });
    const chain = (res.sections.http as HttpSection).chains.find(
      (c) => c.hostVariant === 'target' && c.scheme === 'http',
    );
    expect(chain?.outcome).toBe('redirect-limit');
    expect(chain?.hops).toHaveLength(6);
  });

  it('three 429 of one host → Retry-After pause, one retry, then that host only is stopped', async () => {
    server.reset();
    const seen = new Set<string>();
    const retriedRequest = Promise.withResolvers<void>();
    server.addHandler({
      host: 'busy.test',
      path: /.*/,
      handle: async (_req, response, ctx) => {
        const key = `${ctx.scheme}:${ctx.url.pathname}`;
        const repeated = seen.has(key);
        seen.add(key);
        if (repeated) retriedRequest.resolve();
        if (!repeated && seen.size === 4) {
          // A concurrent fourth response could stop the host before the paused retry starts; let the retry arrive first.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              retriedRequest.promise,
              new Promise<void>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('The overload retry was not requested')), 5_000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        response.writeHead(429, { 'retry-after': '60' });
        response.end();
      },
    });
    const collector = createHttpCollector({ minIntervalMs: 20, maxRetryAfterMs: 300 });
    const res = await collect('https://busy.test/', {}, collector);
    const http = res.sections.http as HttpSection;
    expect(http.throttled).toBe(true);
    expect(http.throttledHosts).toEqual(['busy.test']);
    expect(res.status).toBe('partial');
    expect(res.diagnostics).toEqual([{ code: 'SCAN-THROTTLED', affects: ['HDR-01', 'TLS-01'] }]);

    // The third 429 of busy.test is retried once, after the (capped) Retry-After pause.
    const busy = server.requestsTo('busy.test');
    const urls = busy.map((r) => `${r.scheme}://${r.host}${r.path}`);
    const retried = urls.filter((u, i) => urls.indexOf(u) !== i);
    expect(retried).toHaveLength(1);
    const first = busy[urls.indexOf(retried[0] as string)]?.at as number;
    const again = busy[urls.lastIndexOf(retried[0] as string)]?.at as number;
    expect(again - first).toBeGreaterThanOrEqual(280);
    // After the failed retry no new request goes to busy.test: 3 + 1 retry (+ ≤ 1 already in flight).
    expect(busy.length).toBeLessThanOrEqual(5);
    // The healthy host is not affected by the other host's 429 (and does not reset its counter).
    expect(server.requestsTo('www.busy.test')).toHaveLength(2);
    expect(
      http.chains.filter((c) => c.host === 'www.busy.test').every((c) => c.hops[0]?.status === 301),
    ).toBe(true);
    expect(http.requestsIssued).toBe(server.requests.length);
  });

  it('a gzip bomb is decoded only up to the cap and marked truncated', async () => {
    const MiB = 1024 * 1024;
    const bomb = zlib.gzipSync(Buffer.alloc(64 * MiB, 0x20));
    const local = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()));
    const port = (local.address() as AddressInfo).port;
    try {
      const res = await collect('http://www.bomb.test/', {
        'www.bomb.test:80': port,
        'www.bomb.test:443': closed,
        'bomb.test': closed,
      });
      const hop = (res.sections.http as HttpSection).chains.find(
        (c) => c.hostVariant === 'target' && c.scheme === 'http',
      )?.final;
      expect(hop?.status).toBe(200);
      expect(hop?.bodyBytes).toBe(MAX_DECODED_BYTES);
      expect(hop?.bodyTruncated).toBe(true);
    } finally {
      await new Promise<void>((r) => local.close(() => r()));
    }
  });

  it('both ports of the target closed → fatal unreachable', async () => {
    const res = await collect('https://www.down.test/', { 'www.down.test': closed, 'down.test': closed });
    expect(res.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
    expect(res.sections.http?.chains.every((c) => c.outcome === 'connection-refused')).toBe(true);
  });

  it('a server that never answers → timeout outcome, TLS-01 inconclusive', async () => {
    const silent = await silentServer();
    try {
      const collector = createHttpCollector({
        minIntervalMs: 20,
        timeouts: { connectMs: 1_000, headersMs: 500, bodyMs: 500, requestMs: 1_500 },
      });
      const res = await collect(
        'https://www.slow.test/',
        { 'www.slow.test': silent.port, 'slow.test': closed },
        collector,
      );
      const http = res.sections.http as HttpSection;
      const chain = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http');
      expect(chain?.outcome).toBe('timeout');
      expect(res.fatal).toMatchObject({ reason: 'unreachable' });
      expect(
        runCheck(tls01, makeSnapshot({ target: makeTarget('https://www.slow.test/'), http })),
      ).toMatchObject({
        status: 'inconclusive',
        reason: 'timeout',
      });
    } finally {
      await silent.close();
    }
  });

  it('the scan deadline aborts promptly', async () => {
    const silent = await silentServer();
    try {
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(new Error('scan timeout')), 300);
      const res = await createHttpCollector({ minIntervalMs: 20 })(
        collectorContext(
          'https://www.slow.test/',
          withRoutes(server.network(), { 'www.slow.test': silent.port, 'slow.test': closed }),
          { signal: ac.signal },
        ),
      );
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(res.status).toBe('partial');
      expect(res.fatal).toBeUndefined();
    } finally {
      await silent.close();
    }
  });
});

describe('HTTP collector: explicit target port', () => {
  it('the start document is fetched from the origin with its port; standard ports stay separate probes', async () => {
    server.reset();
    const res = await collect('https://www.port.test:8443/', {
      'www.port.test:8443': server.httpsPort,
      'www.port.test:80': closed,
      'www.port.test:443': closed,
      'port.test': closed,
    });
    expect(res.fatal).toBeUndefined();
    const http = res.sections.http as HttpSection;
    const start = http.documents.find((d) => d.role === 'start');
    expect(start).toMatchObject({
      url: 'https://www.port.test:8443/',
      finalUrl: 'https://www.port.test:8443/',
      status: 200,
    });
    expect(start?.error).toBeUndefined();
    // The legal pages linked from the start page are found on the same origin (port kept).
    expect(http.documents.map((d) => d.finalUrl)).toEqual([
      'https://www.port.test:8443/',
      'https://www.port.test:8443/impressum',
      'https://www.port.test:8443/datenschutz',
    ]);
    const origin = http.chains.find((c) => c.port === 8443);
    expect(origin).toMatchObject({ hostVariant: 'target', scheme: 'https', outcome: 'ok' });
    // Standard http/https probes of the host are kept for TLS-01 (ports closed here: no finding).
    const standard = http.chains.filter((c) => c.hostVariant === 'target' && c.port === undefined);
    expect(standard.map((c) => `${c.scheme}:${c.outcome}`).sort()).toEqual([
      'http:connection-refused',
      'https:connection-refused',
    ]);
    expect(variantsOf(evaluate('https://www.port.test:8443/', http).tls)).toEqual([]);
    expect(server.unexpected).toEqual([]);
  });

  it('origin port closed → fatal unreachable (even though nothing else answers either)', async () => {
    const res = await collect('https://www.port.test:8443/', {
      'www.port.test:8443': closed,
      'www.port.test:80': closed,
      'www.port.test:443': closed,
      'port.test': closed,
    });
    expect(res.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
  });
});

describe('HTTP collector: final host on another domain', () => {
  it('records the TLS endpoints of the final host and its www/apex; TLS-02 reports the expired certificate', async () => {
    server.reset();
    const routes = { 'origin.test': closed, 'moved.test': closed };
    const res = await collect('https://www.origin.test/', routes);
    const http = res.sections.http as HttpSection;
    expect(http.documents[0]).toMatchObject({
      role: 'start',
      finalUrl: 'https://www.moved.test/',
      status: 200,
    });
    expect(http.finalTls?.map((e) => `${e.role}/${e.hostVariant}:${e.host}:${e.outcome}`)).toEqual([
      'final/target:www.moved.test:handshake',
      'final/apex:moved.test:connection-refused',
    ]);
    expect(http.finalTls?.[0]).toMatchObject({
      authorized: false,
      authorizationError: 'CERT_HAS_EXPIRED',
      port: 443,
    });
    expect(res.probes?.filter((p) => p.kind === 'tls').map((p) => `${p.target} ${p.purpose}`)).toEqual([
      'www.moved.test:443 certificate',
      'moved.test:443 certificate',
    ]);

    const tls = await createTlsCollector({ timeoutMs: 3_000 })(
      collectorContext('https://www.origin.test/', withRoutes(server.network(), routes)),
    );
    const snapshot = makeSnapshot({
      target: makeTarget('https://www.origin.test/'),
      http,
      tls: tls.sections.tls as TlsSection,
    });
    // The fixture server issues its certificates relative to the real clock, so the check has to read the same clock
    // (the fixed check clock of `runCheck` would call a certificate issued tomorrow "not yet valid").
    const r = runCheck(tls02, snapshot, { now: new Date() });
    expect(r.status).toBe('completed');
    expect(r.outcome?.observations.map((o) => `${o.variant}:${o.subject}`)).toEqual([
      'certificate-invalid:certificate:final',
    ]);
    expect(server.unexpected).toEqual([]);
  });

  it("a sibling subdomain as final host is probed; its www/apex are already the TLS collector's", async () => {
    const res = await collect('https://www.sib.test/', { 'sib.test': closed });
    const http = res.sections.http as HttpSection;
    expect(http.finalTls?.map((e) => `${e.role}/${e.hostVariant}:${e.host}`)).toEqual([
      'final/target:shop.sib.test',
    ]);
    expect(http.finalTls?.[0]).toMatchObject({ authorizationError: 'CERT_HAS_EXPIRED' });
  });

  it('a redirect within target/www/apex probes nothing extra', async () => {
    const res = await collect('https://www.redirect.test/');
    expect((res.sections.http as HttpSection).finalTls).toBeUndefined();
    expect(res.probes?.every((p) => p.kind === 'http')).toBe(true);
  });
});

describe('HTTP collector without test routing', () => {
  const direct = (p: Partial<NetworkConfig>): NetworkConfig => ({
    proxy: null,
    allowPrivateAddresses: false,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    dnsServers: [],
    ...p,
  });

  it('SSRF guard: a host resolving only to loopback is not contacted', async () => {
    server.reset();
    const res = await fast(collectorContext('https://www.redirect.test/', direct({})));
    const http = res.sections.http as HttpSection;
    expect(http.chains.every((c) => c.outcome === 'error' && c.error?.code === 'private-address')).toBe(true);
    expect(server.requests).toEqual([]);
    expect(res.fatal).toBeUndefined();
  });

  it('through an HTTP proxy (TLS verdict unknown behind the proxy)', async () => {
    const proxy = await httpProxy(server.httpPort, server.httpsPort);
    try {
      const res = await fast(
        collectorContext(
          'https://www.redirect.test/',
          direct({
            proxy: proxy.url,
            lookup: async () => {
              throw new Error('lookup must not be used behind a proxy');
            },
          }),
        ),
      );
      const http = res.sections.http as HttpSection;
      const https = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'https');
      expect(https?.final).toMatchObject({ status: 200, tlsAuthorized: null, connectedIp: null });
      expect(proxy.targets).toContain('http://www.redirect.test/');
      expect(proxy.targets).toContain('www.redirect.test:443');
      expect(http.documents.map((d) => d.role)).toEqual(['start', 'impressum', 'privacy']);
    } finally {
      await proxy.close();
    }
  });
});
