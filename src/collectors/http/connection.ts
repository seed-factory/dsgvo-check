// Where a probe connects and what it learns about the connection. The SSRF guard is shared by the HTTP client and the
// TLS probe: a socket goes only to an address that passed `isPublicAddress` (tests route through `network.test`).
import { isIP, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { isPublicAddress, type NetworkConfig } from '../../core/url/net.ts';
import { ProbeError } from './errors.ts';

export interface ConnectionFacts {
  ip: string | null;
  family: 4 | 6 | null;
  /** https only; null for http and behind a proxy. */
  authorized: boolean | null;
  authorizationError: string | null;
  protocol: string | null;
}

// Test routing, or a resolved address that passed the SSRF guard (a host without a public address is refused unless
// private addresses are allowed).
export async function routeToPublic(
  network: NetworkConfig,
  hostname: string,
  port: number,
): Promise<{ host: string; port: number }> {
  if (network.test) return network.test.connect(hostname, port);
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await network.lookup(hostname).catch((err: NodeJS.ErrnoException) => {
        throw new ProbeError(err.code ?? 'ENOTFOUND', `DNS lookup failed for ${hostname}`, { cause: err });
      });
  if (addresses.length === 0) throw new ProbeError('ENOTFOUND', `no addresses for ${hostname}`);
  const allowed = addresses.find((a) => network.allowPrivateAddresses || isPublicAddress(a.address));
  if (!allowed) throw new ProbeError('private-address', `${hostname} resolves to non-public addresses only`);
  return { host: allowed.address, port };
}

/** Short form of a socket's `authorizationError`: a string as it is, an error by its `code`. */
export function authorizationErrorCode(err: unknown): string | null {
  if (err === null || err === undefined) return null;
  if (typeof err === 'string') return err;
  return (err as { code?: string }).code ?? String(err);
}

function familyOf(f: string | number | undefined): 4 | 6 | null {
  if (f === 'IPv4' || f === 4) return 4;
  if (f === 'IPv6' || f === 6) return 6;
  return null;
}

export function connectionFacts(socket: Socket, tls: boolean): ConnectionFacts {
  const s = socket as TLSSocket;
  return {
    ip: socket.remoteAddress ?? null,
    family: familyOf(socket.remoteFamily),
    authorized: tls ? s.authorized : null,
    authorizationError: tls ? authorizationErrorCode(s.authorizationError) : null,
    protocol: tls ? (s.getProtocol?.() ?? null) : null,
  };
}
