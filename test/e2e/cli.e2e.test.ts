/**
 * The built CLI (`node dist/cli.js`) against local fixture sites: exit codes 0/1/2, valid JSON/HTML/Job Summary, and
 * no cookie or storage value in any output.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FullReport, Report } from '../../src/core/report/schema.ts';
import { htmlSafetyProblems } from '../utils/report/html-safety.ts';
import { expectValidReport } from '../utils/report/validator.ts';
import { makeDocumentResponse, makeHttp, makeSnapshot, makeTarget } from '../utils/snapshot-builder.ts';
import {
  type CliRun,
  type E2eEnvironment,
  ensureBuilt,
  pipelineGaps,
  runCli,
  SECRET_MARKER,
  startE2eEnvironment,
} from './support/cli-harness.ts';

const ALL_FORMATS = ['--format', 'console,json,html,summary'];
const FAST = ['--max-pages', '3', '--timeout', '4m'];

let env: E2eEnvironment;

beforeAll(async () => {
  ensureBuilt();
  env = await startE2eEnvironment();
});

afterAll(async () => {
  await env?.close();
});

function expectSafeReports(run: CliRun): Report {
  expect(run.signal, run.stderr).toBeNull();
  expect(run.json, `report.json missing; stderr:\n${run.stderr}`).not.toBeNull();
  const report = run.json as Report;
  expectValidReport(report);
  expect(run.html, 'report.html missing').not.toBeNull();
  expect(htmlSafetyProblems(run.html as string)).toEqual([]);
  expect(run.summary, 'summary.md missing').not.toBeNull();
  expect(run.summary).toMatch(/^## dsgvo-check/);
  expect(run.summary).not.toMatch(/T[0-9]_/);
  expect(run.allText).not.toContain(SECRET_MARKER);
  expect(report.summary.exitCode).toBe(run.code);
  return report;
}

function requirePipeline(report: Report, checks: readonly string[]): void {
  expect(pipelineGaps(report, checks), 'the browser pipeline must be implemented').toEqual([]);
}

describe('dsgvo-check CLI (dist) against local fixture sites', () => {
  it('unreachable target → exit 2, failed report, Job Summary appended', async () => {
    const stepSummary = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-e2e-gh-')), 'step-summary.md');
    const run = await runCli(env, ['https://unreachable.e2e.test/', ...ALL_FORMATS], { stepSummary });
    expect(run.code, run.stderr).toBe(2);
    const report = expectSafeReports(run);
    expect(report.scan.status).toBe('failed');
    expect(report.summary.exitReasons).toContain('unreachable');
    expect(run.html).toContain('target-nxdomain');
    expect(readFileSync(stepSummary, 'utf8')).toMatch(/^## dsgvo-check/);
    expect(env.server.unexpected).toEqual([]);
  });

  it('clean site with --fail-on critical → exit 0', async () => {
    const run = await runCli(env, [
      'https://www.clean-shop.test/',
      '--fail-on',
      'critical',
      ...ALL_FORMATS,
      ...FAST,
    ]);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    const report = expectSafeReports(run) as FullReport;
    expect(report.scan.status).not.toBe('failed');
    expect(report.summary.exitReasons).toEqual([]);
    expect(env.server.unexpected).toEqual([]);
    requirePipeline(report, ['CONSENT-01']);
    expect(report.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(env.server.requestsTo('www.clean-shop.test').length).toBeGreaterThan(0);
    expect(env.server.requestsTo('www.google-analytics.com')).toEqual([]);
  });

  it('tracker before consent → exit 1 (threshold), no cookie or storage values in any output', async () => {
    const run = await runCli(env, ['https://www.tracker-shop.test/', ...ALL_FORMATS, ...FAST]);
    const report = expectSafeReports(run) as FullReport;
    expect(env.server.unexpected).toEqual([]);
    requirePipeline(report, ['CONSENT-01']);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(report.summary.exitReasons).toContain('threshold');
    const critical = report.findings.filter((f) => f.severity === 'critical');
    expect(critical.length).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.checkId === 'CONSENT-01')).toBe(true);
    expect(env.server.requestsTo('www.google-analytics.com').map((r) => r.path.split('?')[0])).toContain(
      '/g/collect',
    );
    // the HTML shows the finding but no crm code
    expect(run.html).toContain('CONSENT-01');
    expect(run.html).not.toMatch(/T[0-9]_/);
  });

  it('tracker with --fail-on none → exit 0', async () => {
    const run = await runCli(env, [
      'https://www.tracker-shop.test/',
      '--fail-on',
      'none',
      ...ALL_FORMATS,
      ...FAST,
    ]);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    const report = expectSafeReports(run) as FullReport;
    expect(report.summary.exitReasons).toEqual([]);
    requirePipeline(report, ['CONSENT-01']);
    expect(report.findings.some((f) => f.severity === 'critical')).toBe(true);
  });

  it('a warning-only saved snapshot exits 1 with --fail-on warning and 0 with critical', async () => {
    const target = 'https://www.example.test/';
    const snapshot = makeSnapshot({
      target: makeTarget(target),
      http: makeHttp({
        documents: [
          makeDocumentResponse({
            url: target,
            headers: [
              { name: 'strict-transport-security', value: 'max-age=31536000' },
              { name: 'content-security-policy', value: "default-src 'self'; frame-ancestors 'none'" },
              { name: 'x-content-type-options', value: 'nosniff' },
              { name: 'referrer-policy', value: 'unsafe-url' },
              { name: 'permissions-policy', value: 'camera=()' },
            ],
          }),
        ],
      }),
    });
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-warning-')), 'input.json');
    writeFileSync(file, JSON.stringify(snapshot));
    for (const [threshold, expectedCode] of [
      ['warning', 1],
      ['critical', 0],
    ] as const) {
      const run = await runCli(null, [
        '--from-snapshot',
        file,
        '--checks',
        'HDR-01',
        '--fail-on',
        threshold,
        ...ALL_FORMATS,
      ]);
      expect(run.code, run.stderr).toBe(expectedCode);
      const report = expectSafeReports(run) as FullReport;
      expect(report.findings.some((finding) => finding.severity === 'warning')).toBe(true);
      expect(report.findings.filter((finding) => finding.severity === 'critical')).toEqual([]);
      expect(report.summary.exitReasons).toEqual(expectedCode === 1 ? ['threshold'] : []);
    }
  });
});
