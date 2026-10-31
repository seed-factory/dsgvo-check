import { afterEach, expect, it, vi } from 'vitest';
import { probeTlsEndpoint } from '../../../../src/collectors/tls/probe.ts';

afterEach(() => vi.unstubAllEnvs());

it('reports system trust store when enabled in the environment', async () => {
  vi.stubEnv('NODE_USE_SYSTEM_CA', '1');
  const endpoint = await probeTlsEndpoint(
    {
      network: { proxy: null, lookup: async () => [], allowPrivateAddresses: false, dnsServers: [] },
      signal: new AbortController().signal,
      now: () => new Date('2026-01-01T00:00:00Z'),
    },
    { host: 'example.test', hostVariant: 'target' },
    443,
    100,
  );
  expect(endpoint.trustStore).toBe('system');
});
