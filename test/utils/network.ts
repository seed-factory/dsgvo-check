/**
 * Node-side routing through `NetworkConfig.test`: an undici Agent whose connector sends every connection to
 * `test.connect(host, port)` but keeps the original hostname for SNI and certificate checks, trusting the test CA.
 */
import { Agent, buildConnector } from 'undici';
import type { NetworkConfig } from '../../src/core/url/net.ts';

export function testDispatcher(network: NetworkConfig, opts: { rejectUnauthorized?: boolean } = {}): Agent {
  const test = network.test;
  const connector = buildConnector({
    ...(test ? { ca: test.caPem } : {}),
    rejectUnauthorized: opts.rejectUnauthorized ?? true,
  });

  return new Agent({
    connect: (o, cb) => {
      const defaultPort = o.protocol === 'https:' ? 443 : 80;
      const port = o.port ? Number(o.port) : defaultPort;
      const target = test ? test.connect(o.hostname, port) : { host: o.hostname, port };
      connector({ ...o, hostname: target.host, port: String(target.port), servername: o.hostname }, cb);
    },
  });
}
