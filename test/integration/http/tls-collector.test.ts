/**
 * L2: the TLS collector (node:tls) against local HTTPS servers with certificates from test/utils/certs.ts (the test
 * CA is trusted only for the test) and a separate root → intermediate → leaf hierarchy for chain cases; then TLS-02.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tls02 } from '../../../src/checks/http/tls-02.ts';
import { createTlsCollector } from '../../../src/collectors/tls/index.ts';
import type { TlsEndpoint, TlsSection } from '../../../src/collectors/tls/types.ts';
import type { NetworkConfig } from '../../../src/core/net.ts';
import { detectTrustStore } from '../../../src/core/snapshot.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { makeHttp, makeSnapshot, makeTarget, runCheck, variantsOf } from '../../utils/snapshot-builder.ts';
import {
  type ChainPki,
  chainServer,
  closedPort,
  collectorContext,
  createChainPki,
  httpProxy,
  silentServer,
  socksProxy,
  withRoutes,
} from './helpers.ts';

let server: FixtureServer;
let closed: number;
let pki: ChainPki;
const servers: Array<{ close(): Promise<void> }> = [];
let leafOnly: number;
let fullChain: number;
let withRoot: number;

beforeAll(async () => {
  server = await startFixtureServer({
    tls: {
      'www.expired.test': 'expired',
      'www.wrongname.test': 'wrong-name',
      'www.selfsigned.test': 'self-signed',
      'www.expiring.test': 'expiring',
    },
  });
  closed = await closedPort();
  pki = await createChainPki('www.chain.test');
  const a = await chainServer(pki.leafPem, pki.leafKeyPem);
  const b = await chainServer(`${pki.leafPem}\n${pki.intermediatePem}`, pki.leafKeyPem);
  const c = await chainServer(`${pki.leafPem}\n${pki.intermediatePem}\n${pki.rootPem}`, pki.leafKeyPem);
  servers.push(a, b, c);
  leafOnly = a.port;
  fullChain = b.port;
  withRoot = c.port;
});

afterAll(async () => {
  for (const s of servers) await s.close();
  await server?.close();
});

const collector = createTlsCollector({ timeoutMs: 3_000 });

async function endpoints(url: string, network: NetworkConfig): Promise<TlsSection> {
  const res = await collector(collectorContext(url, network));
  expect(res.status).toBe('ok');
  return res.sections.tls as TlsSection;
}

const target = (s: TlsSection) => s.endpoints.find((e) => e.hostVariant === 'target') as TlsEndpoint;
const tls02Result = (url: string, tls: TlsSection) =>
  runCheck(tls02, makeSnapshot({ target: makeTarget(url), tls, http: makeHttp() }), { now: new Date() });
const tls02Variants = (url: string, tls: TlsSection) => variantsOf(tls02Result(url, tls));

describe('TLS collector with the test PKI', () => {
  it('valid certificate: handshake facts, chain, own name check', async () => {
    const s = await endpoints(
      'https://www.valid.test/',
      withRoutes(server.network(), { 'valid.test': closed }),
    );
    const ep = target(s);
    expect(ep).toMatchObject({
      host: 'www.valid.test',
      servername: 'www.valid.test',
      port: 443,
      outcome: 'handshake',
      ip: '127.0.0.1',
      family: 4,
      protocol: 'TLSv1.3',
      authorized: true,
      authorizationError: null,
      hostnameMatches: true,
      chainComplete: true,
      trustStore: 'test',
    });
    expect(ep.cipher).toBeTruthy();
    expect(ep.chain).toHaveLength(2);
    expect(ep.chain[0]).toMatchObject({
      subject: 'CN=www.valid.test',
      issuer: 'CN=dsgvo-check Test CA, O=dsgvo-check tests',
      subjectAltNames: ['DNS:www.valid.test'],
      isCa: false,
      selfSigned: false,
      keyType: 'ec',
      keyBits: 256,
    });
    expect(ep.chain[1]).toMatchObject({ isCa: true, selfSigned: true });
    expect(s.endpoints.find((e) => e.hostVariant === 'apex')?.outcome).toBe('connection-refused');
    expect(tls02Variants('https://www.valid.test/', s)).toEqual([]);
  });

  it.each([
    ['www.expired.test', 'CERT_HAS_EXPIRED', 'expired'],
    ['www.wrongname.test', 'ERR_TLS_CERT_ALTNAME_INVALID', 'name-mismatch'],
    ['www.selfsigned.test', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed'],
  ])('%s → %s → TLS-02 certificate-invalid (%s)', async (host, error, reason) => {
    const apex = host.replace(/^www\./, '');
    const s = await endpoints(`https://${host}/`, withRoutes(server.network(), { [apex]: closed }));
    expect(target(s)).toMatchObject({ outcome: 'handshake', authorized: false, authorizationError: error });
    const r = tls02Result(`https://${host}/`, s);
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(r.outcome?.observations[0]?.params).toMatchObject({ reason });
  });

  it('wrong name is detected by our own checkHost', async () => {
    const s = await endpoints(
      'https://www.wrongname.test/',
      withRoutes(server.network(), { 'wrongname.test': closed }),
    );
    expect(target(s).hostnameMatches).toBe(false);
    expect(target(s).chain[0]?.subjectAltNames).toEqual(['DNS:*.alfahosting-server.de']);
  });

  it('expiring certificate (10 of 90 days left) → certificate-expiring', async () => {
    const s = await endpoints(
      'https://www.expiring.test/',
      withRoutes(server.network(), { 'expiring.test': closed }),
    );
    expect(target(s).authorized).toBe(true);
    expect(tls02Variants('https://www.expiring.test/', s)).toEqual(['certificate-expiring']);
  });

  it('closed port 443 → connection-refused, TLS-02 not applicable', async () => {
    const s = await endpoints(
      'https://www.noport.test/',
      withRoutes(server.network(), { 'www.noport.test': closed, 'noport.test': closed }),
    );
    expect(target(s)).toMatchObject({
      outcome: 'connection-refused',
      chain: [],
      error: { code: 'ECONNREFUSED' },
    });
    expect(
      runCheck(
        tls02,
        makeSnapshot({ target: makeTarget('https://www.noport.test/'), tls: s, http: makeHttp() }),
      ),
    ).toMatchObject({ status: 'not_applicable', reason: 'no-https' });
  });

  it('server that never completes the handshake → timeout, TLS-02 inconclusive', async () => {
    const silent = await silentServer();
    try {
      const res = await createTlsCollector({ timeoutMs: 500 })(
        collectorContext(
          'https://www.slow.test/',
          withRoutes(server.network(), { 'www.slow.test': silent.port, 'slow.test': closed }),
        ),
      );
      const s = res.sections.tls as TlsSection;
      expect(target(s)).toMatchObject({ outcome: 'timeout', error: { code: 'timeout' } });
      expect(
        runCheck(
          tls02,
          makeSnapshot({ target: makeTarget('https://www.slow.test/'), tls: s, http: makeHttp() }),
        ),
      ).toMatchObject({ status: 'inconclusive', reason: 'handshake-inconclusive' });
    } finally {
      await silent.close();
    }
  });
});

describe('TLS collector: certificate chains', () => {
  const chainNet = (port: number, trustRoot = true) =>
    withRoutes(
      server.network(),
      { 'www.chain.test:443': port, 'chain.test': closed },
      trustRoot ? [pki.rootPem] : [],
    );

  it('full chain (leaf + intermediate), trusted root → complete', async () => {
    const s = await endpoints('https://www.chain.test/', chainNet(fullChain));
    expect(target(s)).toMatchObject({ authorized: true, chainComplete: true });
    expect(target(s).chain.map((c) => c.subject)).toEqual([
      'CN=www.chain.test',
      'CN=dsgvo-check Chain Intermediate',
      'CN=dsgvo-check Chain Root',
    ]);
    expect(tls02Variants('https://www.chain.test/', s)).toEqual([]);
  });

  it('leaf only (intermediate missing) → UNABLE_TO_VERIFY_LEAF_SIGNATURE → chain-incomplete (warning)', async () => {
    const s = await endpoints('https://www.chain.test/', chainNet(leafOnly));
    expect(target(s)).toMatchObject({
      authorized: false,
      authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      chainComplete: false,
      hostnameMatches: true,
    });
    expect(tls02Variants('https://www.chain.test/', s)).toEqual(['chain-incomplete']);
  });

  it('leaf + intermediate sent, root not in the client store → UNABLE_TO_GET_ISSUER_CERT_LOCALLY → certificate-invalid (R20)', async () => {
    const s = await endpoints('https://www.chain.test/', chainNet(fullChain, false));
    expect(target(s)).toMatchObject({
      authorized: false,
      authorizationError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      chainComplete: false,
      hostnameMatches: true,
    });
    expect(target(s).chain.map((c) => c.subject)).toEqual([
      'CN=www.chain.test',
      'CN=dsgvo-check Chain Intermediate',
    ]);
    const r = tls02Result('https://www.chain.test/', s);
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(r.outcome?.observations[0]?.params).toMatchObject({ reason: 'untrusted-root' });
  });

  it('chain up to an untrusted root that the server also sends → certificate-invalid (untrusted-root)', async () => {
    const s = await endpoints('https://www.chain.test/', chainNet(withRoot, false));
    expect(target(s)).toMatchObject({ authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN', chainComplete: true });
    const r = tls02Result('https://www.chain.test/', s);
    expect(variantsOf(r)).toEqual(['certificate-invalid']);
    expect(r.outcome?.observations[0]?.params).toMatchObject({ reason: 'untrusted-root' });
  });

  it('S-20: an https target with an explicit port is probed on that port', async () => {
    const s = await endpoints(
      'https://www.valid.test:8443/',
      withRoutes(server.network(), { 'www.valid.test:8443': server.httpsPort, 'valid.test': closed }),
    );
    expect(target(s)).toMatchObject({ port: 8443, outcome: 'handshake', authorized: true });
    expect(s.endpoints.find((e) => e.hostVariant === 'apex')?.port).toBe(443);
    expect(tls02Variants('https://www.valid.test:8443/', s)).toEqual([]);
  });
});

describe('TLS collector through --proxy (no test routing)', () => {
  const proxyNetwork = (proxy: string): NetworkConfig => ({
    proxy,
    allowPrivateAddresses: false,
    lookup: async () => {
      throw new Error('lookup must not be used behind a proxy');
    },
    dnsServers: [],
  });

  it('HTTP CONNECT tunnel: handshake via the proxy, peer address unknown', async () => {
    const proxy = await httpProxy(server.httpPort, server.httpsPort);
    try {
      const res = await createTlsCollector({ timeoutMs: 3_000 })(
        collectorContext('https://www.valid.test/', proxyNetwork(proxy.url)),
      );
      const ep = target(res.sections.tls as TlsSection);
      // The label follows the CA setting of this process (G46): `system` with NODE_USE_SYSTEM_CA=1, else the bundle.
      expect(ep).toMatchObject({
        outcome: 'handshake',
        ip: null,
        family: null,
        trustStore: detectTrustStore(),
      });
      // The test CA is in neither the bundled nor the system store.
      expect(ep.authorized).toBe(false);
      expect(ep.chain[0]?.subject).toBe('CN=www.valid.test');
      expect(proxy.targets).toContain('www.valid.test:443');
    } finally {
      await proxy.close();
    }
  });

  it('SOCKS5 tunnel', async () => {
    const proxy = await socksProxy(server.httpsPort);
    try {
      const res = await createTlsCollector({ timeoutMs: 3_000 })(
        collectorContext('https://www.valid.test/', proxyNetwork(proxy.url)),
      );
      const ep = target(res.sections.tls as TlsSection);
      expect(ep).toMatchObject({ outcome: 'handshake', ip: null });
      expect(ep.chain[0]?.subject).toBe('CN=www.valid.test');
      expect(proxy.targets).toContain('www.valid.test:443');
    } finally {
      await proxy.close();
    }
  });
});

describe('SSRF guard (no test routing)', () => {
  it('a host resolving only to loopback is not contacted', async () => {
    const res = await collector(
      collectorContext('https://www.valid.test/', {
        proxy: null,
        allowPrivateAddresses: false,
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        dnsServers: [],
      }),
    );
    const ep = target(res.sections.tls as TlsSection);
    expect(ep).toMatchObject({ outcome: 'error', error: { code: 'private-address' } });
  });
});
