// Polite HTTP client for passive probes: undici, no redirects, cookies or HSTS cache, honest UA (token only); ≤ 2
// requests per second per host (by request start); TLS with `rejectUnauthorized: false` (Node's verdict is recorded per
// connection); SSRF guard: connections go only to addresses from `network.lookup` that passed `isPublicAddress` (tests
// route through `network.test.connect` and trust `network.test.caPem`).
import { isIP, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import zlib from 'node:zlib';
import { Agent, buildConnector, type Dispatcher, ProxyAgent } from 'undici';
import { snapshotHeaderRecords } from '../../core/redaction/headers.ts';
import { ACCEPT_LANGUAGE } from '../../core/runtime/user-agent.ts';
import type { HeaderRecord } from '../../core/snapshot/common.ts';
import { isPublicAddress, type NetworkConfig } from '../../core/url/net.ts';
import { defaultHttpPort } from '../../core/url/url.ts';

export const DEFAULT_MIN_INTERVAL_MS = 500;

export interface ClientTimeouts {
  connectMs: number;
  headersMs: number;
  bodyMs: number;
  requestMs: number;
}

export const DEFAULT_TIMEOUTS: ClientTimeouts = {
  connectMs: 5_000,
  headersMs: 10_000,
  bodyMs: 10_000,
  requestMs: 20_000,
};

export interface ConnectionFacts {
  ip: string | null;
  family: 4 | 6 | null;
  /** https only; null for http and behind a proxy. */
  authorized: boolean | null;
  authorizationError: string | null;
  protocol: string | null;
}

export interface FetchResult {
  url: string;
  status: number;
  headers: HeaderRecord[];
  setCookieNames: string[];
  /** Unsanitized: sanitize before storing. */
  location: string | null;
  contentType: string | null;
  /** Decoded body prefix (never stored). */
  body: Buffer;
  bodyBytes: number;
  bodyTruncated: boolean;
  conn: ConnectionFacts | null;
  durationMs: number;
  requestedAt: string;
}

export class ProbeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeError';
    this.code = code;
  }
}

export interface PacerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const REAL_CLOCK: PacerClock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => {
    await sleep(ms, undefined, signal ? { signal } : {});
  },
};

// Per-host pacing: request starts to one host are at least `intervalMs` apart. Slots are handed out in call order
// (`#nextAt`); the gap is measured between real starts (`#lastStart`) because a late wake-up could leave two requests
// closer than the interval, so a request that wakes too early sleeps the rest.
export class HostPacer {
  readonly #intervalMs: number;
  readonly #clock: PacerClock;
  readonly #nextAt = new Map<string, number>();
  readonly #lastStart = new Map<string, number>();
  constructor(intervalMs: number, clock: PacerClock = REAL_CLOCK) {
    this.#intervalMs = intervalMs;
    this.#clock = clock;
  }
  async wait(host: string, signal?: AbortSignal): Promise<void> {
    const now = this.#clock.now();
    const at = Math.max(now, this.#nextAt.get(host) ?? 0);
    this.#nextAt.set(host, at + this.#intervalMs);
    if (at > now) await this.#clock.sleep(at - now, signal);
    for (;;) {
      const start = this.#clock.now();
      const earliest = (this.#lastStart.get(host) ?? Number.NEGATIVE_INFINITY) + this.#intervalMs;
      if (start >= earliest) {
        this.#lastStart.set(host, start);
        return;
      }
      await this.#clock.sleep(earliest - start, signal);
    }
  }
  defer(host: string, ms: number): void {
    this.#nextAt.set(host, Math.max(this.#nextAt.get(host) ?? 0, this.#clock.now() + ms));
  }
}

/** Pause after the third 429/503 in a row when the server sends no usable Retry-After. */
export const DEFAULT_THROTTLE_PAUSE_MS = 2_000;
export const MAX_RETRY_AFTER_MS = 30_000;
export const THROTTLE_SERIES = 3;

/** `Retry-After` as delay-seconds or HTTP-date (RFC 9110 §10.2.3); null when absent or unusable. */
export function retryAfterMs(value: string | null, now: number): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const isOverload = (status: number) => status === 429 || status === 503;

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

/** Isolated per host, so one host cannot stop probes to another. */
interface HostThrottle {
  consecutive: number;
  retried: boolean;
  stopped: boolean;
}

const SET_COOKIE = 'set-cookie';

function cookieName(setCookie: string): string {
  return (setCookie.split(';')[0] ?? '').split('=')[0]?.trim() ?? '';
}

// Header records for the snapshot via the core normalizer shared with the browser: no Set-Cookie values (names only),
// URL headers resolved against `base` (the response URL) and sanitized.
export function snapshotHeaders(
  raw: Record<string, string | string[] | undefined>,
  base = 'https://invalid.invalid/',
): {
  headers: HeaderRecord[];
  setCookieNames: string[];
} {
  const flat: Array<{ name: string; value: string }> = [];
  const setCookieNames: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const n = name.toLowerCase();
    for (const v of Array.isArray(value) ? value : [value]) {
      if (n === SET_COOKIE) {
        const c = cookieName(v);
        if (c) setCookieNames.push(c);
        continue;
      }
      flat.push({ name: n, value: v });
    }
  }
  return { headers: snapshotHeaderRecords(flat, base), setCookieNames };
}

function familyOf(f: string | number | undefined): 4 | 6 | null {
  if (f === 'IPv4' || f === 4) return 4;
  if (f === 'IPv6' || f === 6) return 6;
  return null;
}

function originKey(protocol: string, hostname: string, port: number): string {
  return `${protocol}//${hostname.toLowerCase()}:${port}`;
}

/** Bound of the decoded body; the compressed read is limited separately. */
export const MAX_DECODED_BYTES = 4 * 1024 * 1024;

function decompressor(enc: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  if (enc === 'gzip' || enc === 'x-gzip')
    return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (enc === 'deflate') return zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (enc === 'br')
    return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  return null;
}

// Decodes a (possibly cut) body by `Content-Encoding`, streaming, with at most `maxOutput` decoded bytes so a small
// compressed response cannot expand into hundreds of megabytes. A corrupt or cut stream yields the prefix decoded so
// far; `truncated` = the output hit the limit.
export function decodeBody(
  buf: Buffer,
  encoding: string | null,
  maxOutput: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const d = decompressor((encoding ?? '').trim().toLowerCase());
  if (!d) {
    return Promise.resolve(
      buf.length > maxOutput
        ? { body: buf.subarray(0, maxOutput), truncated: true }
        : { body: buf, truncated: false },
    );
  }
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      d.removeAllListeners('data');
      d.destroy();
      resolve({ body: Buffer.concat(out, size), truncated });
    };
    d.on('data', (chunk: Buffer) => {
      const room = maxOutput - size;
      if (chunk.length > room) {
        if (room > 0) out.push(chunk.subarray(0, room));
        size += room;
        finish(true);
        return;
      }
      out.push(chunk);
      size += chunk.length;
    });
    d.on('end', () => finish(false));
    d.on('error', () => finish(false));
    d.end(buf);
  });
}

export interface HttpClientOptions {
  network: NetworkConfig;
  userAgent: string;
  signal: AbortSignal;
  minIntervalMs?: number;
  timeouts?: Partial<ClientTimeouts>;
  now?: () => Date;
  maxDecodedBytes?: number;
  maxRetryAfterMs?: number;
}

export class HttpClient {
  readonly #network: NetworkConfig;
  readonly #ua: string;
  readonly #signal: AbortSignal;
  readonly #pacer: HostPacer;
  readonly #timeouts: ClientTimeouts;
  readonly #now: () => Date;
  readonly #maxDecoded: number;
  readonly #dispatcher: Dispatcher;
  readonly #conns = new Map<string, ConnectionFacts>();
  readonly #memo = new Map<string, Promise<FetchResult>>();
  readonly #throttle = new Map<string, HostThrottle>();
  readonly #maxRetryAfterMs: number;
  requestsIssued = 0;
  throttled = false;

  constructor(o: HttpClientOptions) {
    this.#network = o.network;
    this.#ua = o.userAgent;
    this.#signal = o.signal;
    this.#pacer = new HostPacer(o.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts };
    this.#now = o.now ?? (() => new Date());
    this.#maxDecoded = o.maxDecodedBytes ?? MAX_DECODED_BYTES;
    this.#maxRetryAfterMs = o.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
    this.#dispatcher = this.#createDispatcher();
  }

  #createDispatcher(): Dispatcher {
    const { network } = this;
    const insecure = { rejectUnauthorized: false, maxCachedSessions: 0 };
    if (network.proxy && !network.test) {
      return new ProxyAgent({ uri: network.proxy, requestTls: insecure });
    }
    const connector = buildConnector({
      ...insecure,
      timeout: this.#timeouts.connectMs,
      ...(network.test ? { ca: network.test.caPem } : {}),
    });
    return new Agent({
      connections: 2,
      headersTimeout: this.#timeouts.headersMs,
      bodyTimeout: this.#timeouts.bodyMs,
      connect: (opts, cb) => {
        const port = opts.port ? Number(opts.port) : defaultHttpPort(opts.protocol);
        const key = originKey(opts.protocol, opts.hostname, port);
        const bare = opts.hostname.replace(/^\[|\]$/g, '');
        routeToPublic(this.#network, bare, port).then(
          (to) => {
            const servername = isIP(bare) ? undefined : bare;
            connector(
              { ...opts, hostname: to.host, port: String(to.port), ...(servername ? { servername } : {}) },
              (err, socket) => {
                if (socket) this.#conns.set(key, this.#facts(socket, opts.protocol === 'https:'));
                if (err) cb(err, null);
                else cb(null, socket as Socket);
              },
            );
          },
          (err: Error) => cb(err, null),
        );
      },
    });
  }

  get network(): NetworkConfig {
    return this.#network;
  }

  #facts(socket: Socket, tls: boolean): ConnectionFacts {
    const s = socket as TLSSocket;
    const authError = tls ? (s.authorizationError as unknown) : null;
    return {
      ip: socket.remoteAddress ?? null,
      family: familyOf(socket.remoteFamily),
      authorized: tls ? s.authorized : null,
      authorizationError:
        authError === null || authError === undefined
          ? null
          : typeof authError === 'string'
            ? authError
            : ((authError as { code?: string }).code ?? String(authError)),
      protocol: tls ? (s.getProtocol?.() ?? null) : null,
    };
  }

  // No redirect following. Within one scan every URL is requested once: www/apex chains often end at the same start
  // page.
  get(url: string, readLimit: number): Promise<FetchResult> {
    const key = `${readLimit} ${url}`;
    let p = this.#memo.get(key);
    if (!p) {
      p = this.#fetch(url, readLimit);
      this.#memo.set(key, p);
    }
    return p;
  }

  get throttledHosts(): string[] {
    return [...this.#throttle.entries()]
      .filter(([, t]) => t.stopped)
      .map(([h]) => h)
      .sort();
  }

  #hostThrottle(host: string): HostThrottle {
    let t = this.#throttle.get(host);
    if (!t) {
      t = { consecutive: 0, retried: false, stopped: false };
      this.#throttle.set(host, t);
    }
    return t;
  }

  // Overload policy per host: the third 429/503 in a row → pause by `Retry-After` (≤ 30 s, within the scan deadline)
  // and one retry; a further 429/503 stops new requests to that host (SCAN-THROTTLED). Other hosts are unaffected.
  async #fetch(url: string, readLimit: number): Promise<FetchResult> {
    const host = new URL(url).hostname.toLowerCase();
    const t = this.#hostThrottle(host);
    for (;;) {
      const r = await this.#request(url, readLimit, t);
      if (!isOverload(r.status)) {
        t.consecutive = 0;
        return r;
      }
      t.consecutive++;
      if (t.consecutive < THROTTLE_SERIES) return r;
      if (t.retried) {
        t.stopped = true;
        this.throttled = true;
        return r;
      }
      t.retried = true;
      const after = retryAfterMs(headerOf(r.headers, 'retry-after'), Date.now());
      this.#pacer.defer(host, Math.min(after ?? DEFAULT_THROTTLE_PAUSE_MS, this.#maxRetryAfterMs));
    }
  }

  async #request(url: string, readLimit: number, t: HostThrottle): Promise<FetchResult> {
    const stopped = () => new ProbeError('throttled', 'host throttled the scan (429/503)');
    if (t.stopped) throw stopped();
    if (this.#signal.aborted) throw new ProbeError('aborted', 'scan deadline reached');
    const u = new URL(url);
    await this.#pacer.wait(u.hostname.toLowerCase(), this.#signal).catch(() => {
      throw new ProbeError('aborted', 'scan deadline reached');
    });
    if (t.stopped) throw stopped();
    const signal = AbortSignal.any([this.#signal, AbortSignal.timeout(this.#timeouts.requestMs)]);
    const requestedAt = this.#now().toISOString();
    const t0 = performance.now();
    this.requestsIssued++;
    let res: Dispatcher.ResponseData;
    try {
      res = await this.#dispatcher.request({
        origin: u.origin,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: {
          'user-agent': this.#ua,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': ACCEPT_LANGUAGE,
        },
        signal,
      });
    } catch (err) {
      throw toProbeError(err, signal);
    }

    const chunks: Buffer[] = [];
    let read = 0;
    let truncated = false;
    try {
      for await (const chunk of res.body) {
        const b = chunk as Buffer;
        if (read + b.length > readLimit) {
          chunks.push(b.subarray(0, readLimit - read));
          read = readLimit;
          truncated = true;
          break;
        }
        chunks.push(b);
        read += b.length;
      }
    } catch (err) {
      if (read === 0) throw toProbeError(err, signal);
      truncated = true;
    } finally {
      if (truncated) res.body.destroy();
    }

    const status = res.statusCode;

    const { headers, setCookieNames } = snapshotHeaders(res.headers, url);
    const first = (name: string) => {
      const v = res.headers[name];
      return (Array.isArray(v) ? v[0] : v) ?? null;
    };
    const rawLocation = first('location');
    let location: string | null = null;
    if (rawLocation) {
      try {
        location = new URL(rawLocation, url).href;
      } catch {
        location = null;
      }
    }
    const decoded = await decodeBody(Buffer.concat(chunks), first('content-encoding'), this.#maxDecoded);
    const body = decoded.body;
    const port = u.port ? Number(u.port) : defaultHttpPort(u.protocol);
    return {
      url,
      status,
      headers,
      setCookieNames,
      location,
      contentType: first('content-type'),
      body,
      bodyBytes: body.length,
      bodyTruncated: truncated || decoded.truncated,
      conn:
        this.#network.proxy && !this.#network.test
          ? null
          : (this.#conns.get(originKey(u.protocol, u.hostname, port)) ?? null),
      durationMs: Math.round(performance.now() - t0),
      requestedAt,
    };
  }

  async close(): Promise<void> {
    await this.#dispatcher.destroy().catch(() => undefined);
  }
}

function headerOf(headers: readonly HeaderRecord[], name: string): string | null {
  return headers.find((h) => h.name === name)?.value ?? null;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'TimeoutError',
]);

function toProbeError(err: unknown, signal: AbortSignal): ProbeError {
  if (err instanceof ProbeError) return err;
  const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  let code = e?.code ?? e?.cause?.code ?? e?.name ?? 'error';
  if (signal.aborted && !TIMEOUT_CODES.has(code)) code = 'TimeoutError';
  return new ProbeError(code, e?.message ?? String(err), { cause: err });
}

export type ChainOutcome =
  | 'ok'
  | 'redirect-limit'
  | 'connection-refused'
  | 'timeout'
  | 'tls-error'
  | 'dns-error'
  | 'throttled'
  | 'error';

export const DNS_ERROR_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL'];

export function outcomeOf(code: string): ChainOutcome {
  if (code === 'ECONNREFUSED') return 'connection-refused';
  if (DNS_ERROR_CODES.includes(code)) return 'dns-error';
  if (TIMEOUT_CODES.has(code) || code === 'aborted') return 'timeout';
  if (code === 'throttled') return 'throttled';
  if (/^(ERR_SSL|ERR_TLS|EPROTO|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return 'tls-error';
  return 'error';
}
