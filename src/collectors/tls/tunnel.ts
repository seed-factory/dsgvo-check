// HTTP CONNECT tunnel for `--proxy`, so the TLS collector uses the same egress as the other collectors. The proxy
// resolves the hostname; the peer address is then unknown to us.
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { defaultHttpPort, isHttpUrl } from '../../core/url/url.ts';

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
  if (!isHttpUrl(u)) throw new TunnelError('proxy-unsupported', `unsupported proxy scheme ${u.protocol}`);
  return new Promise((resolve, reject) => {
    const auth =
      u.username || u.password
        ? {
            'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`,
          }
        : {};
    const req = (u.protocol === 'https:' ? https : http).request({
      host: u.hostname,
      port: u.port || defaultHttpPort(u.protocol),
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
