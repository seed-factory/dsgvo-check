/** Load the self-contained template and hash its actual style bytes for CSP. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from '../core/data.ts';
import type { RenderReport } from '../core/reporter.ts';
import { buildReportView } from './report-view.ts';
import { renderTemplate } from './template.ts';

function loadTemplate(dataDir = DEFAULT_DATA_DIR): { template: string; styleHash: string } {
  const template = readFileSync(path.join(dataDir, 'report', 'report.html'), 'utf8').replace(/\r\n?/g, '\n');
  const styles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1 || styles[0]![1]!.includes('{{')) throw new Error('Invalid report style block');
  return { template, styleHash: createHash('sha256').update(styles[0]![1]!).digest('base64') };
}
export const renderHtml: RenderReport = (report, ctx) => {
  const { template, styleHash } = loadTemplate(ctx.dataDir);
  return renderTemplate(template, { ...buildReportView(report, ctx), styleHash }, ctx);
};
