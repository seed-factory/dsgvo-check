import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { disclaimerParagraphs } from '../../../src/core/data/disclaimer.ts';
import { loadTexts } from '../../../src/core/data/load.ts';
import { scan } from '../../../src/scan.ts';
import type { ScanOptions } from '../../../src/scan-options.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { nxdomainLookup } from '../../utils/scan-harness.ts';
import { opts, withBrowser } from './fixtures.ts';

describe('scan — fatal paths produce a valid minimal failed report (5.1, 5.2)', () => {
  it.each([
    ['unsupported scheme', { url: 'ftp://example.de/' }, 'invalid-input', 'target-unsupported-scheme'],
    ['credentials in URL', { url: 'https://user:pw@example.de/' }, 'invalid-input', 'target-credentials'],
    ['NXDOMAIN', { network: { lookup: nxdomainLookup } }, 'unreachable', 'target-nxdomain'],
    [
      'target resolves to a private address',
      { network: { lookup: async () => [{ address: '10.0.0.5', family: 4 as const }] } },
      'invalid-input',
      'target-not-public',
    ],
    ['unknown --checks id', { checks: ['NOPE-99'] }, 'invalid-input', 'unknown-check'],
    [
      'SOCKS5 proxy (1.0: http:// only)',
      { proxy: 'socks5://127.0.0.1:1080' },
      'invalid-input',
      'invalid-proxy',
    ],
    [
      'override of a locked variant (5.4)',
      { overrides: [{ rule: 'CONSENT-04.banner-not-recognized', severity: 'critical' as const }] },
      'invalid-input',
      'locked-override',
    ],
    [
      '--sandbox container outside the dsgvo-check image',
      { sandbox: 'container' as const },
      'invalid-input',
      'sandbox-container-outside-image',
    ],
    ['invalid --fail-on', { failOn: 'sometimes' as never }, 'invalid-input', 'invalid-fail-on'],
    ['invalid --max-pages', { maxPages: Number.NaN }, 'invalid-input', 'invalid-max-pages'],
    [
      'unreadable --from-snapshot',
      { fromSnapshot: '/nonexistent/snap.json' },
      'invalid-input',
      'snapshot-unreadable',
    ],
    [
      'broken data directory',
      { dataDir: mkdtempSync(path.join(tmpdir(), 'empty-data-')) },
      'internal-error',
      'internal-error',
    ],
  ] as const)('%s', async (_name, over, reason, code) => {
    const result = await scan(opts(over as Partial<ScanOptions>));
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.summary.exitReasons).toContain(reason);
    if (result.report.scan.status === 'failed') expect(result.report.scan.failure.code).toBe(code);
    expectValidReport(result.report);
  });

  it.each([
    ['blocked', 'SCAN-BLOCKED'],
    ['unreachable', 'SCAN-UNREACHABLE'],
    ['sandbox-unavailable', null],
    ['browser-unavailable', null],
  ] as const)('collector fatal %s → failed, results gathered so far are kept', async (reason, diag) => {
    const result = await scan(
      opts({
        collectors: {
          ...withBrowser,
          browser: async () => ({
            status: 'error',
            sections: {},
            fatal: { reason, code: `x-${reason}` },
          }),
        },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.report.scan.status).toBe('failed');
    // TEST-02 (http) still ran and its finding is kept
    expect(result.report.findings?.map((f) => f.checkId)).toEqual(['TEST-02']);
    if (diag) expect(result.report.diagnostics?.map((d) => d.code)).toContain(diag);
    expectValidReport(result.report);
  });
});

describe('scan — the in-memory report carries the composed disclaimer', () => {
  it('conditional paragraphs are part of report.disclaimer.text, not only of the written files', async () => {
    const result = await scan(opts({ sandbox: 'off' }));
    const text = result.report.disclaimer.text;
    expect(text).toMatch(/--sandbox off/);
    expect(text).toMatch(/eigener oder im Auftrag betreuter Websites/);
  });

  it('the minimal failed report too', async () => {
    const result = await scan(opts({ url: 'ftp://example.de/' }));
    expect(result.report.scan.status).toBe('failed');
    expect(result.report.disclaimer.text).toMatch(/Der Scan wurde nicht durchgeführt/);
  });

  it('rendering again after the exit reasons changed replaces the paragraph instead of adding a second one', async () => {
    const { report } = await scan(opts({ url: 'ftp://example.de/' }));
    report.summary.exitReasons = [...report.summary.exitReasons, 'report-write-failed'];
    const paragraphs = disclaimerParagraphs(report, loadTexts('de'));
    const incomplete = paragraphs.filter((p) => p.startsWith('Der Scan wurde nicht'));
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain('report-write-failed');
  });
});
