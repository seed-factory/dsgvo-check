import { existsSync } from 'node:fs';
import type { BrowserContext, BrowserType, Route } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { loadTexts } from '../../../src/core/data.ts';
import { uiText } from '../../../src/core/messages.ts';
import type { ReporterContext } from '../../../src/core/reporter.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderPdf } from '../../../src/reporters/pdf.ts';
import { sampleFullReport } from '../../utils/report-fixtures.ts';

const ctx = (): ReporterContext => ({
  texts: loadTexts('en'),
  lang: 'en',
  outDir: '/nonexistent-report-output',
  color: false,
});

function browserDouble(failure?: Error) {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const bytes = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
  const page = {
    setDefaultTimeout: vi.fn(),
    setContent: vi.fn(async (_html: string, _options: { waitUntil: string; timeout: number }) => undefined),
    pdf: vi.fn(async (_options: Record<string, unknown>) => {
      if (failure) throw failure;
      return bytes;
    }),
  };
  const context = {
    route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => {
      routeHandler = handler;
    }),
    pages: () => [page],
    close: vi.fn(async () => undefined),
  };
  const launch = vi.fn(
    async (_directory: string, _options: Record<string, unknown>) => context as unknown as BrowserContext,
  );
  const chromium = { launchPersistentContext: launch } as unknown as BrowserType;
  return { bytes, page, context, chromium, launch, route: () => routeHandler };
}

describe('PDF conversion of the finished HTML report', () => {
  it('prints exactly the rendered HTML in A4 with backgrounds and localized footer, then closes Chromium', async () => {
    const fake = browserDouble();
    const context = ctx();
    const html = renderHtml(sampleFullReport(), context);
    expect(html).not.toMatch(/T[0-9]_/);

    const pdf = await renderPdf(html, context, { chromium: fake.chromium, timeoutMs: 1_234 });

    expect(pdf).toEqual(fake.bytes);
    expect(fake.page.setContent).toHaveBeenCalledWith(html, {
      waitUntil: 'load',
      timeout: expect.any(Number),
    });
    expect(fake.page.setContent.mock.calls[0]?.[1].timeout).toBeGreaterThan(0);
    expect(fake.page.setContent.mock.calls[0]?.[1].timeout).toBeLessThanOrEqual(1_234);
    expect(fake.page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        footerTemplate: expect.stringContaining(uiText(context.texts, 'report.pdf.footer')),
      }),
    );
    const options = fake.page.pdf.mock.calls[0]?.[0] as unknown as { footerTemplate: string };
    expect(options.footerTemplate).toContain('pageNumber');
    expect(options.footerTemplate).toContain('totalPages');
    expect(fake.context.close).toHaveBeenCalledOnce();
  });

  it('starts with JavaScript disabled, offline and the scanner sandbox settings', async () => {
    const fake = browserDouble();
    await renderPdf('<!doctype html><p>report</p>', ctx(), {
      chromium: fake.chromium,
      sandbox: 'off',
    });
    expect(fake.launch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        channel: 'chromium',
        headless: true,
        javaScriptEnabled: false,
        offline: true,
        chromiumSandbox: false,
        acceptDownloads: false,
      }),
    );
    expect(fake.context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    for (const [url, allowed] of [
      ['data:image/png;base64,AA==', true],
      ['about:blank', true],
      ['https://example.invalid/resource', false],
      ['http://example.invalid/resource', false],
      ['file:///tmp/private.txt', false],
    ] as const) {
      const abort = vi.fn(async () => undefined);
      const proceed = vi.fn(async () => undefined);
      const route = {
        request: () => ({ url: () => url }),
        abort,
        continue: proceed,
      } as unknown as Route;
      await fake.route()?.(route);
      expect(proceed).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(abort).toHaveBeenCalledTimes(allowed ? 0 : 1);
    }
  });

  it('escapes and sanitizes the footer supplied by text data', async () => {
    const fake = browserDouble();
    const context = ctx();
    context.texts.ui['report.pdf.footer'] = {
      text: '<img onerror="bad"> T1_internal\u001b[31m\u202e',
      draft: true,
    };
    await renderPdf('<!doctype html><p>report</p>', context, { chromium: fake.chromium });
    const options = fake.page.pdf.mock.calls[0]?.[0] as unknown as { footerTemplate: string };
    expect(options.footerTemplate).toContain('&lt;img');
    expect(options.footerTemplate).not.toContain('<img');
    expect(options.footerTemplate).not.toMatch(/T[0-9]_/);
    expect(options.footerTemplate).not.toContain('\u001b');
    expect(options.footerTemplate).not.toContain('\u202e');
  });

  it('closes Chromium even when printing fails', async () => {
    const fake = browserDouble(new Error('printer unavailable'));
    await expect(renderPdf('<p>report</p>', ctx(), { chromium: fake.chromium })).rejects.toThrow(
      'printer unavailable',
    );
    expect(fake.context.close).toHaveBeenCalledOnce();
  });

  it('closes Chromium and removes its temporary profile when printing never completes', async () => {
    const fake = browserDouble();
    fake.page.pdf.mockImplementationOnce(() => new Promise<typeof fake.bytes>(() => undefined));
    await expect(
      renderPdf('<p>report</p>', ctx(), { chromium: fake.chromium, timeoutMs: 50 }),
    ).rejects.toThrow('PDF print timed out');
    expect(fake.context.close).toHaveBeenCalledOnce();
    const profileDir = fake.launch.mock.calls[0]?.[0];
    expect(profileDir).toBeTypeOf('string');
    expect(existsSync(profileDir!)).toBe(false);
  });
});
