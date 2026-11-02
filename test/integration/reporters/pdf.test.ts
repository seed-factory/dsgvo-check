import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserType, chromium } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { launchPhase } from '../../../src/collectors/browser/launch.ts';
import { loadTexts } from '../../../src/core/data.ts';
import { defaultNetworkConfig } from '../../../src/core/net.ts';
import type { ReporterContext } from '../../../src/core/reporter.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderPdf } from '../../../src/reporters/pdf.ts';
import { HOSTILE_TEXT, sampleFullReport } from '../../utils/report-fixtures.ts';
import { TEST_SANDBOX } from '../browser/helpers.ts';

const outputDirectories: string[] = [];
afterEach(() => {
  for (const directory of outputDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reportWithImage(): { html: string; ctx: ReporterContext } {
  const outDir = mkdtempSync(path.join(tmpdir(), 'report-print-'));
  outputDirectories.push(outDir);
  mkdirSync(path.join(outDir, 'artifacts'));
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(path.join(outDir, 'artifacts/banner.png'), image);
  const report = sampleFullReport();
  report.scan.target = HOSTILE_TEXT;
  const screenshot = report.evidence.find((e) => e.type === 'screenshot');
  if (screenshot?.type !== 'screenshot' || !('path' in screenshot) || !('sha256' in screenshot)) {
    throw new Error('screenshot fixture missing');
  }
  screenshot.path = 'artifacts/banner.png';
  screenshot.sha256 = createHash('sha256').update(image).digest('hex');
  const ctx: ReporterContext = { texts: loadTexts('en'), lang: 'en', outDir, color: false };
  return { html: renderHtml(report, ctx), ctx };
}

describe('self-contained reports in real Chromium', () => {
  it('opens HTML offline with JavaScript disabled, applies hashed styles and displays embedded evidence without CSP violations', async () => {
    const { html, ctx } = reportWithImage();
    const file = path.join(ctx.outDir, 'report.html');
    writeFileSync(file, html);
    const fileUrl = pathToFileURL(file).href;
    const browser = await launchPhase(
      {
        chromium,
        sandbox: TEST_SANDBOX,
        network: defaultNetworkConfig(),
        javaScriptEnabled: false,
        offline: true,
      },
      'dsgvo-check-report-test',
    );
    try {
      const requests: string[] = [];
      browser.context.on('request', (request) => requests.push(request.url()));
      await browser.context.route('**/*', (route) =>
        route.request().url() === fileUrl ? route.continue() : route.abort(),
      );
      const page = browser.context.pages()[0] ?? (await browser.context.newPage());
      const cdp = await browser.context.newCDPSession(page);
      const violations: unknown[] = [];
      cdp.on('Audits.issueAdded', ({ issue }) => {
        if (issue.code === 'ContentSecurityPolicyIssue') violations.push(issue);
      });
      await cdp.send('Audits.enable');
      await page.goto(fileUrl, { waitUntil: 'load' });
      expect(requests).toEqual([fileUrl]);
      expect(violations).toEqual([]);
      expect(await page.evaluate('getComputedStyle(document.body).fontFamily')).toContain('system-ui');
      expect(await page.evaluate("document.querySelector('img').naturalWidth")).toBe(1);
      await page.emulateMedia({ media: 'print' });
      expect(
        await page.evaluate(`(() => {
        const details = document.querySelector('details.evidence');
        const evidence = details && details.querySelector('.evs');
        return !!details && !details.open && !!evidence && evidence.getBoundingClientRect().height > 0;
      })()`),
      ).toBe(true);
      expect(html).not.toMatch(/T[0-9]_/);
      await cdp.detach();
    } finally {
      await browser.close();
    }
  });

  it('prints that exact HTML to a nonempty PDF containing at least one page with no network requests', async () => {
    const { html, ctx } = reportWithImage();
    const requests: string[] = [];
    let printedHtml = '';
    const observedChromium = {
      launchPersistentContext: async (...args: Parameters<BrowserType['launchPersistentContext']>) => {
        const context = await chromium.launchPersistentContext(...args);
        context.on('request', (request) => requests.push(request.url()));
        const page = context.pages()[0] ?? (await context.newPage());
        const setContent = page.setContent.bind(page);
        page.setContent = async (source, options) => {
          printedHtml = source;
          return setContent(source, options);
        };
        return context;
      },
    } as unknown as BrowserType;
    const pdf = await renderPdf(html, ctx, { chromium: observedChromium, sandbox: TEST_SANDBOX });
    expect(printedHtml).toBe(html);
    expect(printedHtml).not.toMatch(/T[0-9]_/);
    expect(requests).toEqual([]);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});
