/**
 * L3: the built CLI (`node dist/cli.js`) against local fixture sites, no internet. Checks exit codes 0/1/2 (5.2),
 * reports (JSON valid against schema/report.schema.json, HTML safe, Job Summary) and that no cookie or storage
 * value reaches any output (D20).
 *
 * Cases that need the browser pipeline (M1 collector, M3 checks) are skipped while those parts are scaffold stubs;
 * with DSGVO_E2E_STRICT=1 (CI) they fail instead.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import type { FullReport, Report } from '../../src/core/report-schema.ts';
import { htmlSafetyProblems } from '../unit/reporters/html-safety.ts';
import { expectValidReport } from '../utils/report-validator.ts';
import {
  type CliRun,
  type E2eEnvironment,
  ensureBuilt,
  pipelineGaps,
  runCli,
  SECRET_MARKER,
  STRICT,
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

function requirePipeline(report: Report, checks: readonly string[], t: TestContext): void {
  const gaps = pipelineGaps(report, checks);
  if (gaps.length === 0) return;
  if (STRICT) throw new Error(`pipeline not implemented: ${gaps.join('; ')}`);
  t.skip(`pipeline not implemented yet: ${gaps.join('; ')}`);
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

  it('clean site with --fail-on critical → exit 0', async (t) => {
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
    requirePipeline(report, ['CONSENT-01'], t);
    expect(report.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(env.server.requestsTo('www.clean-shop.test').length).toBeGreaterThan(0);
    expect(env.server.requestsTo('www.google-analytics.com')).toEqual([]);
  });

  it('tracker before consent → exit 1 (threshold), no cookie or storage values in any output', async (t) => {
    const run = await runCli(env, ['https://www.tracker-shop.test/', ...ALL_FORMATS, ...FAST]);
    const report = expectSafeReports(run) as FullReport;
    expect(env.server.unexpected).toEqual([]);
    requirePipeline(report, ['CONSENT-01'], t);
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

  it('tracker with --fail-on none → exit 0', async (t) => {
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
    requirePipeline(report, ['CONSENT-01'], t);
    expect(report.findings.some((f) => f.severity === 'critical')).toBe(true);
  });
});
