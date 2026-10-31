/**
 * Tunnel for `--proxy` (HTTP CONNECT or SOCKS5 with optional user/password, RFC 1928/1929), so that the TLS
 * handshake of the TLS collector goes through the same egress as the other collectors. The proxy resolves the
 * hostname (socks5h semantics); the peer address is then unknown to us.
 */
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';

export class TunnelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
  }
}

export async function openTunnel(
  proxy: string,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const u = new URL(proxy);
  if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') return socks5(u, host, port, timeoutMs);
  if (u.protocol === 'http:' || u.protocol === 'https:') return httpConnect(u, host, port, timeoutMs);
  throw new TunnelError('proxy-unsupported', `unsupported proxy scheme ${u.protocol}`);
}

function httpConnect(u: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const auth =
      u.username || u.password
        ? {
            'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`,
          }
        : {};
    const req = (u.protocol === 'https:' ? https : http).request({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...auth },
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new TunnelError('proxy-refused', `proxy CONNECT answered ${res.statusCode}`));
      }
    });
    req.on('timeout', () => req.destroy(new TunnelError('ETIMEDOUT', 'proxy CONNECT timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Reads exactly n bytes from a socket in paused mode. */
function reader(socket: Socket) {
  let buf = Buffer.alloc(0);
  const waiting: Array<() => void> = [];
  socket.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (const w of waiting.splice(0)) w();
  });
  return async (n: number): Promise<Buffer> => {
    while (buf.length < n) {
      await new Promise<void>((resolve, reject) => {
        waiting.push(resolve);
        socket.once('close', () =>
          reject(new TunnelError('proxy-closed', 'SOCKS proxy closed the connection')),
        );
      });
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
}

async function socks5(u: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const socket = net.connect({ host: u.hostname, port: Number(u.port || 1080) });
  socket.setTimeout(timeoutMs, () => socket.destroy(new TunnelError('ETIMEDOUT', 'SOCKS proxy timed out')));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const read = reader(socket);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await read(2);
  if (ver !== 5 || method === 0xff) throw new TunnelError('proxy-refused', 'SOCKS proxy refused all methods');
  if (method === 2) {
    socket.write(
      Buffer.concat([
        Buffer.from([1, Buffer.byteLength(user)]),
        Buffer.from(user),
        Buffer.from([Buffer.byteLength(pass)]),
        Buffer.from(pass),
      ]),
    );
    const [, status] = await read(2);
    if (status !== 0) throw new TunnelError('proxy-auth', 'SOCKS authentication failed');
  }
  const name = Buffer.from(host);
  socket.write(
    Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]),
  );
  const head = await read(4);
  if (head[1] !== 0) throw new TunnelError('proxy-refused', `SOCKS CONNECT failed (${head[1]})`);
  const atyp = head[3];
  const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : ((await read(1))[0] ?? 0);
  await read(addrLen + 2);
  socket.removeAllListeners('data');
  socket.removeAllListeners('close');
  socket.pause();
  socket.setTimeout(0);
  return socket;
}
