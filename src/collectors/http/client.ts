// Polite HTTP client for passive probes: undici, no redirects, cookies or HSTS cache, honest UA (token only); ≤ 2
// requests per second per host (by request start); TLS with `rejectUnauthorized: false` (Node's verdict is recorded per
// connection); SSRF guard: connections go only to addresses from `network.lookup` that passed `isPublicAddress` (tests
// route through `network.test.connect` and trust `network.test.caPem`).
import { isIP, type Socket } from 'node:net';
import { Agent, buildConnector, type Dispatcher, ProxyAgent } from 'undici';
import { DEFAULT_CONFIG } from '../../core/config/schema.ts';
import { ACCEPT_LANGUAGE } from '../../core/runtime/user-agent.ts';
import type { HeaderRecord } from '../../core/snapshot/common.ts';
import type { NetworkConfig } from '../../core/url/net.ts';
import { defaultHttpPort } from '../../core/url/url.ts';
import { canDecode, decodeBody, MAX_DECODED_BYTES, readPrefix } from './body.ts';
import { type ConnectionFacts, connectionFacts, routeToPublic } from './connection.ts';
import { ProbeError, toProbeError } from './errors.ts';
import {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_THROTTLE_PAUSE_MS,
  HostPacer,
  MAX_RETRY_AFTER_MS,
  retryAfterMs,
  THROTTLE_SERIES,
} from './pacing.ts';
import { readResponseHead } from './response-head.ts';

/** Sockets per origin; request starts are paced by `HostPacer`, not by this number. */
const MAX_CONNECTIONS_PER_ORIGIN = 2;

type Connector = ReturnType<typeof buildConnector>;

export interface ClientTimeouts {
  connectMs: number;
  headersMs: number;
  bodyMs: number;
  requestMs: number;
}

export const DEFAULT_TIMEOUTS: ClientTimeouts = {
  connectMs: DEFAULT_CONFIG.http.connectTimeoutMs,
  headersMs: DEFAULT_CONFIG.http.headersTimeoutMs,
  bodyMs: DEFAULT_CONFIG.http.bodyTimeoutMs,
  requestMs: DEFAULT_CONFIG.http.requestTimeoutMs,
};

export interface FetchResult {
  url: string;
  status: number;
  headers: HeaderRecord[];
  setCookieNames: string[];
  /** Names of headers sent with an empty value (their stored value is `[redacted]` like any other). */
  blankHeaderNames: string[];
  /** Unsanitized: sanitize before storing. */
  location: string | null;
  contentType: string | null;
  /** Decoded body prefix (never stored). */
  body: Buffer;
  bodyBytes: number;
  bodyTruncated: boolean;
  /** A `Content-Encoding` the client could not decode (no decoder, or a corrupt stream): `body` is not the page text. */
  undecodedEncoding?: string;
  conn: ConnectionFacts | null;
  durationMs: number;
  requestedAt: string;
}

const isOverload = (status: number) => status === 429 || status === 503;

function headerOf(headers: readonly HeaderRecord[], name: string): string | null {
  return headers.find((h) => h.name === name)?.value ?? null;
}

/** Isolated per host, so one host cannot stop probes to another. */
interface HostThrottle {
  consecutive: number;
  retried: boolean;
  stopped: boolean;
}

function originKey(protocol: string, hostname: string, port: number): string {
  return `${protocol}//${hostname.toLowerCase()}:${port}`;
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
      connections: MAX_CONNECTIONS_PER_ORIGIN,
      headersTimeout: this.#timeouts.headersMs,
      bodyTimeout: this.#timeouts.bodyMs,
      connect: (opts, cb) => this.#connect(connector, opts, cb),
    });
  }

  // The SSRF guard sits here: undici gets a socket only to an address that `routeToPublic` approved.
  #connect(connector: Connector, opts: Parameters<Connector>[0], cb: Parameters<Connector>[1]): void {
    const port = opts.port ? Number(opts.port) : defaultHttpPort(opts.protocol);
    const key = originKey(opts.protocol, opts.hostname, port);
    const bare = opts.hostname.replace(/^\[|\]$/g, '');

    routeToPublic(this.#network, bare, port).then(
      (to) => {
        const servername = isIP(bare) ? undefined : bare;
        connector(
          { ...opts, hostname: to.host, port: String(to.port), ...(servername ? { servername } : {}) },
          (err, socket) => {
            if (socket) this.#conns.set(key, connectionFacts(socket, opts.protocol === 'https:'));
            if (err) cb(err, null);
            else cb(null, socket as Socket);
          },
        );
      },
      (err: Error) => cb(err, null),
    );
  }

  get network(): NetworkConfig {
    return this.#network;
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

    const res = await this.#send(u, signal);
    const { raw, truncated } = await readPrefix(res.body, readLimit, signal);

    const head = readResponseHead(res.headers, url);
    const decoded = await decodeBody(raw, head.contentEncoding, this.#maxDecoded);

    return {
      url,
      status: res.statusCode,
      headers: head.headers,
      setCookieNames: head.setCookieNames,
      blankHeaderNames: head.blankHeaderNames,
      location: head.location,
      contentType: head.contentType,
      body: decoded.body,
      bodyBytes: decoded.body.length,
      bodyTruncated: truncated || decoded.truncated,
      // A stream cut at the read limit cannot end properly: that is `bodyTruncated`, not an undecodable body.
      ...(canDecode(head.contentEncoding) && !(decoded.failed && !truncated)
        ? {}
        : { undecodedEncoding: head.contentEncoding as string }),
      conn: this.#connectionOf(u),
      durationMs: Math.round(performance.now() - t0),
      requestedAt,
    };
  }

  async #send(u: URL, signal: AbortSignal): Promise<Dispatcher.ResponseData> {
    try {
      return await this.#dispatcher.request({
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
  }

  /** Facts of the connection the response came over; unknown behind a proxy. */
  #connectionOf(u: URL): ConnectionFacts | null {
    if (this.#network.proxy && !this.#network.test) return null;
    const port = u.port ? Number(u.port) : defaultHttpPort(u.protocol);
    return this.#conns.get(originKey(u.protocol, u.hostname, port)) ?? null;
  }

  async close(): Promise<void> {
    await this.#dispatcher.destroy().catch(() => undefined);
  }
}
