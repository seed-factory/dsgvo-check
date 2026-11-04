/**
 * Reports in real Chromium: the HTML opens offline without JavaScript and without CSP violations, and prints to a PDF
 * without a single network request.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserType, type CDPSession, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchPhase, type PhaseBrowser } from '../../../src/collectors/browser/launch/launch.ts';
import { loadTexts } from '../../../src/core/data/load.ts';
import type { ReporterContext } from '../../../src/core/report/reporter.ts';
import { defaultNetworkConfig } from '../../../src/core/url/net.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderPdf } from '../../../src/reporters/pdf.ts';
import { HOSTILE_TEXT, sampleFullReport } from '../../utils/report/fixtures.ts';
import { TEST_SANDBOX } from '../browser/helpers.ts';

const outputDirectories: string[] = [];
afterAll(() => {
  for (const directory of outputDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A 1x1 PNG. */
const BANNER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** The full sample report with a hostile target text and its screenshot evidence pointing at a real file. */
function reportWithImage(): { html: string; ctx: ReporterContext } {
  const outDir = mkdtempSync(path.join(tmpdir(), 'report-print-'));
  outputDirectories.push(outDir);
  mkdirSync(path.join(outDir, 'artifacts'));
  writeFileSync(path.join(outDir, 'artifacts/banner.png'), BANNER_PNG);

  const report = sampleFullReport();
  report.scan.target = HOSTILE_TEXT;
  const screenshot = report.evidence.find((e) => e.type === 'screenshot');
  if (screenshot?.type !== 'screenshot' || !('path' in screenshot) || !('sha256' in screenshot)) {
    throw new Error('screenshot fixture missing');
  }
  screenshot.path = 'artifacts/banner.png';
  screenshot.sha256 = createHash('sha256').update(BANNER_PNG).digest('hex');

  const ctx: ReporterContext = { texts: loadTexts('en'), lang: 'en', outDir, color: false };
  return { html: renderHtml(report, ctx), ctx };
}

/**
 * Evaluated in the page: every collapsible block stays closed on screen, but when printing its content is laid out
 * and its heading carries no disclosure triangle, because a PDF cannot be expanded.
 */
const CLOSED_BLOCKS_IN_PRINT = `(() => [...document.querySelectorAll('details')].map((details) => {
  const summary = details.querySelector(':scope > summary');
  const content = [...details.children].filter((child) => child !== summary);
  return {
    block: details.className,
    open: details.open,
    laidOut: content.length > 0 && content.every((child) => child.getBoundingClientRect().height > 0),
    marker: summary ? getComputedStyle(summary).display === 'list-item' : null,
  };
}))()`;

describe('HTML report opened offline with JavaScript disabled in real Chromium', () => {
  let browser: PhaseBrowser | undefined;
  let cdp: CDPSession | undefined;
  let page: Page;
  let html: string;
  let fileUrl: string;
  const requests: string[] = [];
  const cspViolations: unknown[] = [];

  beforeAll(async () => {
    const report = reportWithImage();
    html = report.html;
    const file = path.join(report.ctx.outDir, 'report.html');
    writeFileSync(file, html);
    fileUrl = pathToFileURL(file).href;

    browser = await launchPhase(
      {
        chromium,
        sandbox: TEST_SANDBOX,
        network: defaultNetworkConfig(),
        javaScriptEnabled: false,
        offline: true,
      },
      'dsgvo-check-report-test',
    );
    browser.context.on('request', (request) => requests.push(request.url()));
    await browser.context.route('**/*', (route) =>
      route.request().url() === fileUrl ? route.continue() : route.abort(),
    );
    page = browser.context.pages()[0] ?? (await browser.context.newPage());
    cdp = await browser.context.newCDPSession(page);
    cdp.on('Audits.issueAdded', ({ issue }) => {
      if (issue.code === 'ContentSecurityPolicyIssue') cspViolations.push(issue);
    });
    await cdp.send('Audits.enable');

    await page.goto(fileUrl, { waitUntil: 'load' });
  });

  afterAll(async () => {
    try {
      await cdp?.detach();
    } finally {
      await browser?.close();
    }
  });

  it('requests nothing but the report file', () => {
    expect(requests).toEqual([fileUrl]);
  });

  it('opens without CSP violations', () => {
    expect(cspViolations).toEqual([]);
  });

  it('applies the hashed styles', async () => {
    expect(await page.evaluate('getComputedStyle(document.body).fontFamily')).toContain('system-ui');
  });

  it('displays the embedded evidence image', async () => {
    expect(await page.evaluate("document.querySelector('img').naturalWidth")).toBe(1);
  });

  it('prints every closed block expanded and without a disclosure triangle', async () => {
    await page.emulateMedia({ media: 'print' });
    const blocks = (await page.evaluate(CLOSED_BLOCKS_IN_PRINT)) as { block: string }[];

    expect(blocks.map((b) => b.block).sort()).toEqual(expect.arrayContaining(['evidence', 'legal']));
    for (const block of blocks) {
      expect(block, block.block).toEqual({ block: block.block, open: false, laidOut: true, marker: false });
    }
  });

  it('shows no CRM code', () => {
    expect(html).not.toMatch(/T[0-9]_/);
  });
});

describe('PDF of the report in real Chromium', () => {
  it('prints the report to a nonempty PDF containing at least one page with no network requests', async () => {
    const { html, ctx } = reportWithImage();
    const requests: string[] = [];
    const observedChromium = {
      launchPersistentContext: async (...args: Parameters<BrowserType['launchPersistentContext']>) => {
        const context = await chromium.launchPersistentContext(...args);
        context.on('request', (request) => requests.push(request.url()));
        return context;
      },
    } as unknown as BrowserType;

    const pdf = await renderPdf(html, ctx, { chromium: observedChromium, sandbox: TEST_SANDBOX });

    expect(requests).toEqual([]);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});
