import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import type { ReporterContext } from '../../../src/core/report/reporter.ts';
import type { Finding } from '../../../src/core/report/schema.ts';
import { renderSummary, SUMMARY_MAX_FINDINGS } from '../../../src/reporters/summary.ts';
import { HOSTILE_TEXT, sampleFailedReport, sampleFullReport } from '../../utils/report/fixtures.ts';

const ctx = (lang: 'de' | 'en' = 'de'): ReporterContext => {
  const texts = loadTexts(lang);
  // A template with external params, so escaping of params is exercised.
  texts.messages['CONSENT-01.tracker-hit'] = {
    title: 'Tracker {service} auf {host} beobachtet',
    body: 'Anfrage an {host} vor einer Einwilligung beobachtet.',
    draft: true,
  };
  return { texts, lang, outDir: '/nonexistent-out', color: false };
};

describe('Job Summary (Markdown)', () => {
  it('renders heading, status, counts, findings, diagnostics and the disclaimer', () => {
    const md = renderSummary(sampleFullReport(), ctx());
    expect(md).toMatch(/^## dsgvo-check/);
    expect(md).toContain('Textentwurf');
    expect(md).toContain('Exit-Code');
    expect(md).toContain('`threshold`');
    expect(md).toContain('`check-error:MAIL-01`');
    expect(md).toMatch(/\| kritisch \| Warnung \| Hinweis \|/);
    expect(md).toMatch(/\| 1 \| 0 \| 1 \|/);
    expect(md).toContain('CONSENT-01');
    expect(md).toContain('SCAN-BOTMODE');
    expect(md).toContain('Keine Rechtsberatung');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('uses English labels for --lang en', () => {
    const md = renderSummary(sampleFullReport(), ctx('en'));
    expect(md).toMatch(/\| critical \| warning \| info \|/);
    expect(md).toContain('Draft text');
  });

  it('notes check errors next to a threshold failure (5.2)', () => {
    const md = renderSummary(sampleFullReport(), ctx());
    expect(md).toMatch(/MAIL-01/);
    expect(md).toContain('Prüfungsfehler');
  });

  it('renders the failed report', () => {
    const md = renderSummary(sampleFailedReport(), ctx());
    expect(md).toContain('target-nxdomain');
    expect(md).toContain('Zielhost konnte nicht aufgelöst werden.');
    expect(md).toContain('`unreachable`');
    expect(md).not.toMatch(/T[0-9]_/);
  });

  it('has no crmCode / T[0-9]_ strings, images or links', () => {
    const r = sampleFullReport();
    (r.evidence[1] as { name: string }).name = 'T1_TRACKING_COOKIE';
    r.findings[0]!.params = {
      service: 'T2_X [link](https://evil.example/) ![img](https://evil.example/x.png)',
    };
    const md = renderSummary(r, ctx());
    expect(md).not.toMatch(/T[0-9]_/);
    expect(md).not.toMatch(/!\[/);
    expect(md).not.toMatch(/\]\(/);
    expect(md).not.toContain('<img');
  });

  it('escapes Markdown and HTML in external strings and neutralizes workflow commands', () => {
    const r = sampleFullReport();
    r.scan.target = `${HOSTILE_TEXT} | col | **bold** \`code\``;
    r.findings[0]!.params = { service: `x\n::error::pwn\n| injected | row |`, host: '<b>x</b>' };
    r.findings[0]!.pages = [`https://www.example.de/a|b\`c<script>`];
    const md = renderSummary(r, ctx());
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<b>');
    expect(md).not.toContain('\u001b');
    expect(md).not.toContain('‮');
    expect(md).not.toMatch(/^::/m);
    expect(md).not.toMatch(/^\| injected/m);
    expect(md).toContain('&lt;script&gt;');
    expect(md).toContain('\\*\\*bold\\*\\*');
    // every table row keeps its column count
    for (const line of md.split('\n').filter((l) => l.startsWith('| '))) {
      const cells = line.replace(/\\\|/g, '').split('|').length;
      expect(cells, line).toBeGreaterThanOrEqual(3);
    }
  });

  it('does not auto-link URLs from scanned sites', () => {
    const r = sampleFullReport();
    r.findings[0]!.params = { service: 'see www.evil.example and https://evil.example/' };
    const md = renderSummary(r, ctx());
    expect(md).not.toMatch(/(^|[^`\w])www\.evil\.example/);
    expect(md).not.toMatch(/(^|[^`])https:\/\/evil\.example/);
  });

  it('warns when the sandbox was off', () => {
    const r = sampleFullReport();
    r.scan.environment.sandbox = { mode: 'off', active: false };
    expect(renderSummary(r, ctx())).toContain('--sandbox off');
  });

  it('limits the findings table and points to the full report', () => {
    const r = sampleFullReport();
    const base = r.findings[1]!;
    r.findings = Array.from(
      { length: SUMMARY_MAX_FINDINGS + 5 },
      (_, i): Finding => ({ ...base, fingerprint: `sha256:${i.toString(16).padStart(64, '0')}` }),
    );
    const md = renderSummary(r, ctx());
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && l.includes('CONSENT-04'));
    expect(rows).toHaveLength(SUMMARY_MAX_FINDINGS);
    expect(md).toContain('5 weitere');
  });

  it('stays below the GitHub step summary limit', () => {
    const r = sampleFullReport();
    r.findings[0]!.params = { service: 'x'.repeat(100_000) };
    expect(Buffer.byteLength(renderSummary(r, ctx()))).toBeLessThan(1024 * 1024);
  });
});
