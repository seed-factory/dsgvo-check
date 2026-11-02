/**
 * Resolver abstraction for the DNS collector. `createNodeDnsClient` wraps `node:dns/promises` `Resolver`
 * (c-ares) with a per-attempt timeout and exactly one retry for SERVFAIL/TIMEOUT, and maps errors to rcodes
 * while keeping NXDOMAIN and NODATA apart. DNS never goes through `--proxy`.
 */
import { Resolver } from 'node:dns/promises';
import type { CollectorError } from '../../core/snapshot-common.ts';
import type { DnsAnswer, DnsRcode, DnsRecordType, DnsSection } from './types.ts';

export interface RawDnsResult {
  rcode: DnsRcode;
  /** Raw answers (not yet masked or filtered: the collector does that before anything is stored). */
  answers: DnsAnswer[];
  attempts: number;
  durationMs: number;
  error?: CollectorError;
}

export interface DnsClient {
  readonly resolver: DnsSection['resolver'];
  query(qname: string, type: DnsRecordType): Promise<RawDnsResult>;
  /** Cancel outstanding queries (scan timeout). */
  cancel(): void;
}

export interface NodeDnsClientOptions {
  /** `host[:port]` list; empty = system resolver configuration. */
  servers: readonly string[];
  /** Per attempt. */
  timeoutMs?: number;
  /** Extra attempts for SERVFAIL/TIMEOUT (default 1). */
  retries?: number;
}

export const DEFAULT_DNS_TIMEOUT_MS = 3000;

/** node:dns (c-ares) error code → rcode. ENOTFOUND is NXDOMAIN, ENODATA is NOERROR without answers. */
export function errorToRcode(code: string | undefined): DnsRcode {
  switch (code) {
    case 'ENOTFOUND':
      return 'NXDOMAIN';
    case 'ENODATA':
      return 'NODATA';
    case 'ESERVFAIL':
      return 'SERVFAIL';
    case 'ETIMEOUT':
      return 'TIMEOUT';
    case 'EREFUSED':
      return 'REFUSED';
    default:
      return 'ERROR';
  }
}

const RETRYABLE: ReadonlySet<DnsRcode> = new Set(['SERVFAIL', 'TIMEOUT']);

function stripDot(name: string): string {
  return name.toLowerCase().replace(/\.+$/, '');
}

async function resolveOnce(
  r: Resolver,
  qname: string,
  type: DnsRecordType,
): Promise<{ rcode: DnsRcode; answers: DnsAnswer[]; error?: CollectorError }> {
  try {
    let answers: DnsAnswer[];
    switch (type) {
      case 'TXT':
        answers = (await r.resolveTxt(qname)).map((chunks) => ({ type, value: chunks.join(''), chunks }));
        break;
      case 'MX':
        answers = (await r.resolveMx(qname)).map((mx) => ({
          type,
          // RFC 7505 Null MX: c-ares returns the root name as ''
          value: mx.exchange === '' || mx.exchange === '.' ? '.' : stripDot(mx.exchange),
          priority: mx.priority,
        }));
        break;
      case 'A':
        answers = (await r.resolve4(qname, { ttl: true })).map((a) => ({
          type,
          value: a.address,
          ttl: a.ttl,
        }));
        break;
      case 'AAAA':
        answers = (await r.resolve6(qname, { ttl: true })).map((a) => ({
          type,
          value: a.address,
          ttl: a.ttl,
        }));
        break;
      default:
        throw Object.assign(new Error(`unsupported query type ${type}`), { code: 'ENOTIMP' });
    }
    return { rcode: answers.length > 0 ? 'NOERROR' : 'NODATA', answers };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const rcode = errorToRcode(code);
    if (rcode === 'NXDOMAIN' || rcode === 'NODATA') return { rcode, answers: [] };
    return {
      rcode,
      answers: [],
      error: { code: code ?? 'dns-error', message: `${type} ${qname}: ${code ?? 'error'}` },
    };
  }
}

export function createNodeDnsClient(opts: NodeDnsClientOptions): DnsClient {
  const timeout = opts.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const retries = opts.retries ?? 1;
  const r = new Resolver({ timeout, tries: 1 });
  const custom = opts.servers.length > 0;
  if (custom) r.setServers([...opts.servers]);
  return {
    resolver: custom
      ? { kind: 'custom', servers: [...opts.servers] }
      : { kind: 'system', servers: r.getServers() },
    cancel: () => r.cancel(),
    async query(qname, type) {
      const t0 = performance.now();
      let attempts = 0;
      for (;;) {
        attempts++;
        const res = await resolveOnce(r, qname, type);
        if (!RETRYABLE.has(res.rcode) || attempts > retries) {
          return { ...res, attempts, durationMs: Math.round(performance.now() - t0) };
        }
      }
    },
  };
}
