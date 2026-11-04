/** Test preload: launch the real browser, but leave its PDF operation pending until the CLI's deadline. */
import { appendFileSync, copyFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

if (process.env.DSGVO_TEST_STALLED_PDF === '1') {
  const eventsFile = process.env.DSGVO_TEST_PDF_EVENTS;
  const reportFile = process.env.DSGVO_TEST_PDF_REPORT;
  const beforeFile = process.env.DSGVO_TEST_PDF_BEFORE;
  if (!eventsFile || !reportFile || !beforeFile) throw new Error('Missing stalled-PDF fixture paths.');

  const record = (type: string, profile?: string) => {
    appendFileSync(eventsFile, `${JSON.stringify({ type, at: Date.now(), profile })}\n`);
  };

  const launch = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (...args) => {
    // Reports are written before PDF conversion, so this captures the same scan's pre-print JSON.
    copyFileSync(reportFile, beforeFile);
    record('launch', args[0]);

    const context = await launch(...args);
    record('ready');

    const page = context.pages()[0] ?? (await context.newPage());
    page.pdf = async () => {
      record('print');
      return new Promise<Buffer>(() => {});
    };
    return context;
  };
}
