import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import { sanitizeExternal } from '../../../src/core/redaction/sanitize.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { HOSTILE_TEXT, sampleFailedReport, sampleFullReport } from '../../utils/report/fixtures.ts';

const ctx = (lang: 'de' | 'en' = 'de') => ({ texts: loadTexts(lang), lang, outDir: '/tmp', color: false });

describe('console reporter', () => {
  it('renders findings, checks, diagnostics, exit code and disclaimer', () => {
    const out = renderConsole(sampleFullReport(), ctx());
    expect(out).toContain('KRITISCH');
    expect(out).toContain('CONSENT-01');
    expect(out).toContain('SCAN-BOTMODE');
    expect(out).toContain('Exit-Code 1 (threshold, check-error:MAIL-01)');
    expect(out).toContain('Keine Rechtsberatung');
    expect(out).toContain('[Textentwurf]');
  });

  it('renders the failed report', () => {
    const out = renderConsole(sampleFailedReport(), ctx('en'));
    expect(out).toContain('Scan not performed');
    expect(out).toContain('target-nxdomain');
  });

  it('removes ANSI escapes, bidi controls and workflow commands from external strings', () => {
    const report = sampleFullReport();
    report.scan.target = HOSTILE_TEXT;
    report.findings[0]!.pages = [`https://x.de/${HOSTILE_TEXT}`];
    const out = renderConsole(report, ctx());
    expect(out).not.toContain('\u001b[31m');
    expect(out).not.toContain('‮');
    expect(out).not.toMatch(/^::set-output/m);
  });
});

describe('sanitizeExternal', () => {
  it('strips control characters and collapses newlines', () => {
    expect(sanitizeExternal('a\nb\r\tc\u0007d')).toBe('a b cd');
    expect(sanitizeExternal('\u001b]8;;https://evil\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(sanitizeExternal('::error::x')).toBe(' ::error::x');
    expect(sanitizeExternal('x'.repeat(10), 5)).toBe('xxxx…');
  });
});
