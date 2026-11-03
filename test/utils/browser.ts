/**
 * Test Chromium: Chrome for Testing in new headless (`channel: 'chromium'`, as in production), fresh persistent profile,
 * every host routed to the fixture server via `--host-resolver-rules` (see test/README.md).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type Request } from 'playwright-core';
import type { FixtureServer } from '../fixture-server/server.ts';

export interface TestBrowser {
  context: BrowserContext;
  /** All requests seen by the context (subscribed before the first navigation). */
  requests: Request[];
  close(): Promise<void>;
}

export async function launchTestBrowser(
  server: FixtureServer,
  opts: { args?: string[]; viewport?: { width: number; height: number } } = {},
): Promise<TestBrowser> {
  const profile = mkdtempSync(path.join(tmpdir(), 'dsgvo-check-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: opts.viewport ?? { width: 1366, height: 768 },
    args: [...server.browserArgs(), ...(opts.args ?? [])],
  });
  const requests: Request[] = [];
  context.on('request', (r) => requests.push(r));
  return {
    context,
    requests,
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
