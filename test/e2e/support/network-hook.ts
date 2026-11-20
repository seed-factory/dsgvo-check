/**
 * Preload for the built CLI (`node --import test/e2e/support/network-hook.ts dist/cli.js <url>`): the CLI has no switch
 * for a test network, so this rewrites `dist/core/url/net.js` to route declared hosts (env `DSGVO_E2E_NETWORK`) locally.
 */
import { registerHooks } from 'node:module';

export interface E2eNetworkConfig {
  httpPort: number;
  httpsPort: number;
  /** Hosts that resolve (to 127.0.0.1); every other host gives ENOTFOUND. */
  hosts: string[];
  browserArgs: string[];
  caPem: string[];
  dnsServers: string[];
}

const raw = process.env.DSGVO_E2E_NETWORK;
if (!raw) throw new Error('network-hook: DSGVO_E2E_NETWORK is not set');
const cfg = JSON.parse(raw) as E2eNetworkConfig;
const known = new Set(cfg.hosts.map((h) => h.toLowerCase()));

/** Ports 80 and 443 go to the fixture server's listeners; any other port is used as it is. */
const fixturePort = (port: number) => (port === 443 ? cfg.httpsPort : port === 80 ? cfg.httpPort : port);

(globalThis as Record<string, unknown>).__dsgvoE2eNetwork = (base: Record<string, unknown>) => ({
  ...base,
  allowPrivateAddresses: true,
  dnsServers: cfg.dnsServers,
  lookup: async (host: string) => {
    if (!known.has(host.toLowerCase())) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    return [{ address: '127.0.0.1', family: 4 }];
  },
  test: {
    connect: (_host: string, port: number) => ({ host: '127.0.0.1', port: fixturePort(port) }),
    browserArgs: cfg.browserArgs,
    caPem: cfg.caPem,
  },
});

const MARK = 'export function defaultNetworkConfig(';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/dist/core/url/net.js')) return result;

    const src = result.source;
    const source = typeof src === 'string' ? src : Buffer.from(src as Uint8Array).toString('utf8');
    if (!source.includes(MARK)) {
      throw new Error(
        'network-hook: `export function defaultNetworkConfig(` not found in dist/core/url/net.js',
      );
    }

    // The original function stays under another name; the new one wraps its result with the test network.
    return {
      ...result,
      source: `${source.replace(MARK, 'function __originalDefaultNetworkConfig(')}
export function defaultNetworkConfig(proxy = null) {
  return globalThis.__dsgvoE2eNetwork(__originalDefaultNetworkConfig(proxy));
}
`,
    };
  },
});
