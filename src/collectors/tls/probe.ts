// One TLS handshake with node:tls for the TLS and HTTP collectors: SNI = host (none for IP targets),
// `rejectUnauthorized: false`, default Node trust store or the test CA. Own name check via `X509Certificate.checkHost`
// / `checkIP`: Node skips it when chain verification already failed. `chainComplete` = the chain ends at a self-signed
// certificate. SSRF guard as in the HTTP client; `--proxy` → CONNECT tunnel.
import { X509Certificate } from 'node:crypto';
import { isIP, type Socket } from 'node:net';
import tls, { type DetailedPeerCertificate, type TLSSocket } from 'node:tls';
import { redactText } from '../../core/redaction/redact.ts';
import { errorMessage } from '../../core/runtime/errors.ts';
import type { CollectorContext } from '../../core/snapshot/collector.ts';
import { detectTrustStore } from '../../core/snapshot/index.ts';
import type { CertificateInfo, TlsEndpoint } from '../../core/snapshot/tls.ts';
import { hasAddressMarker, REDACTED } from '../../core/url/email.ts';
import { defaultHttpPort } from '../../core/url/url.ts';
import { authorizationErrorCode, routeToPublic } from '../http/connection.ts';
import { DNS_ERROR_CODES, ProbeError } from '../http/errors.ts';
import type { HostTarget } from '../http/hosts.ts';
import { openTunnel } from './tunnel.ts';

/** Standard HTTPS port: the handshake port of every host variant unless a URL names another one. */
export const DEFAULT_TLS_PORT = defaultHttpPort('https:');
/** Bits of the named curves Node reports for EC keys (RSA reports `modulusLength`). */
const CURVE_BITS: Readonly<Record<string, number>> = { prime256v1: 256, secp384r1: 384, secp521r1: 521 };
/** Longest chain read from a peer certificate; guards against a very long or looping issuer chain. */
const MAX_CHAIN_LENGTH = 10;
/** HTTP/1.1 only, like the HTTP client. */
const ALPN_PROTOCOLS = ['http/1.1'];

/** `[redacted]@domain` as `redactText` writes a masked address. */
const ADDRESS_MASK = /\[redacted\]@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/gu;

/**
 * A name value that shows an `@` (also escaped, percent-encoded or without a dotted domain) as the domain of its last
 * address, `[redacted]` when no address is read from it; null when it shows none. Only the mask is kept: a local part
 * may hold characters that end it in free text (`"`, `,`), so text around a mask could still be part of it.
 */
function maskedName(plain: string): string | null {
  if (!hasAddressMarker(plain)) return null;
  return redactText(plain).match(ADDRESS_MASK)?.at(-1) ?? REDACTED;
}

/** RFC 4514 escapes as Node writes them in a DN: `\` before a special character, `\HH` for a control character. */
const DN_ESCAPE = /\\(?:([0-9a-f]{2})|([\s\S]))/gi;

const unescapedDn = (value: string) =>
  value.replace(DN_ESCAPE, (_m, hex: string | undefined, char: string | undefined) =>
    hex === undefined ? (char ?? '') : String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** A query in a name value, up to the next blank: Node's escapes (`\"`, `\<`) end none. */
const NAME_QUERY = /\?\S+/g;
/** A fragment glued to the text before it, up to the next blank. */
const NAME_FRAGMENT = /(?<=\S)#\S+/g;

/**
 * A name value without an address, as Node writes it: URLs and `mailto:` values redacted as in free text, then every
 * query, also of a relative URL or one of another scheme, cut to `?[redacted]` and every fragment dropped. `\#` at the
 * start is Node's escape of a leading `#`, no fragment.
 */
function redactedNameValue(value: string): string {
  return redactText(value)
    .replace(NAME_QUERY, `?${REDACTED}`)
    .replace(NAME_FRAGMENT, (fragment, at: number, text: string) =>
      at === 1 && text[0] === '\\' ? fragment : '',
    );
}

/** One `type=value` attribute; a value with an address is stored as `maskedName` reads it, any other redacted as written. */
function redactedAttribute(attribute: string): string {
  const eq = attribute.indexOf('=');
  const value = attribute.slice(eq + 1);
  return `${attribute.slice(0, eq + 1)}${maskedName(unescapedDn(value)) ?? redactedNameValue(value)}`;
}

/**
 * A distinguished name on one line, as Node writes it: one RDN per line, the attributes of a multi-valued one joined
 * by ` + ` (a `+` in a value is escaped). An attribute value with an address keeps only its domain, one with a URL
 * no query or fragment.
 */
function dn(value: string | undefined): string {
  return (value ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((rdn) => rdn.split(' + ').map(redactedAttribute).join(' + '))
    .join(', ');
}

const DNS_PREFIX = 'DNS:';
const IP_PREFIX = 'IP Address:';

/** A host name as a `DNS:` entry holds one: labels of letters, digits, `-` and `_`, a leading `*.`, a trailing dot. */
const DNS_HOST = /^(?:\*\.)?[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.?$/u;

/**
 * A `DNS:` name is any text the owner chose: one with an address keeps only its domain, read from the JSON string Node
 * writes for a value with `,` or `"`; one that is no host name (a URL, a path, a query) is `[redacted]`.
 */
function redactedDnsName(entry: string): string {
  const value = entry.slice(DNS_PREFIX.length);
  let plain = value;
  if (value.startsWith('"')) {
    try {
      plain = String(JSON.parse(value));
    } catch {
      // not the JSON string Node writes: the text as it is
    }
  }
  const masked = maskedName(plain);
  if (masked !== null) return `${DNS_PREFIX}${masked}`;
  return DNS_HOST.test(plain) ? entry : `${DNS_PREFIX}${REDACTED}`;
}

/**
 * The `DNS:` and `IP Address:` entries of Node's `subjectAltName` list, the ones the name check reads; e-mail
 * addresses, URIs and other names are not stored. Node writes a value that holds `,` or `"` as a JSON string, so the
 * list is split outside quotes only: text inside a quoted URI is no entry of its own.
 */
function hostAltNames(list: string | undefined): string[] {
  const s = list ?? '';
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',' || c === undefined) {
      const entry = s.slice(start, i).trim();
      if (entry.startsWith(DNS_PREFIX)) out.push(redactedDnsName(entry));
      else if (entry.startsWith(IP_PREFIX)) out.push(entry);
      start = i + 1;
    }
  }
  return out;
}

function keyInfo(x: X509Certificate): { keyType?: string; keyBits?: number } {
  const k = x.publicKey;
  const type = k.asymmetricKeyType;
  const d = k.asymmetricKeyDetails;
  const bits = d?.modulusLength ?? (d?.namedCurve ? CURVE_BITS[d.namedCurve] : undefined);
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
    subjectAltNames: hostAltNames(x.subjectAltName),
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

  while (c?.raw && !seen.has(c.fingerprint256) && out.length < MAX_CHAIN_LENGTH) {
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

    // Stops the timer and the abort listener once the handshake has an outcome.
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      settle();
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
      settle();
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

/**
 * Name check of the leaf: by host name for SNI targets, by address for IP targets. Host names are matched against the
 * subject alternative names only, as browsers do; Node would fall back to the CN of a certificate without them.
 */
function leafMatches(leaf: X509Certificate | undefined, sni: string | null, bare: string): boolean | null {
  if (!leaf) return null;
  return sni ? leaf.checkHost(sni, { subject: 'never' }) !== undefined : leaf.checkIP(bare) !== undefined;
}

/** The endpoint before any connection: outcome `error` until a handshake or a failure is recorded. */
function pendingEndpoint(
  ctx: Pick<CollectorContext, 'network' | 'now'>,
  t: HostTarget,
  port: number,
  sni: string | null,
  role?: 'final',
): TlsEndpoint {
  return {
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
}

/** Copies what the finished handshake showed into `ep`. */
function recordHandshake(
  ep: TlsEndpoint,
  socket: TLSSocket,
  ctx: Pick<CollectorContext, 'network'>,
  sni: string | null,
  bare: string,
): void {
  const peer = socket.getPeerCertificate(true);
  const chain = peer?.raw ? chainOf(peer) : [];
  const leaf = chain[0];
  const infos = chain.map(certificateInfo);

  ep.outcome = 'handshake';
  ep.ip = ctx.network.proxy && !ctx.network.test ? null : (socket.remoteAddress ?? null);
  ep.family = ep.ip ? (isIP(ep.ip) === 6 ? 6 : 4) : null;
  ep.protocol = socket.getProtocol();
  ep.cipher = socket.getCipher()?.name ?? null;
  ep.authorized = socket.authorized;
  ep.authorizationError = authorizationErrorCode(socket.authorizationError);
  ep.hostnameMatches = leafMatches(leaf, sni, bare);
  ep.chainComplete = infos.length > 0 ? socket.authorized || (infos.at(-1)?.selfSigned ?? false) : null;
  ep.chain = infos;
}

function recordFailure(ep: TlsEndpoint, err: unknown): void {
  const code = (err as { code?: string }).code ?? 'error';
  ep.outcome = outcomeOf(code);
  ep.error = {
    code: ep.outcome === 'timeout' ? 'timeout' : code,
    message: errorMessage(err).slice(0, 300),
    phase: 'tls',
  };
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
  const ep = pendingEndpoint(ctx, t, port, sni, role);
  let socket: TLSSocket | null = null;

  try {
    const to = await route(ctx, bare, port, timeoutMs);
    socket = await handshake(
      {
        ...('socket' in to ? { socket: to.socket } : { host: to.host, port: to.port }),
        ...(sni ? { servername: sni } : {}),
        rejectUnauthorized: false,
        ALPNProtocols: ALPN_PROTOCOLS,
        ...(ctx.network.test ? { ca: ctx.network.test.caPem } : {}),
      },
      timeoutMs,
      ctx.signal,
    );
    recordHandshake(ep, socket, ctx, sni, bare);
  } catch (err) {
    recordFailure(ep, err);
  } finally {
    socket?.destroy();
  }

  return ep;
}
