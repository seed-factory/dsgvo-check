/** Load the self-contained template and hash its actual style bytes for CSP. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from '../core/data.ts';
import type { RenderReport } from '../core/reporter.ts';
import { buildReportView } from './report-view.ts';
import { renderTemplate } from './template.ts';

// One pass over the source: a whole <style> block, the `{{nl}}` marker, or whitespace between two markup tokens.
const SOURCE_LAYOUT = /(<style>[\s\S]*?<\/style>)|\{\{nl\}\}|(?<=>|\}\})[ \t\n]+(?=<|\{\{)/g;

/**
 * The template is indented for reading, and the layout must not reach the output or the CSP hash:
 * - Whitespace that contains a line break and sits between `>`/`}}` and `<`/`{{` is dropped. A single space on one
 *   line stays, because it separates inline elements; text next to a line break is never touched.
 * - `{{nl}}` becomes one `\n`, for the few line breaks the document itself needs.
 * - Inside <style> every line break with its indentation is folded away, so CSS can be written one declaration
 *   per line and the hashed text is the same as for the minified form.
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
