/**
 * Live smoke (internet; never part of `pnpm test`): the built CLI against a few real sites, one at a time.
 *   corepack pnpm build && corepack pnpm test:live
 * Sites: DSGVO_LIVE_SITES (comma-separated URLs), default: a German federal portal, a German CMP vendor site
 * (Borlabs) and a non-EU government site. Reports go to DSGVO_LIVE_OUT (default: a temp dir) and are kept.
 *
 * Sanity checks only, no verdicts about the sites: exit code and report agree, JSON is schema-valid, the console and
 * HTML carry no CRM codes, the HTML is self-contained, no cookie or storage values appear, and every
 * critical finding is printed for manual review.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FullReport, Report } from '../../src/core/report-schema.ts';
import { htmlSafetyProblems } from '../unit/reporters/html-safety.ts';
import { validateReport } from '../utils/report-validator.ts';
import { REPO_ROOT } from '../utils/snapshot-builder.ts';

const CLI = path.join(REPO_ROOT, 'dist/cli.js');
const DEFAULT_SITES = ['https://www.bund.de/', 'https://borlabs.io/', 'https://www.usa.gov/'];
const SITES = (process.env.DSGVO_LIVE_SITES ?? DEFAULT_SITES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = process.env.DSGVO_LIVE_OUT ?? mkdtempSync(path.join(tmpdir(), 'dsgvo-live-'));
/** Pause between sites to limit traffic to each host. */
const PAUSE_MS = 10_000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

function runCli(url: string, outDir: string): Promise<Run> {
  mkdirSync(outDir, { recursive: true });
  const args = [CLI, url, '--fail-on', 'none', '--format', 'console,json,html', '--out', outDir];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, outDir }));
  });
}

/** Cookie and storage evidence must carry names, flags and lengths only. */
function valueLeaks(report: Report): string[] {
  const leaks: string[] = [];
  for (const e of report.evidence ?? []) {
    if ((e.type === 'cookie' || e.type === 'storage') && 'value' in e) leaks.push(`${e.type}:${e.id}`);
  }
  return leaks;
}

describe.skipIf(!existsSync(CLI))('live smoke (built CLI, real sites)', () => {
  it.each(SITES.map((url, i) => [url, i]))('%s', async (url, i) => {
    if ((i as number) > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const outDir = path.join(OUT, new URL(url as string).hostname);
    const run = await runCli(url as string, outDir);
    const json = path.join(outDir, 'report.json');
    expect(existsSync(json), run.stderr).toBe(true);
    const report = JSON.parse(readFileSync(json, 'utf8')) as Report;
    const html = readFileSync(path.join(outDir, 'report.html'), 'utf8');

    expect(validateReport(report).errors).toBe('');
    expect(report.summary.exitCode).toBe(run.code);
    // --fail-on none: only a fatal scan failure may give a non-zero exit code.
    if (report.scan.status === 'failed') expect(run.code).toBe(2);
    else expect(run.code).toBe(0);
    expect(run.stdout).not.toMatch(/T[0-9]_/);
    expect(htmlSafetyProblems(html)).toEqual([]);
    expect(valueLeaks(report)).toEqual([]);

    const full = report as FullReport;
    const critical = (full.findings ?? []).filter((f) => f.severity === 'critical');
    const collectors = report.scan.status === 'failed' ? null : full.scan.coverage?.collectors;
    console.log(
      JSON.stringify(
        {
          url,
          exit: run.code,
          status: report.scan.status,
          collectors,
          checks: (full.checks ?? []).map((c) => `${c.id}:${c.status}${c.reason ? `/${c.reason}` : ''}`),
          findings: (full.findings ?? []).map(
            (f) => `${f.severity} ${f.checkId}.${f.variant} ${f.serviceId ?? ''}`,
          ),
          critical: critical.map((f) => `${f.checkId}.${f.variant}`),
          diagnostics: (full.diagnostics ?? []).map((d) => d.code),
          outDir,
        },
        null,
        2,
      ),
    );
  });
});
