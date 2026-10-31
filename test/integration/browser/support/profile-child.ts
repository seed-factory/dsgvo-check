/**
 * Child process of robustness-profiles.test.ts: launches one phase browser the way the collector does (fresh temp
 * profile with an owner marker), prints READY and then waits to be killed. Run with `node` directly (type stripping).
 */
import { chromium } from 'playwright-core';
import { launchPhase } from '../../../../src/collectors/browser/launch.ts';
import { defaultNetworkConfig } from '../../../../src/core/net.ts';

const sandbox = process.argv[2] === 'require' ? 'require' : 'off';
const browser = await launchPhase(
  { chromium, sandbox, network: defaultNetworkConfig(null) },
  'dsgvo-check-test',
);
const page = browser.context.pages()[0] ?? (await browser.context.newPage());
await page.goto('about:blank');
process.stdout.write('READY\n');
setInterval(() => undefined, 1_000);
