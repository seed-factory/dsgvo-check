/** The HTTP collector against local HTTP/HTTPS servers (test PKI), followed by the pure checks on its section. */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { hdr01 } from '../../../src/checks/http/hdr-01.ts';
import { hdr02 } from '../../../src/checks/http/hdr-02.ts';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { tls02 } from '../../../src/checks/http/tls-02.ts';
import { MAX_DECODED_BYTES } from '../../../src/collectors/http/body.ts';
import { createHttpCollector } from '../../../src/collectors/http/index.ts';
import { createTlsCollector } from '../../../src/collectors/tls/index.ts';
import { parseConfigInput } from '../../../src/core/config/load.ts';
import { uaToken } from '../../../src/core/runtime/user-agent.ts';
import type { CollectorContext } from '../../../src/core/snapshot/collector.ts';
import type { HostVariant, HttpSection } from '../../../src/core/snapshot/http.ts';
import type { TlsSection } from '../../../src/core/snapshot/tls.ts';
import type { NetworkConfig } from '../../../src/core/url/net.ts';
import type { FixtureServer } from '../../fixture-server/server.ts';
import { useFixtureServer } from '../../fixture-server/use-fixture-server.ts';
import {
  makeSnapshot,
  makeTarget,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../utils/snapshot-builder.ts';
import { closedPort, collectorContext, httpProxy, withRoutes, withSilentServer } from './helpers.ts';
import { ALL_ROUTES } from './sites.ts';

let closed: number;
const fast = createHttpCollector({ minIntervalMs: 20 });
/** Production pacing: at most 2 requests per second to one host. */
const PACER_INTERVAL_MS = 500;
/** Slack for descheduling and GC when request starts are compared with the pacing interval. */
const START_JITTER_MS = 50;

const server = useFixtureServer(
  () => ({
    routes: ALL_ROUTES,
    tls: { 'www.expired.test': 'expired', 'www.moved.test': 'expired', 'shop.sib.test': 'expired' },
  }),
  async () => {
    closed = await closedPort();
  },
);

async function collectFrom(context: CollectorContext, collector = fast) {
  const result = await collector(context);
  return { result, http: result.sections.http as HttpSection };
}

function collect(
  url: string,
  routes: Record<string, number> = {},
  collector = fast,
  ctx: Partial<CollectorContext> = {},
) {
  return collectFrom(collectorContext(url, withRoutes(server().network(), routes), ctx), collector);
}

type HttpResult = Awaited<ReturnType<typeof fast>>;
const closedRoutes = (...targets: string[]) => Object.fromEntries(targets.map((target) => [target, closed]));

const snapshotFor = (url: string, http: HttpSection, tls?: TlsSection) =>
  makeSnapshot({ target: makeTarget(url), http, ...(tls ? { tls } : {}) });

/** Runs the two checks that read the HTTP section on a snapshot of `url`. */
const evaluate = (url: string, http: HttpSection) => {
  const snapshot = snapshotFor(url, http);
  return { hdr: runCheck(hdr01, snapshot), tls: runCheck(tls01, snapshot) };
};

/** The redirect chain of one host variant and scheme. */
function chainOf(http: HttpSection, hostVariant: HostVariant, scheme: 'http' | 'https') {
  return http.chains.find((c) => c.hostVariant === hostVariant && c.scheme === scheme);
}

const startDocument = (http: HttpSection) => http.documents.find((doc) => doc.role === 'start');

/** Asserts that consecutive timestamps (ms) are at least `minGapMs` apart. */
function expectGapsAtLeast(times: number[], minGapMs: number) {
  for (let i = 1; i < times.length; i++) {
    expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(minGapMs);
  }
}

/** Starts of the requests to www.redirect.test: all request starts minus those that went to the apex host. */
function wwwRequestStarts(http: HttpSection, allStarts: number[]): number[] {
  const apexStarts = new Set(
    http.chains
      .flatMap((c) => c.hops)
      .filter((h) => new URL(h.url).hostname === 'redirect.test')
      .map((h) => Date.parse(h.requestedAt)),
  );
  const wwwStarts = [...allStarts];
  for (const t of apexStarts) wwwStarts.splice(wwwStarts.indexOf(t), 1);
  return wwwStarts.sort((a, b) => a - b);
}

/** Serves 64 MiB of spaces gzip-compressed: a few dozen KiB on the wire, far over the decode cap. */
async function gzipBombServer(): Promise<{ port: number; close(): Promise<void> }> {
  const MiB = 1024 * 1024;
  const bomb = zlib.gzipSync(Buffer.alloc(64 * MiB, 0x20));
  const local = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(bomb);
  });
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()));

  return {
    port: (local.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => local.close(() => r())),
  };
}

/** Rejects with `message` when `promise` is not settled within `ms`. */
async function rejectAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers every request to busy.test with 429 and `Retry-After: 60`. The fourth distinct URL waits until a retry
 * has arrived: a concurrent fourth response could stop the host before the paused retry starts.
 */
function addOverloadedHost(fixtures: FixtureServer) {
  const seen = new Set<string>();
  const retriedRequest = Promise.withResolvers<void>();

  fixtures.addHandler({
    host: 'busy.test',
    path: /.*/,
    handle: async (_req, response, ctx) => {
      const key = `${ctx.scheme}:${ctx.url.pathname}`;
      const repeated = seen.has(key);
      seen.add(key);
      if (repeated) retriedRequest.resolve();
      if (!repeated && seen.size === 4) {
        await rejectAfter(retriedRequest.promise, 5_000, 'The overload retry was not requested');
      }

      response.writeHead(429, { 'retry-after': '60' });
      response.end();
    },
  });
}

describe('HTTP collector: http → https redirect site', () => {
  const startUrl = 'https://www.redirect.test/';
  /** The client calls `now` once per request, right after the pacer released it: the start of every request. */
  const requestStarts: number[] = [];
  let result: HttpResult;
  let http: HttpSection;
  let elapsedMs: number;

  beforeAll(async () => {
    server().reset();
    const now = () => {
      const d = new Date();
      requestStarts.push(d.getTime());
      return d;
    };
    const t0 = Date.now();

    ({ result, http } = await collect(startUrl, {}, createHttpCollector(), { now }));
    elapsedMs = Date.now() - t0;
  });

  it('finishes ok and records the chains for target and apex over http and https', () => {
    expect(result.status).toBe('ok');
    expect(result.fatal).toBeUndefined();
    expect(http.chains.map((c) => `${c.hostVariant}/${c.scheme}:${c.outcome}`).sort()).toEqual([
      'apex/http:ok',
      'apex/https:ok',
      'target/http:ok',
      'target/https:ok',
    ]);
  });

  it('records the http → https hops and the TLS facts of the final response, without cookie values', () => {
    const targetHttp = chainOf(http, 'target', 'http');

    expect(targetHttp?.hops.map((h) => [h.url, h.status, h.location ?? null])).toEqual([
      ['http://www.redirect.test/', 301, 'https://www.redirect.test/'],
      ['https://www.redirect.test/', 200, null],
    ]);
    expect(targetHttp?.final).toMatchObject({
      connectedIp: '127.0.0.1',
      tlsAuthorized: true,
      tlsAuthorizationError: null,
      tlsProtocol: 'TLSv1.3',
      bodyKind: 'html',
      setCookieNames: ['sid'],
    });
    expect(JSON.stringify(http)).not.toContain('fixture-secret');
  });

  it('fetches the start page and the legal documents linked from it', () => {
    expect(http.documents.map((d) => [d.role, d.finalUrl, d.status])).toEqual([
      ['start', 'https://www.redirect.test/', 200],
      ['impressum', 'https://www.redirect.test/impressum', 200],
      ['privacy', 'https://www.redirect.test/datenschutz', 200],
    ]);
  });

  it('sends only the honest UA token and never a cookie back to the server', () => {
    expect(new Set(server().requests.map((r) => r.userAgent))).toEqual(new Set([uaToken()]));
    expect(server().requests.flatMap((r) => r.cookieNames)).toEqual([]);
    expect(server().unexpected).toEqual([]);
  });

  it('requests each URL once per scan (the four chains share https://www.redirect.test)', () => {
    const requested = server().requests.map((r) => `${r.scheme}://${r.host}${r.path}`);

    expect(requested.sort()).toEqual([
      'http://redirect.test/',
      'http://www.redirect.test/',
      'https://redirect.test/',
      'https://www.redirect.test/',
      'https://www.redirect.test/datenschutz',
      'https://www.redirect.test/impressum',
    ]);
    expect(result.probes?.length).toBe(6);
    expect(http.requestsIssued).toBe(server().requests.length);
  });

  // ≤ 2 requests per second per host: starts to www.redirect.test are ≥ 500 ms apart. Measured at the client, where the
  // pacer acts (server arrival trails the start by TLS handshakes and machine load). The exact rule is tested with a
  // virtual clock in test/unit/checks/http/collector-client.test.ts; `START_JITTER_MS` covers descheduling and GC.
  it('starts requests to one host at least 500 ms apart', () => {
    const wwwStarts = wwwRequestStarts(http, requestStarts);

    expect(requestStarts.length).toBe(6);
    expect(wwwStarts.length).toBe(4);
    expectGapsAtLeast(wwwStarts, PACER_INTERVAL_MS - START_JITTER_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(3 * PACER_INTERVAL_MS - START_JITTER_MS);
  });

  it('spreads the arrivals at the server too, not bunched', () => {
    const arrivals = server()
      .requestsTo('www.redirect.test')
      .map((r) => r.at);

    expect(arrivals.length).toBe(4);
    // Wider than the client-side gap: arrival trails the start by handshakes and machine load.
    expectGapsAtLeast(arrivals, PACER_INTERVAL_MS / 2);
  });

  it('gives HDR-01 and TLS-01 a section they can evaluate', () => {
    const { hdr, tls } = evaluate(startUrl, http);

    expect(hdr.status).toBe('completed');
    expect(variantsOf(hdr)).toEqual(['header-missing']);
    expect(hdr.outcome?.observations[0]?.subject).toBe('x-content-type-options');
    expect(hdr.outcome?.observations[0]?.pages).toEqual(['https://www.redirect.test/impressum']);
    expect(variantsOf(tls)).toEqual(['redirect-chain-detail']);
  });
});

describe('HTTP collector: headers that name the server software', () => {
  const startUrl = 'https://www.powered.test/';
  let http: HttpSection;

  beforeAll(async () => {
    server().reset();
    ({ http } = await collect(startUrl));
  });

  const productHeaders = (role: string) =>
    http.documents
      .find((d) => d.role === role)
      ?.headers.filter((h) => h.name === 'server' || h.name === 'x-powered-by')
      .sort((a, b) => a.name.localeCompare(b.name));

  it('stores product and version next to the redacted value of every main document', () => {
    for (const role of ['start', 'impressum']) {
      expect(productHeaders(role)).toEqual([
        { name: 'server', value: '[redacted]', productVersions: [{ product: 'Apache', version: '2.4.41' }] },
        {
          name: 'x-powered-by',
          value: '[redacted]',
          productVersions: [{ product: 'PHP', version: '7.2.34' }],
        },
      ]);
    }
    expect(productHeaders('privacy')).toEqual([{ name: 'server', value: '[redacted]', productVersions: [] }]);
  });

  it('the comment with the operating system is stored nowhere in the section', () => {
    expect(JSON.stringify(http)).not.toContain('Ubuntu');
    expect(server().unexpected).toEqual([]);
  });

  it('HDR-02 reports each header, product and version once, with the pages united', () => {
    const r = runCheck(hdr02, snapshotFor(startUrl, http));

    expect(r.status).toBe('completed');
    expect(
      observationsOf(r).map((o) => [
        o.subject,
        o.pages,
        o.evidence.map((e) => (e as { value?: unknown }).value),
      ]),
    ).toEqual([
      [
        'x-powered-by|php/7.2.34',
        [startUrl, 'https://www.powered.test/impressum'],
        ['PHP/7.2.34', 'PHP/7.2.34'],
      ],
      [
        'server|apache/2.4.41',
        [startUrl, 'https://www.powered.test/impressum'],
        ['Apache/2.4.41', 'Apache/2.4.41'],
      ],
    ]);
  });

  it('counterexample: a version only in the markup (meta generator, meta http-equiv) is not stored or reported', async () => {
    server().reset();
    const url = 'https://www.markup.test/';
    const { http } = await collect(url, closedRoutes('markup.test'));
    expect(startDocument(http)?.metaHttpEquiv).toEqual([{ name: 'x-powered-by', value: '[redacted]' }]);
    expect(JSON.stringify(http)).not.toMatch(/7\.2\.34|6\.4\.2/);
    const r = runCheck(hdr02, snapshotFor(url, http));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('HTTP collector: problem sites', () => {
  it('http without redirect and a form on the http page', async () => {
    const url = 'https://www.plain.test/';
    const { http } = await collect(url, closedRoutes('plain.test'));
    const httpHop = chainOf(http, 'target', 'http')?.final;
    expect(httpHop).toMatchObject({
      status: 200,
      hasForm: true,
      bodyKind: 'html',
      formInspection: 'complete',
      forms: [{ action: 'http://www.plain.test/kontakt', actionScheme: 'http', method: 'post' }],
    });
    expect(httpHop?.clientRedirect).toBeUndefined();
    expect(http.chains.find((c) => c.hostVariant === 'apex')?.outcome).toBe('connection-refused');
    expect(variantsOf(evaluate(url, http).tls)).toEqual(['form-on-http-page', 'no-redirect']);
    expect(server().unexpected).toEqual([]);
  });

  it('http content while port 443 is closed → TLS-01 https-unavailable (critical)', async () => {
    const url = 'http://www.httponly.test/';
    const { result, http } = await collect(url, closedRoutes('www.httponly.test:443', 'httponly.test'));
    expect(result.fatal).toBeUndefined();
    const https = chainOf(http, 'target', 'https');
    expect(https).toMatchObject({ outcome: 'connection-refused', hops: [] });
    expect(https?.error?.code).toBe('ECONNREFUSED');
    const { tls, hdr } = evaluate(url, http);
    expect(variantsOf(tls)).toEqual(['https-unavailable']);
    expect(tls.outcome?.observations[0]?.params).toMatchObject({ reason: 'unavailable' });
    // The start document is the http page: HSTS is not evaluated on http.
    expect(variantsOf(hdr)).not.toContain('hsts-missing');
  });

  it('a WAF challenge instead of the start page → SCAN-HTTP-BLOCKED, HDR-01 and HDR-02 inconclusive (blocked)', async () => {
    const url = 'https://www.challenge.test/';
    const { result: res, http } = await collect(url, closedRoutes('challenge.test'));
    const start = startDocument(http);
    expect(start).toMatchObject({ status: 429, error: { code: 'blocked' } });
    expect(start?.error?.message).toContain('header:x-vercel-mitigated');
    expect(res.diagnostics).toEqual([
      {
        code: 'SCAN-HTTP-BLOCKED',
        affects: ['HDR-01', 'HDR-02'],
        params: expect.objectContaining({ count: 1, page: url }),
      },
    ]);
    // One 429 is no throttling: the challenge is answered once, not retried.
    expect(http.throttled).toBe(false);
    const { hdr } = evaluate(url, http);
    expect(hdr).toMatchObject({ status: 'inconclusive', reason: 'blocked' });
    expect(variantsOf(hdr)).toEqual([]);
    const versions = runCheck(hdr02, snapshotFor(url, http));
    expect(versions).toMatchObject({ status: 'inconclusive', reason: 'blocked' });
    expect(server().unexpected).toEqual([]);
  });

  it('legal pages: the link text decides before the path', async () => {
    const { result, http } = await collect('https://www.builder.test/', closedRoutes('builder.test'));
    expect(http.documents.map((d) => [d.role, d.url])).toEqual([
      ['start', 'https://www.builder.test/'],
      ['impressum', 'https://www.builder.test/seite-3'],
      ['privacy', 'https://www.builder.test/impressum-2'],
    ]);
    expect(result.diagnostics).toBeUndefined();
    expect(server().unexpected).toEqual([]);
  });

  it('https with an expired certificate: request still made, Node verdict recorded', async () => {
    const url = 'https://www.expired.test/';
    const { http } = await collect(url, closedRoutes('expired.test'));
    expect(chainOf(http, 'target', 'https')?.final).toMatchObject({
      status: 200,
      tlsAuthorized: false,
      tlsAuthorizationError: 'CERT_HAS_EXPIRED',
    });
    const { tls, hdr } = evaluate(url, http);
    expect(variantsOf(tls)).toEqual(['https-unavailable']);
    expect(tls.outcome?.observations[0]?.params).toMatchObject({ reason: 'invalid' });
    expect(hdr).toMatchObject({ status: 'inconclusive', reason: 'tls-invalid' });
  });

  it('meta refresh to https on a small http page → client-side-redirect-only', async () => {
    const url = 'https://www.meta.test/';
    const { http } = await collect(url, closedRoutes('meta.test'));
    expect(chainOf(http, 'target', 'http')?.final?.clientRedirect).toEqual({
      kind: 'meta',
      url,
    });
    expect(variantsOf(evaluate(url, http).tls)).toEqual(['client-side-redirect-only']);
  });

  it.each([
    ['redirect loop stops after 5 redirects', undefined, 6],
    ['the redirect limit comes from the settings', 2, 3],
  ])('%s', async (_name, maxRedirects, hops) => {
    const ctx = maxRedirects === undefined ? {} : { config: parseConfigInput({ http: { maxRedirects } }) };
    const { http } = await collect('https://www.loop.test/', closedRoutes('loop.test'), fast, ctx);
    const chain = chainOf(http, 'target', 'http');
    expect(chain?.outcome).toBe('redirect-limit');
    expect(chain?.hops).toHaveLength(hops);
  });

  it('the gap between requests to one host comes from the settings', async () => {
    server().reset();
    const t0 = Date.now();

    const { result: res } = await collect('https://www.redirect.test/', {}, createHttpCollector(), {
      config: parseConfigInput({ http: { minIntervalMs: 700 } }),
    });

    expect(res.status).toBe('ok');
    expect(server().requestsTo('www.redirect.test')).toHaveLength(4);
    // Four requests to www.redirect.test: three gaps of the configured length.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 700 - START_JITTER_MS);
  });

  describe('three 429 of one host → Retry-After pause, one retry, then that host only is stopped', () => {
    let res: HttpResult;
    let http: HttpSection;

    beforeAll(async () => {
      server().reset();
      addOverloadedHost(server());

      const collector = createHttpCollector({ minIntervalMs: 20, maxRetryAfterMs: 300 });
      ({ result: res, http } = await collect('https://busy.test/', {}, collector));
    });

    it('marks the scan throttled and partial, naming the stopped host', () => {
      expect(http.throttled).toBe(true);
      expect(http.throttledHosts).toEqual(['busy.test']);
      expect(res.status).toBe('partial');
      expect(res.diagnostics).toEqual([{ code: 'SCAN-THROTTLED', affects: ['HDR-01', 'HDR-02', 'TLS-01'] }]);
    });

    it('retries the third 429 once, after the (capped) Retry-After pause', () => {
      const busy = server().requestsTo('busy.test');
      const urls = busy.map((r) => `${r.scheme}://${r.host}${r.path}`);

      const retried = urls.filter((u, i) => urls.indexOf(u) !== i);
      expect(retried).toHaveLength(1);
      const first = busy[urls.indexOf(retried[0] as string)]?.at as number;
      const again = busy[urls.lastIndexOf(retried[0] as string)]?.at as number;
      expect(again - first).toBeGreaterThanOrEqual(280);
    });

    it('sends nothing more to the stopped host after the failed retry', () => {
      // 3 + 1 retry (+ ≤ 1 already in flight).
      expect(server().requestsTo('busy.test').length).toBeLessThanOrEqual(5);
    });

    it('does not let the 429 of one host touch the healthy host (or reset its counter)', () => {
      expect(server().requestsTo('www.busy.test')).toHaveLength(2);
      const statuses = http.chains.filter((c) => c.host === 'www.busy.test').map((c) => c.hops[0]?.status);
      expect(statuses.filter((status) => status !== 301)).toEqual([]);
    });

    it('counts every request it issued', () => {
      expect(http.requestsIssued).toBe(server().requests.length);
    });
  });

  it('a gzip bomb is decoded only up to the cap and marked truncated', async () => {
    const bomb = await gzipBombServer();
    try {
      const { http } = await collect('http://www.bomb.test/', {
        'www.bomb.test:80': bomb.port,
        ...closedRoutes('www.bomb.test:443', 'bomb.test'),
      });
      const hop = chainOf(http, 'target', 'http')?.final;
      expect(hop?.status).toBe(200);
      expect(hop?.bodyBytes).toBe(MAX_DECODED_BYTES);
      expect(hop?.bodyTruncated).toBe(true);
    } finally {
      await bomb.close();
    }
  });

  it('both ports of the target closed → fatal unreachable', async () => {
    const { result: res } = await collect(
      'https://www.down.test/',
      closedRoutes('www.down.test', 'down.test'),
    );

    expect(res.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
    const outcomes = res.sections.http?.chains.map((c) => c.outcome);
    expect(outcomes?.filter((outcome) => outcome !== 'connection-refused')).toEqual([]);
  });

  const slowUrl = 'https://www.slow.test/';
  const collectSlow = (port: number, collector: typeof fast, ctx: Partial<CollectorContext> = {}) =>
    collect(slowUrl, { 'www.slow.test': port, 'slow.test': closed }, collector, ctx);

  it('a server that never answers → timeout outcome, TLS-01 inconclusive', () =>
    withSilentServer(async (port) => {
      const collector = createHttpCollector({
        minIntervalMs: 20,
        timeouts: { connectMs: 1_000, headersMs: 500, bodyMs: 500, requestMs: 1_500 },
      });

      const { result: res, http } = await collectSlow(port, collector);
      expect(chainOf(http, 'target', 'http')?.outcome).toBe('timeout');
      expect(res.fatal).toMatchObject({ reason: 'unreachable' });
      const snapshot = snapshotFor(slowUrl, http);
      expect(runCheck(tls01, snapshot)).toMatchObject({ status: 'inconclusive', reason: 'timeout' });
    }));

  it('the scan deadline aborts promptly', () =>
    withSilentServer(async (port) => {
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(new Error('scan timeout')), 300);

      const collector = createHttpCollector({ minIntervalMs: 20 });
      const { result: res } = await collectSlow(port, collector, { signal: ac.signal });

      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(res.status).toBe('partial');
      expect(res.fatal).toBeUndefined();
    }));
});

describe('HTTP collector: explicit target port', () => {
  const url = 'https://www.port.test:8443/';
  const collectOrigin = (port: number) =>
    collect(url, {
      'www.port.test:8443': port,
      ...closedRoutes('www.port.test:80', 'www.port.test:443', 'port.test'),
    });

  it('the start document is fetched from the origin with its port; standard ports stay separate probes', async () => {
    server().reset();

    const { result: res, http } = await collectOrigin(server().httpsPort);
    expect(res.fatal).toBeUndefined();
    const start = startDocument(http);
    expect(start).toMatchObject({
      url,
      finalUrl: url,
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

    expect(variantsOf(evaluate(url, http).tls)).toEqual([]);
    expect(server().unexpected).toEqual([]);
  });

  it('origin port closed → fatal unreachable (even though nothing else answers either)', async () => {
    const { result: res } = await collectOrigin(closed);
    expect(res.fatal).toMatchObject({ reason: 'unreachable', code: 'start-page-unreachable' });
  });
});

describe('HTTP collector: final host on another domain', () => {
  describe('www.origin.test redirects to www.moved.test, whose certificate has expired', () => {
    const startUrl = 'https://www.origin.test/';
    let res: HttpResult;
    let http: HttpSection;
    let tls: TlsSection;

    beforeAll(async () => {
      server().reset();
      const routes = closedRoutes('origin.test', 'moved.test');

      ({ result: res, http } = await collect(startUrl, routes));

      const tlsResult = await createTlsCollector({ timeoutMs: 3_000 })(
        collectorContext(startUrl, withRoutes(server().network(), routes)),
      );
      tls = tlsResult.sections.tls as TlsSection;
    });

    it('fetches the start document from the final host', () => {
      expect(http.documents[0]).toMatchObject({
        role: 'start',
        finalUrl: 'https://www.moved.test/',
        status: 200,
      });
    });

    it('records the TLS endpoints of the final host and its www/apex', () => {
      expect(http.finalTls?.map((e) => `${e.role}/${e.hostVariant}:${e.host}:${e.outcome}`)).toEqual([
        'final/target:www.moved.test:handshake',
        'final/apex:moved.test:connection-refused',
      ]);
      expect(http.finalTls?.[0]).toMatchObject({
        authorized: false,
        authorizationError: 'CERT_HAS_EXPIRED',
        port: 443,
      });
    });

    it('lists a certificate probe for each of those endpoints', () => {
      expect(res.probes?.filter((p) => p.kind === 'tls').map((p) => `${p.target} ${p.purpose}`)).toEqual([
        'www.moved.test:443 certificate',
        'moved.test:443 certificate',
      ]);
    });

    it('lets TLS-02 report the expired certificate', () => {
      const snapshot = snapshotFor(startUrl, http, tls);
      // The fixture server issues its certificates relative to the real clock, so the check has to read the same clock
      // (the fixed check clock of `runCheck` would call a certificate issued tomorrow "not yet valid").
      const r = runCheck(tls02, snapshot, { now: new Date() });

      expect(r.status).toBe('completed');
      expect(r.outcome?.observations.map((o) => `${o.variant}:${o.subject}`)).toEqual([
        'certificate-invalid:certificate:final',
      ]);
    });

    it('sends no request the fixture server does not know', () => {
      expect(server().unexpected).toEqual([]);
    });
  });

  it("a sibling subdomain as final host is probed; its www/apex are already the TLS collector's", async () => {
    const { http } = await collect('https://www.sib.test/', closedRoutes('sib.test'));
    expect(http.finalTls?.map((e) => `${e.role}/${e.hostVariant}:${e.host}`)).toEqual([
      'final/target:shop.sib.test',
    ]);
    expect(http.finalTls?.[0]).toMatchObject({ authorizationError: 'CERT_HAS_EXPIRED' });
  });

  it('a redirect within target/www/apex probes nothing extra', async () => {
    const { result: res, http } = await collect('https://www.redirect.test/');
    expect(http.finalTls).toBeUndefined();
    expect(res.probes?.map((p) => p.kind).filter((kind) => kind !== 'http')).toEqual([]);
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
    server().reset();

    const { result: res, http } = await collectFrom(
      collectorContext('https://www.redirect.test/', direct({})),
    );
    const notBlocked = http.chains.filter(
      (c) => !(c.outcome === 'error' && c.error?.code === 'private-address'),
    );
    expect(notBlocked.map((c) => `${c.id}:${c.outcome}`)).toEqual([]);
    expect(server().requests).toEqual([]);
    expect(res.fatal).toBeUndefined();
  });

  it('through an HTTP proxy (TLS verdict unknown behind the proxy)', async () => {
    const proxy = await httpProxy(server().httpPort, server().httpsPort);
    try {
      const { http } = await collectFrom(
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

      const https = chainOf(http, 'target', 'https');
      expect(https?.final).toMatchObject({ status: 200, tlsAuthorized: null, connectedIp: null });
      expect(proxy.targets).toContain('http://www.redirect.test/');
      expect(proxy.targets).toContain('www.redirect.test:443');
      expect(http.documents.map((d) => d.role)).toEqual(['start', 'impressum', 'privacy']);
    } finally {
      await proxy.close();
    }
  });
});
