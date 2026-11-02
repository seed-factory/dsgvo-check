/**
 * the `trustStore` label names the CA set the process really uses. Node reads `NODE_OPTIONS` first and
 * the command line after it, the last of `--use-system-ca` / `--no-use-system-ca` wins, `NODE_USE_SYSTEM_CA=1` is
 * only the starting value, and `NODE_OPTIONS` knows double quotes (single quotes are plain characters).
 *
 * Two layers: the pure function over injected inputs, and child processes that start with the same settings and
 * compare the label with the set `tls.getCACertificates('default')` reports (the oracle does not use our parser).
 */
import { execFile } from 'node:child_process';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeTlsEndpoint } from '../../../src/collectors/tls/probe.ts';
import { detectTrustStore } from '../../../src/core/snapshot.ts';

const run = promisify(execFile);

describe('detectTrustStore over injected settings', () => {
  it.each([
    // the two scenarios
    ['command line: enabled, then disabled', {}, ['--use-system-ca', '--no-use-system-ca'], 'node-bundled'],
    ['NODE_OPTIONS with the flag in double quotes', { NODE_OPTIONS: '"--use-system-ca"' }, [], 'system'],
    // order and negation
    ['command line: disabled, then enabled', {}, ['--no-use-system-ca', '--use-system-ca'], 'system'],
    [
      'NODE_OPTIONS: enabled, then disabled',
      { NODE_OPTIONS: '--use-system-ca --no-use-system-ca' },
      [],
      'node-bundled',
    ],
    [
      'NODE_OPTIONS: disabled, then enabled',
      { NODE_OPTIONS: '--no-use-system-ca --use-system-ca' },
      [],
      'system',
    ],
    [
      'the command line wins over NODE_OPTIONS (enabled → disabled)',
      { NODE_OPTIONS: '--use-system-ca' },
      ['--no-use-system-ca'],
      'node-bundled',
    ],
    [
      'the command line wins over NODE_OPTIONS (disabled → enabled)',
      { NODE_OPTIONS: '--no-use-system-ca' },
      ['--use-system-ca'],
      'system',
    ],
    // NODE_USE_SYSTEM_CA is only the starting value
    [
      'NODE_USE_SYSTEM_CA=1, switched off on the command line',
      { NODE_USE_SYSTEM_CA: '1' },
      ['--no-use-system-ca'],
      'node-bundled',
    ],
    [
      'NODE_USE_SYSTEM_CA=1, switched off in NODE_OPTIONS',
      { NODE_USE_SYSTEM_CA: '1', NODE_OPTIONS: '--no-use-system-ca' },
      [],
      'node-bundled',
    ],
    [
      'NODE_USE_SYSTEM_CA=0, switched on on the command line',
      { NODE_USE_SYSTEM_CA: '0' },
      ['--use-system-ca'],
      'system',
    ],
    ['NODE_USE_SYSTEM_CA=1 alone', { NODE_USE_SYSTEM_CA: '1' }, [], 'system'],
    // spelling Node accepts
    ['underscores in the option name', { NODE_OPTIONS: '--use_system_ca' }, [], 'system'],
    ['a value after =, which Node reads as "on"', {}, ['--use-system-ca=1'], 'system'],
    ['quotes inside a word', { NODE_OPTIONS: '--use-"system"-ca' }, [], 'system'],
    [
      'between other options',
      { NODE_OPTIONS: '--max-old-space-size=2048 "--use-system-ca" --trace-warnings' },
      [],
      'system',
    ],
    // what Node does not read as the flag
    [
      'single quotes are plain characters in NODE_OPTIONS',
      { NODE_OPTIONS: "'--use-system-ca'" },
      [],
      'node-bundled',
    ],
    [
      'a longer option name',
      { NODE_OPTIONS: '--use-system-cache' },
      ['--use-system-ca-extra'],
      'node-bundled',
    ],
    ['NODE_USE_SYSTEM_CA is read only as 1', { NODE_USE_SYSTEM_CA: 'true' }, [], 'node-bundled'],
    [
      'a value that merely contains the flag',
      { NODE_OPTIONS: '--require=./--use-system-ca.js' },
      [],
      'node-bundled',
    ],
    // OpenSSL's store is the operating system's one on a distribution build: the nearest of the two labels
    ['--use-openssl-ca', { NODE_OPTIONS: '--use-openssl-ca' }, [], 'system'],
    ['--use-openssl-ca switched off again', {}, ['--use-openssl-ca', '--no-use-openssl-ca'], 'node-bundled'],
    ['--use-bundled-ca alone is the default', {}, ['--use-bundled-ca'], 'node-bundled'],
    [
      '--use-bundled-ca next to --use-system-ca adds the system roots',
      {},
      ['--use-system-ca', '--use-bundled-ca'],
      'system',
    ],
  ] as const)('%s', (_label, env, execArgv, expected) => {
    expect(detectTrustStore(env, execArgv)).toBe(expected);
  });

  it('counterexamples that already held: nothing set, the plain flag, the plain variable', () => {
    expect(detectTrustStore({}, [])).toBe('node-bundled');
    expect(detectTrustStore({}, ['--use-system-ca'])).toBe('system');
    expect(detectTrustStore({ NODE_OPTIONS: '--use-system-ca' }, [])).toBe('system');
    expect(detectTrustStore({ NODE_USE_SYSTEM_CA: '1' }, [])).toBe('system');
  });
});

const bundled = new Set(tls.getCACertificates('bundled'));
/** Some operating-system root is not in Node's bundled list: only then can a label be told from the real set. */
const systemStoreDiffers = tls.getCACertificates('system').some((c) => !bundled.has(c));

const SNAPSHOT_URL = new URL('../../../src/core/snapshot.ts', import.meta.url).href;
const CHILD = `
import tls from 'node:tls';
import { detectTrustStore } from ${JSON.stringify(SNAPSHOT_URL)};
const bundled = new Set(tls.getCACertificates('bundled'));
const beyondBundled = tls.getCACertificates('default').some((c) => !bundled.has(c));
console.log(JSON.stringify({ reported: detectTrustStore(), actual: beyondBundled ? 'system' : 'node-bundled' }));
`;

async function inChild(flags: string[], nodeOptions: string | null, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !['NODE_OPTIONS', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS'].includes(k))
      env[k] = v;
  }
  if (nodeOptions !== null) env.NODE_OPTIONS = nodeOptions;
  Object.assign(env, extraEnv);
  const { stdout } = await run(process.execPath, [...flags, '--input-type=module', '-e', CHILD], { env });
  return JSON.parse(stdout.trim()) as { reported: string; actual: string };
}

describe.skipIf(!systemStoreDiffers)('the label equals the CA set of a real Node process', () => {
  it.each([
    ['baseline', [], null, {}, 'node-bundled'],
    ['--use-system-ca', ['--use-system-ca'], null, {}, 'system'],
    [
      '--use-system-ca --no-use-system-ca',
      ['--use-system-ca', '--no-use-system-ca'],
      null,
      {},
      'node-bundled',
    ],
    ['--no-use-system-ca --use-system-ca', ['--no-use-system-ca', '--use-system-ca'], null, {}, 'system'],
    ['NODE_OPTIONS="--use-system-ca" in double quotes', [], '"--use-system-ca"', {}, 'system'],
    ["NODE_OPTIONS='--use-system-ca' in single quotes", [], "'--use-system-ca'", {}, 'node-bundled'],
    ['NODE_OPTIONS yes, command line no', ['--no-use-system-ca'], '--use-system-ca', {}, 'node-bundled'],
    ['NODE_OPTIONS no, command line yes', ['--use-system-ca'], '--no-use-system-ca', {}, 'system'],
    ['NODE_OPTIONS yes then no', [], '--use-system-ca --no-use-system-ca', {}, 'node-bundled'],
    ['NODE_OPTIONS no then yes', [], '--no-use-system-ca --use-system-ca', {}, 'system'],
    ['NODE_USE_SYSTEM_CA=1', [], null, { NODE_USE_SYSTEM_CA: '1' }, 'system'],
    [
      'NODE_USE_SYSTEM_CA=1 and --no-use-system-ca',
      ['--no-use-system-ca'],
      null,
      { NODE_USE_SYSTEM_CA: '1' },
      'node-bundled',
    ],
    [
      'NODE_USE_SYSTEM_CA=1 and NODE_OPTIONS=--no-use-system-ca',
      [],
      '--no-use-system-ca',
      { NODE_USE_SYSTEM_CA: '1' },
      'node-bundled',
    ],
    [
      'NODE_USE_SYSTEM_CA=0 and --use-system-ca',
      ['--use-system-ca'],
      null,
      { NODE_USE_SYSTEM_CA: '0' },
      'system',
    ],
    ['NODE_USE_SYSTEM_CA=true', [], null, { NODE_USE_SYSTEM_CA: 'true' }, 'node-bundled'],
    ['--use_system_ca', ['--use_system_ca'], null, {}, 'system'],
    ['--use-system-ca=false', ['--use-system-ca=false'], null, {}, 'system'],
    ['--use-system-ca --use-bundled-ca', ['--use-system-ca', '--use-bundled-ca'], null, {}, 'system'],
  ] as const)(
    '%s',
    async (_label, flags, nodeOptions, extraEnv, expected) => {
      const { reported, actual } = await inChild([...flags], nodeOptions, { ...extraEnv });
      expect(actual).toBe(expected); // what the process really trusts
      expect(reported).toBe(actual); // what the scanner would write down
    },
    30_000,
  );
});

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
