// Small GET for robots.txt and sitemaps that honours `NetworkConfig` (test routing and CA, `--proxy`, SSRF boundary).
// The body size is capped.
import { Agent, buildConnector, type Dispatcher, ProxyAgent, request } from 'undici';
import type { NetworkConfig } from '../../../core/url/net.ts';
import { defaultHttpPort } from '../../../core/url/url.ts';
import { hostClassifier } from './ssrf.ts';

export interface FetchedText {
  status: number;
  text: string;
  contentType: string;
}

function dispatcherFor(network: NetworkConfig): Dispatcher | null {
  if (network.proxy) {
    return /^https?:/i.test(network.proxy) ? new ProxyAgent(network.proxy) : null;
  }
  const test = network.test;
  if (test) {
    const connector = buildConnector({ ca: test.caPem });
    return new Agent({
      connect: (o, cb) => {
        const port = o.port ? Number(o.port) : defaultHttpPort(o.protocol);
        const t = test.connect(o.hostname, port);
        connector({ ...o, hostname: t.host, port: String(t.port), servername: o.hostname }, cb);
      },
    });
  }
  return new Agent();
}

const ACCEPT_HEADER = 'text/plain, application/xml, text/xml, */*;q=0.1';

export async function fetchText(
  url: string,
  network: NetworkConfig,
  userAgent: string,
  opts: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
): Promise<FetchedText | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!network.allowPrivateAddresses) {
    const verdict = await hostClassifier(network)(u.hostname);
    if (verdict !== 'public') return null;
  }
  const dispatcher = dispatcherFor(network);
  if (!dispatcher) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  const onAbort = () => ac.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await request(url, {
      method: 'GET',
      dispatcher,
      headers: { 'user-agent': userAgent, accept: ACCEPT_HEADER },
      signal: ac.signal,
    });
    const body = await readCapped(res.body, opts.maxBytes);

    const ct = res.headers['content-type'];
    return {
      status: res.statusCode,
      text: body.toString('utf8'),
      contentType: Array.isArray(ct) ? (ct[0] ?? '') : (ct ?? ''),
    };
  } catch {
    // Optional page sources: a failed fetch means "not available" and discovery falls back to the start page links.
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
    await dispatcher.close().catch(() => undefined);
  }
}

/** Reads at most `maxBytes` and closes the stream: the rest of a large body is never downloaded. */
async function readCapped(body: Dispatcher.ResponseData['body'], maxBytes: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > maxBytes) {
      chunks.push(b.subarray(0, Math.max(0, maxBytes - (size - b.length))));
      break;
    }
    chunks.push(b);
  }
  body.destroy();
  return Buffer.concat(chunks);
}
