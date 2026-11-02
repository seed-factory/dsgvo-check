/** Print the already rendered, self-contained HTML using the scanner's Chromium sandbox and cleanup. */
import { type BrowserType, chromium } from 'playwright-core';
import { launchPhase } from '../collectors/browser/launch.ts';
import { uiText } from '../core/messages.ts';
import { defaultNetworkConfig } from '../core/net.ts';
import type { ReporterContext } from '../core/reporter.ts';
import { sanitizeExternal } from '../core/sanitize.ts';

export const PDF_TIMEOUT_MS = 15_000;

export interface PdfOptions {
  chromium?: BrowserType;
  executablePath?: string;
  sandbox?: 'require' | 'off';
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

export async function renderPdf(html: string, ctx: ReporterContext, opts: PdfOptions = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS;
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
      closeBudgetMs: 3000,
    },
    '',
  );
  let printTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await phase.context.route('**/*', (route) =>
      /^(?:data:|about:)/.test(route.request().url()) ? route.continue() : route.abort(),
    );
    const page = phase.context.pages()[0] ?? (await phase.context.newPage());
    page.setDefaultTimeout(remaining());
    await page.setContent(html, { waitUntil: 'load', timeout: remaining() });
    const footer = footerText(uiText(ctx.texts, 'report.pdf.footer'));
    const pageLabel = footerText(uiText(ctx.texts, 'report.pdf.page'));
    return await Promise.race([
      page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `<div style="font:8px sans-serif;width:100%;padding:0 12mm"><span>${footer}</span> <span>${pageLabel} <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
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
