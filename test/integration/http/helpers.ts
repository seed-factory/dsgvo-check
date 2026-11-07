/** Helpers for the HTTP/TLS collectors: collector context, routing overrides, a chain PKI, a local proxy. */
import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import type { Duplex } from 'node:stream';
import * as x509 from '@peculiar/x509';
import { defaultConfig } from '../../../src/core/config/schema.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { uaToken } from '../../../src/core/runtime/user-agent.ts';
import type { CollectorContext } from '../../../src/core/snapshot/collector.ts';
import type { Snapshot } from '../../../src/core/snapshot/index.ts';
import type { NetworkConfig } from '../../../src/core/url/net.ts';
import { parseTarget } from '../../../src/core/url/url.ts';

x509.cryptoProvider.set(globalThis.crypto);

export function collectorContext(
  url: string,
  network: NetworkConfig,
  p: Partial<CollectorContext> = {},
): CollectorContext {
  return {
    target: parseTarget(url),
    options: { maxPages: 6, screenshots: false, sandbox: 'off', lang: 'de', assumeRegion: null },
    network,
    config: defaultConfig(),
    userAgent: { http: uaToken(), token: uaToken() },
    signal: new AbortController().signal,
    deadline: Date.now() + 120_000,
    artifactsDir: tmpdir(),
    artifactsRelDir: 'artifacts',
    now: () => new Date(),
    log: silentLogger,
    snapshot: {} as Snapshot,
    ...p,
  };
}

/** A port on 127.0.0.1 that refuses connections (bound once, then closed). */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A TCP server that accepts connections and never answers (handshake / header timeouts). */
export async function silentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const s = net.createServer((c) => {
    sockets.add(c);
    c.on('error', () => undefined);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return {
    port: (s.address() as AddressInfo).port,
    close: async () => {
      for (const c of sockets) c.destroy();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}

/**
 * Network that routes `host` or `host:port` to a local port (others → the fixture server), optionally trusting
 * extra CA certificates.
 */
export function withRoutes(
  base: NetworkConfig,
  routes: Record<string, number>,
  extraCa: string[] = [],
): NetworkConfig {
  const test = base.test;
  if (!test) throw new Error('withRoutes needs a test network');
  return {
    ...base,
    test: {
      ...test,
      caPem: [...test.caPem, ...extraCa],
      connect: (host, port) => {
        const to = routes[`${host}:${port}`] ?? routes[host];
        return to !== undefined ? { host: '127.0.0.1', port: to } : test.connect(host, port);
      },
    },
  };
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 86_400_000;

async function keys() {
  return (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
}

async function keyPem(k: webcrypto.CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', k));
  return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
}

export interface ChainPki {
  rootPem: string;
  intermediatePem: string;
  leafPem: string;
  leafKeyPem: string;
}

/**
 * A separate root → intermediate → leaf hierarchy for chain tests (incomplete chain, unknown root). `san: false` names
 * the host only in the leaf's CN, as old private-CA and hoster default certificates do.
 */
export async function createChainPki(
  host: string,
  now = new Date(),
  { san = true }: { san?: boolean } = {},
): Promise<ChainPki> {
  const rootK = await keys();
  const intK = await keys();
  const leafK = await keys();
  const nb = new Date(now.getTime() - DAY);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '0101',
    name: 'CN=dsgvo-check Chain Root',
    notBefore: nb,
    notAfter: new Date(now.getTime() + 3650 * DAY),
    keys: rootK,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(rootK.publicKey),
    ],
  });
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: '0102',
    subject: 'CN=dsgvo-check Chain Intermediate',
    issuer: root.subject,
    notBefore: nb,
    notAfter: new Date(now.getTime() + 1825 * DAY),
    signingKey: rootK.privateKey,
    publicKey: intK.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(intK.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(root, false),
    ],
  });
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '0103',
    subject: `CN=${host}`,
    issuer: intermediate.subject,
    notBefore: nb,
    notAfter: new Date(now.getTime() + 90 * DAY),
    signingKey: intK.privateKey,
    publicKey: leafK.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      ...(san ? [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }])] : []),
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      await x509.AuthorityKeyIdentifierExtension.create(intermediate, false),
    ],
  });
  return {
    rootPem: root.toString('pem'),
    intermediatePem: intermediate.toString('pem'),
    leafPem: leaf.toString('pem'),
    leafKeyPem: await keyPem(leafK.privateKey),
  };
}

/** HTTPS server presenting exactly `chainPem` (e.g. the leaf only = incomplete chain). */
export async function chainServer(
  chainPem: string,
  keyPemText: string,
): Promise<{ port: number; close(): Promise<void> }> {
  const s = https.createServer({ cert: chainPem, key: keyPemText }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>chain</title>');
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return {
    port: (s.address() as AddressInfo).port,
    close: async () => {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}

export interface TestProxy {
  url: string;
  /** `host:port` of CONNECT / SOCKS targets and absolute URLs of forwarded http requests. */
  targets: string[];
  close(): Promise<void>;
}

/** Forwards an absolute-form http request to `httpPort` on localhost, keeping the Host header and the path. */
function forwardHttp(req: http.IncomingMessage, res: http.ServerResponse, httpPort: number) {
  const u = new URL(req.url ?? '/', 'http://invalid');
  const up = http.request(
    {
      host: '127.0.0.1',
      port: httpPort,
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers: req.headers,
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
}

/** Answers a CONNECT with a tunnel to `httpsPort` on localhost; both sockets are tracked for `close`. */
function tunnelConnect(client: Duplex, head: Buffer, httpsPort: number, sockets: Set<{ destroy(): void }>) {
  sockets.add(client);
  const up = net.connect(httpsPort, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  sockets.add(up);
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
}

/** HTTP proxy: CONNECT → fixture https port, absolute-form GET → fixture http port (Host kept). */
export async function httpProxy(httpPort: number, httpsPort: number): Promise<TestProxy> {
  const targets: string[] = [];
  const sockets = new Set<{ destroy(): void }>();
  const s = http.createServer((req, res) => {
    targets.push(req.url ?? '');
    forwardHttp(req, res, httpPort);
  });
  s.on('connect', (req, client, head) => {
    targets.push(req.url ?? '');
    tunnelConnect(client, head, httpsPort, sockets);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));

  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    targets,
    close: async () => {
      for (const c of sockets) c.destroy();
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}
