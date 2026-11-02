/**
 * Network boundary helpers: address classification for the SSRF guard (BRIEF "Упрощения": IP check on navigation,
 * block private/loopback/link-local/metadata for top-level documents and frames) and the network config that
 * collectors share. Test-only overrides live in `NetworkConfig.test`.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type AddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'metadata'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

function inV4(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (ip & mask) === (v4ToInt(base) & mask);
}

function classifyV4(ip: string): AddressClass {
  const n = v4ToInt(ip);
  if (ip === '169.254.169.254' || ip === '100.100.100.200') return 'metadata';
  if (inV4(n, '0.0.0.0/8')) return 'unspecified';
  if (inV4(n, '127.0.0.0/8')) return 'loopback';
  if (inV4(n, '169.254.0.0/16')) return 'link-local';
  if (
    inV4(n, '10.0.0.0/8') ||
    inV4(n, '172.16.0.0/12') ||
    inV4(n, '192.168.0.0/16') ||
    inV4(n, '100.64.0.0/10')
  )
    return 'private';
  if (inV4(n, '224.0.0.0/4')) return 'multicast';
  if (
    inV4(n, '240.0.0.0/4') ||
    inV4(n, '192.0.0.0/24') ||
    inV4(n, '192.0.2.0/24') ||
    inV4(n, '198.18.0.0/15') ||
    inV4(n, '198.51.100.0/24') ||
    inV4(n, '203.0.113.0/24')
  )
    return 'reserved';
  return 'public';
}

function expandV6(ip: string): number[] {
  const [head = '', tail = ''] = ip.split('::');
  const parse = (s: string) => (s ? s.split(':') : []);
  let h = parse(head);
  let t = parse(tail);
  const last = (ip.includes('::') ? t : h).at(-1);
  // embedded IPv4 (e.g. ::ffff:1.2.3.4)
  if (last?.includes('.')) {
    const n = v4ToInt(last);
    const words = [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
    if (ip.includes('::')) t = [...t.slice(0, -1), ...words];
    else h = [...h.slice(0, -1), ...words];
  }
  const fill = ip.includes('::') ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill('0'), ...t].map((w) => Number.parseInt(w, 16) || 0);
}

/** IPv4 address from two 16-bit words. */
function v4Of(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function classifyV6(ip: string): AddressClass {
  const w = expandV6(ip.toLowerCase().split('%')[0] as string);
  const word = (i: number) => w[i] ?? 0;
  if (w.every((x) => x === 0)) return 'unspecified';
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) {
    return classifyV4(v4Of(word(6), word(7)));
  }
  // Transition prefixes that carry an IPv4 destination are classified by that IPv4 address:
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052), 6to4 2002::/16 (RFC 3056), Teredo 2001::/32 (RFC 4380,
  // client address obfuscated by inversion).
  if (word(0) === 0x64 && word(1) === 0xff9b && w.slice(2, 6).every((x) => x === 0)) {
    return classifyV4(v4Of(word(6), word(7)));
  }
  if (word(0) === 0x64 && word(1) === 0xff9b && word(2) === 1) return 'reserved'; // local-use NAT64 (RFC 8215)
  if (word(0) === 0x2002) return classifyV4(v4Of(word(1), word(2)));
  if (word(0) === 0x2001 && word(1) === 0) return classifyV4(v4Of(~word(6) & 0xffff, ~word(7) & 0xffff));
  const first = word(0);
  if (ip.toLowerCase() === 'fd00:ec2::254') return 'metadata';
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local fec0::/10, still routed internally
  if ((first & 0xfe00) === 0xfc00) return 'private';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  if (first === 0x2001 && w[1] === 0x0db8) return 'reserved';
  return 'public';
}

export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip.split('%')[0] ?? '');
  if (family === 4) return classifyV4(ip);
  if (family === 6) return classifyV6(ip);
  return 'reserved';
}

export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === 'public';
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemLookup: Lookup = async (hostname) => {
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Network configuration shared by all collectors. Production uses only `proxy` and `allowPrivateAddresses: false`.
 * `test` is set exclusively by test utilities (L2): it maps every host to the local fixture server.
 */
export interface NetworkConfig {
  /** `--proxy` (HTTP) for all collectors; null = direct. */
  proxy: string | null;
  /** SSRF guard switch; true only in tests. */
  allowPrivateAddresses: boolean;
  /** Hostname resolution used by core preflight and Node clients (default: system resolver). */
  lookup: Lookup;
  /** DNS servers for the DNS collector (`host:port`); empty = system resolver. */
  dnsServers: string[];
  test?: TestNetwork;
}

export interface TestNetwork {
  /** Route a connection for (host, port) to the fixture server; Host header and SNI keep the original host. */
  connect: (host: string, port: number) => { host: string; port: number };
  /** Extra Chromium args, e.g. `--host-resolver-rules=…` and `--ignore-certificate-errors-spki-list=…`. */
  browserArgs: string[];
  /** Trusted test CA certificates (PEM) for node:tls / undici. */
  caPem: string[];
}

export function defaultNetworkConfig(proxy: string | null = null): NetworkConfig {
  return { proxy, allowPrivateAddresses: false, lookup: systemLookup, dnsServers: [] };
}
