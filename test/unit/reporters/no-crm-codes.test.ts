/** crmCode strings `T[0-9]_` appear only in JSON, never in console, HTML or Summary output. */
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import type { RenderReport, ReporterContext } from '../../../src/core/report/reporter.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderJson } from '../../../src/reporters/json.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report/fixtures.ts';

const T_CODE = /T[0-9]_/;
const ctx: ReporterContext = { texts: loadTexts('de'), lang: 'de', outDir: '/tmp/out', color: false };

const reporters: Array<[string, RenderReport]> = [
  ['console', renderConsole],
  ['summary', renderSummary],
];

describe('human-readable reports', () => {
  it.each(reporters)('%s hides CRM fields in full and failed reports', (_name, render) => {
    expect(render(sampleFullReport(), ctx)).not.toMatch(T_CODE);
    expect(render(sampleFailedReport(), ctx)).not.toMatch(T_CODE);
  });

  it('HTML displays a code-like cookie name safely and hides the field in both detail levels', () => {
    const full = sampleFullReport();
    (full.evidence[1] as { name: string }).name = 'T1_TRACKING_COOKIE';
    full.findings[0]!.params = { service: 'T2_SOMETHING' };
    const html = renderHtml(full, ctx);
    expect(html).toContain('T1&#95;TRACKING_COOKIE');
    expect(html).not.toMatch(/T[0-9]_|crmCode/);
    expect(renderHtml(full, { ...ctx, detail: 'brief' })).not.toMatch(/T[0-9]_|crmCode/);
    expect(renderHtml(sampleFailedReport(), ctx)).not.toMatch(T_CODE);
  });
});

it('the JSON report keeps crmCode', () => {
  expect(renderJson(sampleFullReport(), ctx)).toMatch(/"crmCode": "T1_TRACKER_BEFORE_CONSENT"/);
});
