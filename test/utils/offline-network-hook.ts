/**
 * Test-only preload for running the CLI from source in (loopback only, no DNS):
 * `node --import test/utils/offline-network-hook.ts src/cli.ts <url> …`.
 *
 * It rewrites `src/core/net.ts` at load time so that `defaultNetworkConfig` resolves every host with ENOTFOUND
 * instead of the system resolver. Each lookup is appended to the file named by `DSGVO_TEST_LOOKUP_LOG` (if set),
 * so tests can assert that names went only through this resolver. The CLI itself has no switch for this.
 */
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Absolute path of this hook for `--import`. */
export const OFFLINE_HOOK = fileURLToPath(import.meta.url);

/** Environment for a subprocess that uses the hook. */
export function offlineHookEnv(lookupLog?: string): Record<string, string> {
  return { DSGVO_TEST_OFFLINE_NETWORK: '1', ...(lookupLog ? { DSGVO_TEST_LOOKUP_LOG: lookupLog } : {}) };
}

const MARK = 'export function defaultNetworkConfig(';

if (process.env.DSGVO_TEST_OFFLINE_NETWORK === '1') {
  const logFile = process.env.DSGVO_TEST_LOOKUP_LOG;
  (globalThis as Record<string, unknown>).__dsgvoOfflineNetwork = (base: Record<string, unknown>) => ({
    ...base,
    lookup: async (host: string) => {
      if (logFile) appendFileSync(logFile, `${host}\n`);
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    },
  });

  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.endsWith('/src/core/net.ts')) return result;
      const src = result.source;
      const source = typeof src === 'string' ? src : Buffer.from(src as Uint8Array).toString('utf8');
      if (!source.includes(MARK)) {
        throw new Error(
          'offline-network-hook: `export function defaultNetworkConfig(` not found in src/core/net.ts',
        );
      }
      return {
        ...result,
        source: `${source.replace(MARK, 'function __originalDefaultNetworkConfig(')}
export function defaultNetworkConfig(proxy = null) {
  return globalThis.__dsgvoOfflineNetwork(__originalDefaultNetworkConfig(proxy));
}
`,
      };
    },
  });
}
