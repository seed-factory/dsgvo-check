import { describe, expect, it } from 'vitest';
import { buildProgram, toScanOptions } from '../../../src/cli.ts';
import { loadTexts } from '../../../src/core/data.ts';
import { buildFailedReport } from '../../../src/core/report.ts';
import type { ReporterContext } from '../../../src/core/reporter.ts';
import { redactTarget } from '../../../src/core/url.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';

const target = 'https://example.test/\n::set-output name=x::y';

describe('CLI URL input containing a workflow command on a new line', () => {
  it('passes the complete URL as one positional argument without interpreting its contents', async () => {
    let parsedTarget: string | undefined;
    const program = buildProgram().action((url: string) => {
      parsedTarget = url;
    });
    await program.parseAsync([target, '--format', 'console,json', '--lang', 'en'], { from: 'user' });

    expect(program.args).toEqual([target]);
    expect(parsedTarget).toBe(target);
    expect(toScanOptions(parsedTarget, program.opts())).toMatchObject({
      url: target,
      formats: ['console', 'json'],
      lang: 'en',
    });
    expect(redactTarget(target)).toContain('example.test');
    expect(redactTarget(target)).not.toMatch(/[\r\n]/);
  });

  it.each([
    { name: 'console', render: renderConsole },
    { name: 'Job Summary', render: renderSummary },
  ])('does not turn the URL into a separate workflow-command line in $name', ({ render }) => {
    const texts = loadTexts('en');
    const ctx: ReporterContext = { texts, lang: 'en', outDir: '/unused-report-output', color: false };
    const report = buildFailedReport({
      target,
      startedAt: '2026-01-01T00:00:00.000Z',
      failure: { code: 'invalid-cli-option', message: 'Invalid input.' },
      exitReasons: ['invalid-input'],
      texts,
    });
    expect(report.scan.target).toContain('\n::set-output name=x::y');

    const output = render(report, ctx);
    expect(output).toContain('example');
    expect(output).not.toContain(target);
    expect(output).not.toMatch(/^\s*::(?:set-output|error|warning)(?:\s|::)/m);
  });
});
