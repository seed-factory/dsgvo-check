// One TLS handshake with node:tls for the TLS and HTTP collectors: SNI = host (none for IP targets),
// `rejectUnauthorized: false`, default Node trust store or the test CA. Own name check via `X509Certificate.checkHost`
// / `checkIP`: Node skips it when chain verification already failed. `chainComplete` = the chain ends at a self-signed
// certificate. SSRF guard as in the HTTP client; `--proxy` → CONNECT tunnel.
import { X509Certificate } from 'node:crypto';
import { isIP, type Socket } from 'node:net';
import tls, { type DetailedPeerCertificate, type TLSSocket } from 'node:tls';
import { errorMessage } from '../../core/runtime/errors.ts';
import type { CollectorContext } from '../../core/snapshot/collector.ts';
import { detectTrustStore } from '../../core/snapshot/index.ts';
import type { CertificateInfo, TlsEndpoint } from '../../core/snapshot/tls.ts';
import { DNS_ERROR_CODES, ProbeError, routeToPublic } from '../http/client.ts';
import type { HostTarget } from '../http/hosts.ts';
import { openTunnel } from './tunnel.ts';

export const DEFAULT_TLS_TIMEOUT_MS = 10_000;

function dn(value: string | undefined): string {
  return (value ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

function keyInfo(x: X509Certificate): { keyType?: string; keyBits?: number } {
  const k = x.publicKey;
  const type = k.asymmetricKeyType;
  const d = k.asymmetricKeyDetails;
  const curveBits: Record<string, number> = { prime256v1: 256, secp384r1: 384, secp521r1: 521 };
  const bits = d?.modulusLength ?? (d?.namedCurve ? curveBits[d.namedCurve] : undefined);
  return { ...(type ? { keyType: type } : {}), ...(bits ? { keyBits: bits } : {}) };
}

export function certificateInfo(x: X509Certificate): CertificateInfo {
  let selfSigned = false;
  try {
    selfSigned = x.checkIssued(x) && x.verify(x.publicKey);
  } catch {
    selfSigned = false;
  }
  return {
    subject: dn(x.subject),
    issuer: dn(x.issuer),
    subjectAltNames: (x.subjectAltName ?? '')
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
    notBefore: x.validFromDate.toISOString(),
    notAfter: x.validToDate.toISOString(),
    serialNumber: x.serialNumber,
    fingerprint256: x.fingerprint256,
    isCa: x.ca,
    selfSigned,
    ...keyInfo(x),
  };
}

/** Leaf first; stops at a self-reference (root) or a missing issuer. */
export function chainOf(peer: DetailedPeerCertificate): X509Certificate[] {
  const out: X509Certificate[] = [];
  const seen = new Set<string>();
  let c: DetailedPeerCertificate | undefined = peer;
  while (c?.raw && !seen.has(c.fingerprint256) && out.length < 10) {
    seen.add(c.fingerprint256);
    out.push(new X509Certificate(c.raw));
    c = c.issuerCertificate;
  }
  return out;
}

async function route(
  ctx: Pick<CollectorContext, 'network'>,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ host: string; port: number } | { socket: Socket }> {
  const { network } = ctx;
  if (network.proxy && !network.test)
    return { socket: await openTunnel(network.proxy, host, port, timeoutMs) };
  return routeToPublic(network, host, port);
}

function outcomeOf(code: string): TlsEndpoint['outcome'] {
  if (code === 'ECONNREFUSED') return 'connection-refused';
  if (DNS_ERROR_CODES.includes(code)) return 'dns-error';
  if (code === 'ETIMEDOUT' || code === 'timeout') return 'timeout';
  return 'error';
}

function handshake(
  options: tls.ConnectionOptions,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options);
    const fail = (err: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new ProbeError('timeout', `handshake timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = () => fail(new ProbeError('timeout', 'scan deadline reached'));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

// `role: 'final'` marks the final host of a redirect to another registrable domain and its www/apex (`hostVariant` is
// then relative to that domain).
export async function probeTlsEndpoint(
  ctx: Pick<CollectorContext, 'network' | 'signal' | 'now'>,
  t: HostTarget,
  port: number,
  timeoutMs: number,
  role?: 'final',
): Promise<TlsEndpoint> {
  const bare = t.host.replace(/^\[|\]$/g, '');
  const sni = isIP(bare) ? null : bare;
  const ep: TlsEndpoint = {
    id: role ? `tls-${role}-${t.hostVariant}` : `tls-${t.hostVariant}`,
    hostVariant: t.hostVariant,
    ...(role ? { role } : {}),
    host: t.host,
    port,
    servername: sni ?? '',
    ip: null,
    family: null,
    outcome: 'error',
    protocol: null,
    cipher: null,
    authorized: false,
    authorizationError: null,
    hostnameMatches: null,
    chainComplete: null,
    trustStore: ctx.network.test ? 'test' : detectTrustStore(),
    chain: [],
    observedAt: ctx.now().toISOString(),
  };
  let socket: TLSSocket | null = null;
  try {
    const to = await route(ctx, bare, port, timeoutMs);
    socket = await handshake(
      {
        ...('socket' in to ? { socket: to.socket } : { host: to.host, port: to.port }),
        ...(sni ? { servername: sni } : {}),
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
        ...(ctx.network.test ? { ca: ctx.network.test.caPem } : {}),
      },
      timeoutMs,
      ctx.signal,
    );
    const peer = socket.getPeerCertificate(true);
    const chain = peer?.raw ? chainOf(peer) : [];
    const leaf = chain[0];
    const infos = chain.map(certificateInfo);
    const authError = socket.authorizationError as unknown;
    ep.outcome = 'handshake';
    ep.ip = ctx.network.proxy && !ctx.network.test ? null : (socket.remoteAddress ?? null);
    ep.family = ep.ip ? (isIP(ep.ip) === 6 ? 6 : 4) : null;
    ep.protocol = socket.getProtocol();
    ep.cipher = socket.getCipher()?.name ?? null;
    ep.authorized = socket.authorized;
    ep.authorizationError =
      authError === null || authError === undefined
        ? null
        : typeof authError === 'string'
          ? authError
          : ((authError as { code?: string }).code ?? String(authError));
    ep.hostnameMatches = leaf
      ? sni
        ? leaf.checkHost(sni) !== undefined
        : leaf.checkIP(bare) !== undefined
      : null;
    ep.chainComplete = infos.length > 0 ? socket.authorized || (infos.at(-1)?.selfSigned ?? false) : null;
    ep.chain = infos;
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'error';
    ep.outcome = outcomeOf(code);
    ep.error = {
      code: ep.outcome === 'timeout' ? 'timeout' : code,
      message: errorMessage(err).slice(0, 300),
      phase: 'tls',
    };
  } finally {
    socket?.destroy();
  }
  return ep;
}
