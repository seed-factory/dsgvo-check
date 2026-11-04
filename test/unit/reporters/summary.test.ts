import { describe, expect, it } from 'vitest';
import { reporterLimits } from '../../../src/core/config/limits.ts';
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

/** The sample report with `count` CONSENT-04 findings that differ only by their fingerprint. */
function withManyFindings(count: number) {
  const r = sampleFullReport();
  const base = r.findings[1]!;
  r.findings = Array.from(
    { length: count },
    (_, i): Finding => ({ ...base, fingerprint: `sha256:${i.toString(16).padStart(64, '0')}` }),
  );
  return r;
}

const findingRows = (md: string) =>
  md.split('\n').filter((l) => l.startsWith('| ') && l.includes('CONSENT-04'));

describe('Job Summary (Markdown)', () => {
  it('renders heading, status, counts, findings, diagnostics and the disclaimer', () => {
    const md = renderSummary(sampleFullReport(), ctx());

    expect(md).toMatch(/^## dsgvo-check/);
    expect(md).toContain('Textentwurf');
    expect(md).toContain('Exit-Code');
    expect(md).toContain('`threshold`');
    expect(md).toContain('`check-error:MAIL-01`');
    expect(md).toMatch(/\| Kritisch \| Warnung \| Hinweis \|/);
    expect(md).toMatch(/\| 1 \| 0 \| 1 \|/);
    expect(md).toContain('CONSENT-01');
    expect(md).toContain('SCAN-BOTMODE');
    expect(md).toContain('keine Rechtsberatung');
    expect(md).toMatch(/\n$/);
  });

  it('uses English labels for --lang en', () => {
    const md = renderSummary(sampleFullReport(), ctx('en'));

    expect(md).toMatch(/\| Critical \| Warning \| Info \|/);
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

  it('does not warn when the container was the sandbox', () => {
    const r = sampleFullReport();
    r.scan.environment.sandbox = { mode: 'container', active: false };
    expect(renderSummary(r, ctx())).not.toContain('--sandbox off');
  });

  it('warns when the sandbox was off', () => {
    const r = sampleFullReport();
    r.scan.environment.sandbox = { mode: 'off', active: false };

    expect(renderSummary(r, ctx())).toContain('--sandbox off');
  });

  it('limits the findings table and points to the full report', () => {
    const r = withManyFindings(SUMMARY_MAX_FINDINGS + 5);

    const md = renderSummary(r, ctx());

    expect(findingRows(md)).toHaveLength(SUMMARY_MAX_FINDINGS);
    expect(md).toContain('5 weitere');
  });

  it('takes the findings limit and the size limit from the settings', () => {
    const r = withManyFindings(10);
    const limits = { ...reporterLimits(), summaryMaxFindings: 3 };

    const md = renderSummary(r, { ...ctx(), limits });

    expect(findingRows(md)).toHaveLength(3);
    expect(md).toContain('7 weitere');

    // the size limit: a summary that is larger than 2 000 bytes by default is cut to below it
    expect(Buffer.byteLength(md)).toBeGreaterThan(2_000);
    const small = renderSummary(r, { ...ctx(), limits: { ...limits, summaryMaxBytes: 2_000 } });
    expect(Buffer.byteLength(small)).toBeLessThan(2_000);
    expect(small).toMatch(/…\n$/);
  });

  it('stays below the GitHub step summary limit', () => {
    const r = sampleFullReport();
    r.findings[0]!.params = { service: 'x'.repeat(100_000) };

    expect(Buffer.byteLength(renderSummary(r, ctx()))).toBeLessThan(1024 * 1024);
  });
});
