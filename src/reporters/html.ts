/** Load the self-contained template and hash its actual style bytes for CSP. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from '../core/data/load.ts';
import type { RenderReport } from '../core/report/reporter.ts';
import { buildReportView } from './report-view.ts';
import { renderTemplate } from './template.ts';

// One pass over the source: a whole <style> block, the `{{nl}}` marker, or whitespace between two markup tokens.
const SOURCE_LAYOUT = /(<style>[\s\S]*?<\/style>)|\{\{nl\}\}|(?<=>|\}\})[ \t\n]+(?=<|\{\{)/g;

/**
 * The template is indented for reading, which must not reach the output or the CSP hash: whitespace with a line break
 * between markup tokens is dropped, `{{nl}}` becomes `\n`, and line breaks inside <style> are folded away.
 */
export function normalizeTemplateLayout(source: string): string {
  return source.replace(SOURCE_LAYOUT, (match, style?: string) => {
    if (style !== undefined) return style.replace(/[ \t\n]*\n[ \t\n]*/g, '');
    if (match === '{{nl}}') return '\n';
    return match.includes('\n') ? '' : match;
  });
}

function loadTemplate(dataDir = DEFAULT_DATA_DIR): { template: string; styleHash: string } {
  const template = normalizeTemplateLayout(
    readFileSync(path.join(dataDir, 'report', 'report.html'), 'utf8').replace(/\r\n?/g, '\n'),
  );
  const styles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1 || styles[0]![1]!.includes('{{')) throw new Error('Invalid report style block');
  return { template, styleHash: createHash('sha256').update(styles[0]![1]!).digest('base64') };
}
export const renderHtml: RenderReport = (report, ctx) => {
  const { template, styleHash } = loadTemplate(ctx.dataDir);
  return renderTemplate(template, { ...buildReportView(report, ctx), styleHash }, ctx);
};
