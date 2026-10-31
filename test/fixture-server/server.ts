/**
 * L2 fixture server: one HTTP and one HTTPS listener on random ports serving virtual hosts by the Host header
 * (HTTPS: certificate by SNI from the test PKI). Every hostname — target sites and fake third parties like
 * fonts.googleapis.com or www.google-analytics.com — is served locally; nothing goes to the internet.
 *
 * Sites live in test/fixture-server/sites/<module>/<site>/ with a `hosts.json` (see test/README.md):
 * {
 *   "hosts": { "www.example.test": "www", "www.google-analytics.com": "ga" },   // host → docroot (sub dir)
 *   "tls":   { "expired.example.test": "expired" },                            // CertKind per host (default valid)
 *   "routes": [ { "host": "example.test", "scheme": "http", "path": "/", "status": 301,
 *                 "headers": { "location": "https://www.example.test/" } } ]
 * }
 * Static files: `<docroot>/<path>` (`/` → index.html), optional sidecar `<file>.headers.json` {status?, headers?}.
 * Unknown host → 599 and an entry in `unexpected` (a test bug: undeclared third party).
 */
import { readFileSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import tls, { type SecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import type { NetworkConfig } from '../../src/core/net.ts';
import { type CertKind, createTestPki, type TestPki } from '../utils/certs.ts';

export const SITES_DIR = fileURLToPath(new URL('./sites/', import.meta.url));

/** Chrome's own background traffic (component updater, safe browsing…) — not page traffic, never "unexpected". */
export const BROWSER_INTERNAL_HOSTS: ReadonlySet<string> = new Set([
  'update.googleapis.com',
  'clients2.google.com',
  'clientservices.googleapis.com',
  'optimizationguide-pa.googleapis.com',
  'safebrowsing.googleapis.com',
  'content-autofill.googleapis.com',
  'accounts.google.com',
  'redirector.gvt1.com',
  'edgedl.me.gvt1.com',
  'android.clients.google.com',
  // Chrome probes connectivity (`/generate_204`) after a network error.
  'connectivitycheck.gstatic.com',
]);

export type Scheme = 'http' | 'https';

export interface RecordedRequest {
  scheme: Scheme;
  host: string;
  method: string;
  path: string;
  userAgent: string | undefined;
  /** Cookie names sent (values are not recorded). */
  cookieNames: string[];
  at: number;
}

export interface RouteSpec {
  host?: string;
  scheme?: Scheme;
  method?: string;
  /** Exact path (without query) or a RegExp source when `pathRegex` is true. */
  path: string;
  pathRegex?: boolean;
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
  /** Delay before responding (ms), e.g. delayed tags. */
  delayMs?: number;
}

export interface DynamicContext {
  scheme: Scheme;
  host: string;
  url: URL;
}

export interface DynamicHandler {
  host?: string | RegExp;
  scheme?: Scheme;
  method?: string;
  path: string | RegExp;
  handle(req: IncomingMessage, res: ServerResponse, ctx: DynamicContext): void | Promise<void>;
}

export interface SiteConfig {
  hosts: Record<string, string>;
  tls?: Record<string, CertKind>;
  routes?: RouteSpec[];
}

export interface FixtureServerOptions {
  /** Site directories relative to SITES_DIR, e.g. `core/smoke`, `browser/fonts-google`. Merged in order. */
  sites?: string[];
  /** Extra inline hosts → absolute docroot. */
  hosts?: Record<string, string>;
  routes?: RouteSpec[];
  handlers?: DynamicHandler[];
  tls?: Record<string, CertKind>;
  pki?: TestPki;
}

export interface FixtureServer {
  httpPort: number;
  httpsPort: number;
  pki: TestPki;
  /** All requests received, in order. */
  requests: RecordedRequest[];
  /** Requests to hosts not declared by any site (should stay empty). */
  unexpected: RecordedRequest[];
  /** Chrome background requests (BROWSER_INTERNAL_HOSTS), answered with 404. */
  browserInternal: RecordedRequest[];
  /** Hosts served (declared). */
  hosts(): string[];
  /** Add handlers/routes at runtime (e.g. per test). */
  addHandler(h: DynamicHandler): void;
  addRoute(r: RouteSpec): void;
  /** NetworkConfig that routes every host to this server (for scan() and collectors). */
  network(): NetworkConfig;
  /** Chromium args: host resolver rules + SPKI allowlist for the shared test leaf key. */
  browserArgs(): string[];
  requestsTo(host: string): RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

function loadSite(rel: string): { root: string; config: SiteConfig } {
  const root = path.join(SITES_DIR, rel);
  const config = JSON.parse(readFileSync(path.join(root, 'hosts.json'), 'utf8')) as SiteConfig;
  return { root, config };
}

function cookieNames(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(';')
    .map((p) => p.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

export async function startFixtureServer(opts: FixtureServerOptions = {}): Promise<FixtureServer> {
  const pki = opts.pki ?? (await createTestPki());
  const docroots = new Map<string, string>();
  const tlsKinds = new Map<string, CertKind>();
  const routes: RouteSpec[] = [];
  const handlers: DynamicHandler[] = [...(opts.handlers ?? [])];
  for (const rel of opts.sites ?? []) {
    const { root, config } = loadSite(rel);
    for (const [host, dir] of Object.entries(config.hosts))
      docroots.set(host.toLowerCase(), path.join(root, dir));
    for (const [host, kind] of Object.entries(config.tls ?? {})) tlsKinds.set(host.toLowerCase(), kind);
    routes.push(...(config.routes ?? []));
  }
  for (const [host, dir] of Object.entries(opts.hosts ?? {})) docroots.set(host.toLowerCase(), dir);
  for (const [host, kind] of Object.entries(opts.tls ?? {})) tlsKinds.set(host.toLowerCase(), kind);
  routes.push(...(opts.routes ?? []));

  const requests: RecordedRequest[] = [];
  const unexpected: RecordedRequest[] = [];
  const browserInternal: RecordedRequest[] = [];
  const declared = (host: string) =>
    docroots.has(host) ||
    tlsKinds.has(host) ||
    routes.some((r) => r.host === host) ||
    handlers.some((h) => matchHost(h.host, host));

  function matchHost(spec: string | RegExp | undefined, host: string): boolean {
    if (spec === undefined) return false;
    return typeof spec === 'string' ? spec.toLowerCase() === host : spec.test(host);
  }

  const handler = (scheme: Scheme) => async (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const url = new URL(req.url ?? '/', `${scheme}://${host || 'unknown'}`);
    const rec: RecordedRequest = {
      scheme,
      host,
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      userAgent: req.headers['user-agent'],
      cookieNames: cookieNames(req.headers.cookie),
      at: Date.now(),
    };
    if (BROWSER_INTERNAL_HOSTS.has(host) && !docroots.has(host)) {
      browserInternal.push(rec);
      res.writeHead(404).end();
      return;
    }
    requests.push(rec);
    try {
      for (const h of handlers) {
        if (h.host !== undefined && !matchHost(h.host, host)) continue;
        if (h.scheme && h.scheme !== scheme) continue;
        if (h.method && h.method !== req.method) continue;
        if (typeof h.path === 'string' ? h.path !== url.pathname : !h.path.test(url.pathname)) continue;
        await h.handle(req, res, { scheme, host, url });
        return;
      }
      for (const r of routes) {
        if (r.host && r.host.toLowerCase() !== host) continue;
        if (r.scheme && r.scheme !== scheme) continue;
        if (r.method && r.method !== req.method) continue;
        if (r.pathRegex ? !new RegExp(r.path).test(url.pathname) : r.path !== url.pathname) continue;
        if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
        res.writeHead(r.status ?? 200, r.headers ?? {});
        res.end(r.body ?? '');
        return;
      }
      const root = docroots.get(host);
      if (!root) {
        if (!declared(host)) unexpected.push(rec);
        res.writeHead(599, { 'content-type': 'text/plain' });
        res.end(`fixture-server: undeclared host ${host}`);
        return;
      }
      serveStatic(root, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  };

  function serveStatic(root: string, pathname: string, res: ServerResponse) {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(400).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const body = readFileSync(file);
      let status = 200;
      const headers: Record<string, string | string[]> = {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      };
      try {
        const side = JSON.parse(readFileSync(`${file}.headers.json`, 'utf8')) as {
          status?: number;
          headers?: Record<string, string | string[]>;
        };
        status = side.status ?? status;
        Object.assign(headers, side.headers);
      } catch {
        // no sidecar
      }
      res.writeHead(status, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>404</title><h1>Nicht gefunden</h1>');
    }
  }

  // HTTPS: certificate per SNI, generated lazily and cached.
  const contexts = new Map<string, Promise<SecureContext>>();
  const contextFor = (servername: string): Promise<SecureContext> => {
    const host = servername.toLowerCase();
    let p = contexts.get(host);
    if (!p) {
      p = pki
        .issueKind(tlsKinds.get(host) ?? 'valid', [host])
        .then((c) => tls.createSecureContext({ cert: c.chainPem, key: c.keyPem }));
      contexts.set(host, p);
    }
    return p;
  };
  const fallback = await pki.issue({ hosts: ['localhost'] });

  const httpServer = http.createServer(handler('http'));
  const httpsServer = https.createServer(
    {
      cert: fallback.chainPem,
      key: fallback.keyPem,
      SNICallback: (servername, cb) => {
        contextFor(servername).then(
          (ctx) => cb(null, ctx),
          (err: Error) => cb(err),
        );
      },
    },
    handler('https'),
  );
  const listen = (s: http.Server) =>
    new Promise<number>((resolve) =>
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
    );
  const [httpPort, httpsPort] = await Promise.all([listen(httpServer), listen(httpsServer)]);

  const browserArgs = () => [
    // Every hostname resolves to the fixture server; port 80/443 are remapped to the random ports.
    `--host-resolver-rules=MAP *:80 127.0.0.1:${httpPort}, MAP *:443 127.0.0.1:${httpsPort}, MAP * ~NOTFOUND, EXCLUDE localhost`,
    `--ignore-certificate-errors-spki-list=${pki.trustedSpki}`,
  ];

  return {
    httpPort,
    httpsPort,
    pki,
    requests,
    unexpected,
    browserInternal,
    hosts: () => [...docroots.keys()],
    addHandler: (h) => handlers.unshift(h),
    addRoute: (r) => routes.unshift(r),
    browserArgs,
    network: () => ({
      proxy: null,
      allowPrivateAddresses: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      dnsServers: [],
      test: {
        connect: (_host, port) => ({
          host: '127.0.0.1',
          port: port === 443 ? httpsPort : port === 80 ? httpPort : port,
        }),
        browserArgs: browserArgs(),
        caPem: [pki.caPem],
      },
    }),
    requestsTo: (host) => requests.filter((r) => r.host === host.toLowerCase()),
    reset: () => {
      requests.length = 0;
      unexpected.length = 0;
      browserInternal.length = 0;
    },
    close: async () => {
      httpServer.closeAllConnections();
      httpsServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => httpServer.close(() => r())),
        new Promise<void>((r) => httpsServer.close(() => r())),
      ]);
    },
  };
}

/** Handler factory: respond with Set-Cookie headers (cookies are the test's own fake values). */
export function setCookieHandler(
  match: Pick<DynamicHandler, 'host' | 'path' | 'scheme'>,
  cookies: string[],
  body = 'ok',
  contentType = 'text/plain',
): DynamicHandler {
  return {
    ...match,
    handle: (_req, res) => {
      res.writeHead(200, { 'set-cookie': cookies, 'content-type': contentType });
      res.end(body);
    },
  };
}

/** Handler factory: redirect to `location` (absolute URL or a function of the request URL). */
export function redirectHandler(
  match: Pick<DynamicHandler, 'host' | 'path' | 'scheme'>,
  location: string | ((url: URL) => string),
  status = 301,
): DynamicHandler {
  return {
    ...match,
    handle: (_req, res, ctx) => {
      res.writeHead(status, { location: typeof location === 'string' ? location : location(ctx.url) });
      res.end();
    },
  };
}
