import { once } from 'node:events';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getCACertificates, setDefaultCACertificates, TLSSocket } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openTunnel } from '../../../src/collectors/tls/tunnel.ts';
import { createTestPki, type IssuedCert } from '../../utils/certs.ts';

const defaultCertificates = getCACertificates('default');
const cleanup: Array<() => Promise<void>> = [];
let certificate: IssuedCert;

beforeAll(async () => {
  const pki = await createTestPki();
  certificate = await pki.issue({ hosts: ['localhost'], selfSigned: true });
});

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    // The proxy uses the process trust store, so restore it before the next case in this isolated worker.
    setDefaultCACertificates(defaultCertificates);
  }
});

async function listen(server: net.Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return (server.address() as AddressInfo).port;
}

function track(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => undefined);
}

function dispose(server: net.Server, sockets: Set<Duplex>): () => Promise<void> {
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
}

async function echoServer(): Promise<number> {
  const sockets = new Set<Duplex>();
  const server = net.createServer((socket) => {
    track(sockets, socket);
    socket.pipe(socket);
  });
  const port = await listen(server, '127.0.0.1');
  cleanup.push(dispose(server, sockets));
  return port;
}

async function httpsProxy(targetPort: number, status = 200) {
  const sockets = new Set<Duplex>();
  const requests: Array<{ authority: string; authorization: string | undefined }> = [];
  const server = https.createServer({ cert: certificate.certPem, key: certificate.keyPem });
  server.on('connection', (socket) => track(sockets, socket));
  server.on('secureConnection', (socket) => track(sockets, socket));
  server.on('connect', (request, client, head) => {
    requests.push({ authority: request.url ?? '', authorization: request.headers['proxy-authorization'] });
    track(sockets, client);
    if (status !== 200) {
      client.end(`HTTP/1.1 ${status} Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    // The requested authority is recorded, but every connection stays on the local echo server.
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(sockets, upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const port = await listen(server, 'localhost');
  cleanup.push(dispose(server, sockets));
  return { url: `https://localhost:${port}`, requests };
}

describe('CONNECT through an HTTPS proxy', () => {
  it('validates the proxy certificate before sending a CONNECT request', async () => {
    const proxy = await httpsProxy(await echoServer());

    await expect(openTunnel(proxy.url, 'localhost', 443, 3_000)).rejects.toMatchObject({
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    expect(proxy.requests).toEqual([]);
  });

  it('uses TLS to the trusted proxy and carries bidirectional data after authenticated CONNECT', async () => {
    setDefaultCACertificates([...defaultCertificates, certificate.certPem]);
    const proxy = await httpsProxy(await echoServer());
    const url = new URL(proxy.url);
    url.username = 'fixture-user';
    url.password = 'fixture-pass';

    const socket = await openTunnel(url.href, 'localhost', 443, 3_000);
    try {
      expect(socket).toBeInstanceOf(TLSSocket);
      expect((socket as TLSSocket).authorized).toBe(true);
      const received = once(socket, 'data');
      socket.write('tunnel-payload');
      expect((await received)[0].toString()).toBe('tunnel-payload');
      expect(proxy.requests).toEqual([
        {
          authority: 'localhost:443',
          authorization: `Basic ${Buffer.from('fixture-user:fixture-pass').toString('base64')}`,
        },
      ]);
    } finally {
      socket.destroy();
    }
  });

  it('reports a CONNECT refusal from the trusted HTTPS proxy', async () => {
    setDefaultCACertificates([...defaultCertificates, certificate.certPem]);
    const proxy = await httpsProxy(await echoServer(), 407);

    await expect(openTunnel(proxy.url, 'localhost', 443, 3_000)).rejects.toMatchObject({
      name: 'TunnelError',
      code: 'proxy-refused',
      message: 'proxy CONNECT answered 407',
    });
    expect(proxy.requests).toEqual([{ authority: 'localhost:443', authorization: undefined }]);
  });
});
