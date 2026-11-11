/** Print the already rendered, self-contained HTML using the scanner's Chromium sandbox and cleanup. */
import { type BrowserType, chromium } from 'playwright-core';
import { launchPhase } from '../collectors/browser/launch/launch.ts';
import { reporterLimits } from '../core/config/limits.ts';
import { uiText } from '../core/data/messages.ts';
import { sanitizeExternal } from '../core/redaction/sanitize.ts';
import type { ReporterContext } from '../core/report/reporter.ts';
import type { SandboxMode } from '../core/report/schema.ts';
import { defaultNetworkConfig } from '../core/url/net.ts';

export const PDF_TIMEOUT_MS = reporterLimits().pdfTimeoutMs;

/** Time the browser gets to shut down after printing. */
const CLOSE_BUDGET_MS = 3000;

/** The report is self-contained, so only inline `data:` and `about:` URLs may load. */
const INLINE_URL = /^(?:data:|about:)/;

export interface PdfOptions {
  chromium?: BrowserType;
  executablePath?: string;
  sandbox?: SandboxMode;
  timeoutMs?: number;
}

function footerText(text: string): string {
  return sanitizeExternal(text, 2000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .replace(/T([0-9])_/g, 'T$1&#95;');
}

function footerTemplate(ctx: ReporterContext): string {
  const footer = footerText(uiText(ctx.texts, 'report.pdf.footer'));
  const pageLabel = footerText(uiText(ctx.texts, 'report.pdf.page'));
  return `<div style="font:8px sans-serif;width:100%;padding:0 12mm"><span>${footer}</span> <span>${pageLabel} <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}

export async function renderPdf(html: string, ctx: ReporterContext, opts: PdfOptions = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? ctx.limits?.pdfTimeoutMs ?? PDF_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  const phase = await launchPhase(
    {
      chromium: opts.chromium ?? chromium,
      sandbox: opts.sandbox ?? 'require',
      network: defaultNetworkConfig(),
      javaScriptEnabled: false,
      offline: true,
      executablePath: opts.executablePath,
      timeoutMs,
      closeBudgetMs: CLOSE_BUDGET_MS,
    },
    '',
  );
  let printTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    await phase.context.route('**/*', (route) =>
      INLINE_URL.test(route.request().url()) ? route.continue() : route.abort(),
    );
    const page = phase.context.pages()[0] ?? (await phase.context.newPage());
    page.setDefaultTimeout(remaining());
    await page.setContent(html, { waitUntil: 'load', timeout: remaining() });

    return await Promise.race([
      page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: footerTemplate(ctx),
        margin: { top: '12mm', right: '12mm', bottom: '18mm', left: '12mm' },
      }),
      new Promise<never>((_, reject) => {
        printTimer = setTimeout(() => reject(new Error('PDF print timed out')), remaining());
      }),
    ]);
  } finally {
    if (printTimer) clearTimeout(printTimer);
    await phase.close();
  }
}
