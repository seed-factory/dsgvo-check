/** L0 (5.6): crmCode strings `T[0-9]_` appear only in JSON — never in console, HTML or Summary output. */
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data.ts';
import { NotImplementedError } from '../../../src/core/errors.ts';
import type { RenderReport, ReporterContext } from '../../../src/core/reporter.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderJson } from '../../../src/reporters/json.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report-fixtures.ts';

const T_CODE = /T[0-9]_/;
const ctx: ReporterContext = { texts: loadTexts('de'), lang: 'de', outDir: '/tmp/out', color: false };

const reporters: Array<[string, RenderReport]> = [
  ['console', renderConsole],
  ['html', renderHtml],
  ['summary', renderSummary],
];

describe.each(reporters)('%s output', (_name, render) => {
  it.for([
    ['full report', sampleFullReport()],
    ['failed report', sampleFailedReport()],
  ] as const)('has no T[0-9]_ codes (%s)', ([_label, report], testCtx) => {
    let out: string;
    try {
      out = render(report, ctx);
    } catch (err) {
      if (err instanceof NotImplementedError) return testCtx.skip();
      throw err;
    }
    expect(out).not.toMatch(T_CODE);
  });
});

it('the JSON report keeps crmCode', () => {
  expect(renderJson(sampleFullReport(), ctx)).toMatch(/"crmCode": "T1_TRACKER_BEFORE_CONSENT"/);
});
