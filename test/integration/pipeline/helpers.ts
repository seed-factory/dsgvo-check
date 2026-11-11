import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, expect } from 'vitest';
import { createBrowserCollector } from '../../../src/collectors/browser/index.ts';
import { silentLogger } from '../../../src/core/runtime/logger.ts';
import { writeReports } from '../../../src/reporters/write.ts';
import { type ScanResult, scan } from '../../../src/scan.ts';
import type { ScanOptions } from '../../../src/scan-options.ts';
import type { FixtureServer } from '../../fixture-server/server.ts';
import { FAST_TIMING, TEST_SANDBOX } from '../browser/helpers.ts';

export function useScan<T>(run: () => Promise<T>): () => T {
  let result: T;
  beforeAll(async () => {
    result = await run();
  });
  return () => result;
}

export function scanFixture(
  server: FixtureServer,
  options: Pick<ScanOptions, 'url' | 'outDir' | 'checks' | 'config'>,
) {
  return scan({
    ...options,
    network: server.network(),
    log: silentLogger,
    sandbox: TEST_SANDBOX,
    collectors: { browser: createBrowserCollector({ timing: FAST_TIMING }) },
  });
}

export async function writeFixtureReports(result: ScanResult, outDir: string) {
  const written = await writeReports(result, {
    outDir,
    formats: ['console', 'json', 'html', 'summary'],
    lang: 'de',
  });
  expect(written.errors).toEqual([]);
  const read = (name: string) => readFileSync(path.join(outDir, name), 'utf8');
  return {
    json: read('report.json'),
    html: read('report.html'),
    summary: read('summary.md'),
    console: written.console,
  };
}
