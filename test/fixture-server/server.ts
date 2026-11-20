/**
 * Fixture server: one HTTP and one HTTPS listener (random ports) serving virtual hosts by Host header, certificates by
 * SNI from the test PKI. Sites are declared in ./sites.ts; an unknown host gives 599 and an entry in `unexpected`.
 */
import { readFileSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import tls, { type SecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import type { NetworkConfig } from '../../src/core/url/net.ts';
import { type CertKind, createTestPki, type TestPki } from '../utils/certs.ts';
import { SITES } from './sites.ts';

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
  /** A file under SITES_DIR as the body, e.g. a simulator script that several fixture hosts serve as their own. */
  file?: string;
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

export interface FixtureServerOptions {
  /** Site directories relative to SITES_DIR, e.g. `core/smoke`, `browser/fonts`. Merged in order. */
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
  requests: RecordedRequest[];
  /** Requests to hosts not declared by any site (should stay empty). */
  unexpected: RecordedRequest[];
  /** Chrome background requests (BROWSER_INTERNAL_HOSTS), answered with 404. */
  browserInternal: RecordedRequest[];
  hosts(): string[];
  addHandler(h: DynamicHandler): void;
  addRoute(r: RouteSpec): void;
  /** NetworkConfig that routes every host to this server (for scan and collectors). */
  network(): NetworkConfig;
  /** Chromium args: host resolver rules + SPKI allowlist for the shared test leaf key. */
  browserArgs(): string[];
  requestsTo(host: string): RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

/** Extra response headers by absolute file path; statSync fails loudly on an entry for a missing file. */
const FILE_HEADERS = new Map(
  Object.entries(SITES).flatMap(([rel, site]) =>
    Object.entries(site.fileHeaders ?? {}).map(([file, headers]) => {
      const abs = path.join(SITES_DIR, rel, file);
      statSync(abs);
      return [abs, headers] as const;
    }),
  ),
);

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

/** What the options declare: virtual hosts, certificate kinds, canned routes and dynamic handlers, merged in order. */
interface Declarations {
  docroots: Map<string, string>;
  tlsKinds: Map<string, CertKind>;
  routes: RouteSpec[];
  handlers: DynamicHandler[];
}

interface RequestLog {
  requests: RecordedRequest[];
  unexpected: RecordedRequest[];
  browserInternal: RecordedRequest[];
}

/** Declared sites first (./sites.ts), then the inline hosts and routes of the options. */
function collectDeclarations(opts: FixtureServerOptions): Declarations {
  const docroots = new Map<string, string>();
  const tlsKinds = new Map<string, CertKind>();
  const routes: RouteSpec[] = [];
  const handlers: DynamicHandler[] = [...(opts.handlers ?? [])];

  for (const rel of opts.sites ?? []) {
    const root = path.join(SITES_DIR, rel);
    const config = SITES[rel];
    if (!config) throw new Error(`fixture-server: site ${rel} is not declared in sites.ts`);

    for (const [host, dir] of Object.entries(config.hosts))
      docroots.set(host.toLowerCase(), path.join(root, dir));
    for (const [host, kind] of Object.entries(config.tls ?? {})) tlsKinds.set(host.toLowerCase(), kind);
    // A route to a missing file fails here, not as a 500 in the middle of a scan.
    for (const r of config.routes ?? []) if (r.file !== undefined) statSync(path.join(SITES_DIR, r.file));
    routes.push(...(config.routes ?? []));
  }

  for (const [host, dir] of Object.entries(opts.hosts ?? {})) docroots.set(host.toLowerCase(), dir);
  for (const [host, kind] of Object.entries(opts.tls ?? {})) tlsKinds.set(host.toLowerCase(), kind);
  routes.push(...(opts.routes ?? []));

  return { docroots, tlsKinds, routes, handlers };
}

function matchHost(spec: string | RegExp | undefined, host: string): boolean {
  if (spec === undefined) return false;
  return typeof spec === 'string' ? spec.toLowerCase() === host : spec.test(host);
}

type Incoming = DynamicContext & { req: IncomingMessage };

function handlerMatches(h: DynamicHandler, { req, scheme, host, url }: Incoming): boolean {
  if (h.host !== undefined && !matchHost(h.host, host)) return false;
  if (h.scheme && h.scheme !== scheme) return false;
  if (h.method && h.method !== req.method) return false;
  return typeof h.path === 'string' ? h.path === url.pathname : h.path.test(url.pathname);
}

function routeMatches(r: RouteSpec, { req, scheme, host, url }: Incoming): boolean {
  if (r.host && r.host.toLowerCase() !== host) return false;
  if (r.scheme && r.scheme !== scheme) return false;
  if (r.method && r.method !== req.method) return false;
  return r.pathRegex ? new RegExp(r.path).test(url.pathname) : r.path === url.pathname;
}

async function respondWithRoute(r: RouteSpec, res: ServerResponse): Promise<void> {
  if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
  const body = r.file !== undefined ? readFileSync(path.join(SITES_DIR, r.file)) : (r.body ?? '');
  res.writeHead(r.status ?? 200, r.headers ?? {});
  res.end(body);
}

function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(400).end();
    return;
  }

  try {
    if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      ...FILE_HEADERS.get(file),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>404</title><h1>Nicht gefunden</h1>');
  }
}

/**
 * Request handler per scheme. Order: Chrome background traffic, dynamic handlers, canned routes, static files; a host
 * that nothing declares gets 599 and an entry in `log.unexpected`. `decl` is read on every request, so handlers and
 * routes added later take effect.
 */
function createRequestHandler(decl: Declarations, log: RequestLog) {
  const isDeclared = (host: string) =>
    decl.docroots.has(host) ||
    decl.tlsKinds.has(host) ||
    decl.routes.some((r) => r.host === host) ||
    decl.handlers.some((h) => matchHost(h.host, host));

  return (scheme: Scheme) => async (req: IncomingMessage, res: ServerResponse) => {
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

    if (BROWSER_INTERNAL_HOSTS.has(host) && !decl.docroots.has(host)) {
      log.browserInternal.push(rec);
      res.writeHead(404).end();
      return;
    }
    log.requests.push(rec);

    try {
      const incoming: Incoming = { req, scheme, host, url };

      const handler = decl.handlers.find((h) => handlerMatches(h, incoming));
      if (handler) {
        await handler.handle(req, res, { scheme, host, url });
        return;
      }

      const route = decl.routes.find((r) => routeMatches(r, incoming));
      if (route) {
        await respondWithRoute(route, res);
        return;
      }

      const root = decl.docroots.get(host);
      if (!root) {
        if (!isDeclared(host)) log.unexpected.push(rec);
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
}

/** HTTPS certificate per SNI name: issued lazily by the test PKI, cached per host. */
function createSniCallback(pki: TestPki, tlsKinds: ReadonlyMap<string, CertKind>) {
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

  return (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void): void => {
    contextFor(servername).then(
      (ctx) => cb(null, ctx),
      (err: Error) => cb(err),
    );
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

export async function startFixtureServer(opts: FixtureServerOptions = {}): Promise<FixtureServer> {
  const pki = opts.pki ?? (await createTestPki());
  const decl = collectDeclarations(opts);
  const log: RequestLog = { requests: [], unexpected: [], browserInternal: [] };
  const handler = createRequestHandler(decl, log);

  const fallback = await pki.issue({ hosts: ['localhost'] });
  const httpServer = http.createServer(handler('http'));
  const httpsServer = https.createServer(
    {
      cert: fallback.chainPem,
      key: fallback.keyPem,
      SNICallback: createSniCallback(pki, decl.tlsKinds),
    },
    handler('https'),
  );
  const [httpPort, httpsPort] = await Promise.all([listen(httpServer), listen(httpsServer)]);

  /** Ports 80 and 443 are remapped to the random listener ports; any other port is taken as it is. */
  const fixturePort = (port: number) => (port === 443 ? httpsPort : port === 80 ? httpPort : port);
  const browserArgs = () => [
    // Every hostname resolves to the fixture server; port 80/443 are remapped to the random ports.
    `--host-resolver-rules=MAP *:80 127.0.0.1:${httpPort}, MAP *:443 127.0.0.1:${httpsPort}, MAP * ~NOTFOUND, EXCLUDE localhost`,
    `--ignore-certificate-errors-spki-list=${pki.trustedSpki}`,
  ];

  return {
    httpPort,
    httpsPort,
    pki,
    requests: log.requests,
    unexpected: log.unexpected,
    browserInternal: log.browserInternal,
    hosts: () => [...decl.docroots.keys()],
    addHandler: (h) => decl.handlers.unshift(h),
    addRoute: (r) => decl.routes.unshift(r),
    browserArgs,
    network: () => ({
      proxy: null,
      allowPrivateAddresses: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      dnsServers: [],
      test: {
        connect: (_host, port) => ({ host: '127.0.0.1', port: fixturePort(port) }),
        browserArgs: browserArgs(),
        caPem: [pki.caPem],
      },
    }),
    requestsTo: (host) => log.requests.filter((r) => r.host === host.toLowerCase()),
    reset: () => {
      log.requests.length = 0;
      log.unexpected.length = 0;
      log.browserInternal.length = 0;
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
