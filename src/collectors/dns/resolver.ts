// Resolver abstraction for the DNS collector: `createNodeDnsClient` wraps `node:dns/promises` (c-ares) with a
// per-attempt timeout and one retry for SERVFAIL/TIMEOUT, and keeps NXDOMAIN and NODATA apart. DNS never goes through
// `--proxy`.
import { Resolver } from 'node:dns/promises';
import { DEFAULT_CONFIG } from '../../core/config/schema.ts';
import type { CollectorError } from '../../core/snapshot/common.ts';
import type { DnsAnswer, DnsRcode, DnsRecordType, DnsSection } from '../../core/snapshot/dns.ts';

export interface RawDnsResult {
  rcode: DnsRcode;
  /** Raw answers: the collector masks and filters them before anything is stored. */
  answers: DnsAnswer[];
  attempts: number;
  durationMs: number;
  error?: CollectorError;
}

export interface DnsClient {
  readonly resolver: DnsSection['resolver'];
  query(qname: string, type: DnsRecordType): Promise<RawDnsResult>;
  cancel(): void;
}

export interface NodeDnsClientOptions {
  servers: readonly string[];
  timeoutMs?: number;
  retries?: number;
}

export const DEFAULT_DNS_TIMEOUT_MS = DEFAULT_CONFIG.dns.timeoutMs;

/** ENOTFOUND is NXDOMAIN, ENODATA is NOERROR without answers. */
const RCODE_BY_ERROR_CODE: ReadonlyMap<string, DnsRcode> = new Map([
  ['ENOTFOUND', 'NXDOMAIN'],
  ['ENODATA', 'NODATA'],
  ['ESERVFAIL', 'SERVFAIL'],
  ['ETIMEOUT', 'TIMEOUT'],
  ['EREFUSED', 'REFUSED'],
]);

/** node:dns (c-ares) error code → rcode; any other code is a plain `ERROR`. */
export function errorToRcode(code: string | undefined): DnsRcode {
  return (code !== undefined && RCODE_BY_ERROR_CODE.get(code)) || 'ERROR';
}

/** Transient failures that get another attempt; NXDOMAIN, NODATA and REFUSED are final answers. */
const RETRYABLE: ReadonlySet<DnsRcode> = new Set(['SERVFAIL', 'TIMEOUT']);

function stripDot(name: string): string {
  return name.toLowerCase().replace(/\.+$/, '');
}

/** Answers for the record types the collector asks for; any other `DnsRecordType` fails with ENOTIMP. */
async function resolveAnswers(r: Resolver, qname: string, type: DnsRecordType): Promise<DnsAnswer[]> {
  switch (type) {
    case 'TXT':
      return (await r.resolveTxt(qname)).map((chunks) => ({ type, value: chunks.join(''), chunks }));

    case 'MX':
      return (await r.resolveMx(qname)).map((mx) => ({
        type,
        // RFC 7505 Null MX: c-ares returns the root name as ''
        value: mx.exchange === '' || mx.exchange === '.' ? '.' : stripDot(mx.exchange),
        priority: mx.priority,
      }));

    case 'A':
      return (await r.resolve4(qname, { ttl: true })).map((a) => ({ type, value: a.address, ttl: a.ttl }));

    case 'AAAA':
      return (await r.resolve6(qname, { ttl: true })).map((a) => ({ type, value: a.address, ttl: a.ttl }));

    default:
      throw Object.assign(new Error(`unsupported query type ${type}`), { code: 'ENOTIMP' });
  }
}

async function resolveOnce(
  r: Resolver,
  qname: string,
  type: DnsRecordType,
): Promise<{ rcode: DnsRcode; answers: DnsAnswer[]; error?: CollectorError }> {
  try {
    const answers = await resolveAnswers(r, qname, type);
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
  const retries = opts.retries ?? DEFAULT_CONFIG.dns.retries;
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
