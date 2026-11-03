/**
 * Settings of the built CLI: environment variables and a `.env` file of the working directory, their precedence
 * against flags, invalid values (exit 2) and the report that shows what differs from the defaults. Scans start from a
 * saved snapshot, so no browser is involved.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FullReport } from '../../src/core/report/schema.ts';
import { expectValidReport } from '../utils/report/validator.ts';
import {
  makeDocumentResponse,
  makeHttp,
  makeSnapshot,
  makeTarget,
  REPO_ROOT,
} from '../utils/snapshot-builder.ts';
import { ensureBuilt, runCli } from './support/cli-harness.ts';

const TARGET = 'https://www.example.test/';

/** A start document with one warning of HDR-01 (an unsafe Referrer-Policy). */
function warningSnapshot(): string {
  const snapshot = makeSnapshot({
    target: makeTarget(TARGET),
    http: makeHttp({
      documents: [
        makeDocumentResponse({
          url: TARGET,
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
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsgvo-settings-')), 'input.json');
  writeFileSync(file, JSON.stringify(snapshot));
  return file;
}

const FROM_SNAPSHOT = (file: string) => [
  '--from-snapshot',
  file,
  '--checks',
  'HDR-01',
  '--format',
  'json,html',
];

beforeAll(() => {
  ensureBuilt();
});

describe('settings: precedence', () => {
  it('without any setting the threshold is critical: the warning does not fail the build', async () => {
    const run = await runCli(null, FROM_SNAPSHOT(warningSnapshot()));
    expect(run.code, run.stderr).toBe(0);
    const report = run.json as FullReport;
    expect(report.scan.options).not.toHaveProperty('settings');
    expect(run.html).not.toContain('Abweichende Einstellungen');
    expect(run.stderr).not.toContain('.env');
  });

  it('a .env file sets the default of a flag and is announced on stderr', async () => {
    const run = await runCli(null, FROM_SNAPSHOT(warningSnapshot()), {
      dotenv: 'DSGVO_CHECK_SCAN_FAIL_ON=warning\n',
    });
    expect(run.code, run.stderr).toBe(1);
    expect(run.json?.summary.exitReasons).toEqual(['threshold']);
    expect(run.stderr).toMatch(/Einstellungen aus .*\.env gelesen: 1/);
  });

  it('the environment beats .env, and a flag beats both', async () => {
    const file = warningSnapshot();
    const dotenv = 'DSGVO_CHECK_SCAN_FAIL_ON=warning\n';
    const byEnv = await runCli(null, FROM_SNAPSHOT(file), {
      dotenv,
      env: { DSGVO_CHECK_SCAN_FAIL_ON: 'none' },
    });
    expect(byEnv.code, byEnv.stderr).toBe(0);
    const byFlag = await runCli(null, [...FROM_SNAPSHOT(file), '--fail-on', 'critical'], {
      dotenv,
      env: { DSGVO_CHECK_SCAN_FAIL_ON: 'warning' },
    });
    expect(byFlag.code, byFlag.stderr).toBe(0);
    const flagStricter = await runCli(null, [...FROM_SNAPSHOT(file), '--fail-on', 'warning'], {
      env: { DSGVO_CHECK_SCAN_FAIL_ON: 'none' },
    });
    expect(flagStricter.code, flagStricter.stderr).toBe(1);
  });

  it('the report lists what differs from the defaults, and nothing else', async () => {
    const run = await runCli(null, FROM_SNAPSHOT(warningSnapshot()), {
      dotenv:
        'DSGVO_CHECK_TLS_EXPIRING_DAYS=21\nDSGVO_CHECK_HTTP_MAX_REDIRECTS=5\nOTHER_TOOL_SECRET=hunter2\n',
      env: { DSGVO_CHECK_PROXY: 'http://user:hunter3@proxy.invalid:3128' },
    });
    expect(run.code, run.stderr).toBe(0);
    const report = run.json as FullReport;
    expectValidReport(report);
    expect(report.scan.options?.settings).toEqual({ DSGVO_CHECK_TLS_EXPIRING_DAYS: 21 });
    expect(report.scan.options?.proxy).toBe(true);
    expect(run.html).toContain('Abweichende Einstellungen');
    expect(run.html).toContain('DSGVO_CHECK_TLS_EXPIRING_DAYS=21');
    expect(run.allText).not.toContain('hunter');
  });

  it('a variable that matches no setting is ignored with a note', async () => {
    const run = await runCli(null, FROM_SNAPSHOT(warningSnapshot()), {
      env: { DSGVO_CHECK_BROWSER_NAVIGATION_PAUS_MS: '2000' },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      'Unbekannte Einstellungen ignoriert: DSGVO_CHECK_BROWSER_NAVIGATION_PAUS_MS',
    );
  });
});

describe('settings: invalid values', () => {
  it('a value below the passive limit ends the scan with exit 2 before anything is visited', async () => {
    const run = await runCli(null, [TARGET, '--format', 'json'], {
      env: { DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS: '1000' },
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS=1000 (Umgebung)');
    expect(run.stderr).toContain('muss mindestens 1500 sein');
    const report = run.json;
    expect(report?.scan.status).toBe('failed');
    expect(report?.scan.failure?.code).toBe('invalid-config');
    expect(report?.summary.exitReasons).toEqual(['invalid-input']);
    expectValidReport(report as FullReport);
  });

  it('a malformed value in .env names the file; the secret proxy value is never printed', async () => {
    const run = await runCli(null, [TARGET, '--format', 'json'], {
      dotenv: 'DSGVO_CHECK_SCAN_MAX_PAGES=many\nDSGVO_CHECK_PROXY=https://user:hunter2@proxy.invalid\n',
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/DSGVO_CHECK_SCAN_MAX_PAGES=many \(.*\.env\): erwartet eine ganze Zahl/);
    expect(run.stderr).toContain('DSGVO_CHECK_PROXY (');
    expect(run.allText).not.toContain('hunter2');
  });

  it('the problems are worded in the language of the run', async () => {
    const run = await runCli(null, [TARGET, '--format', 'json', '--lang', 'en'], {
      env: { DSGVO_CHECK_HTTP_MIN_INTERVAL_MS: '100' },
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      'DSGVO_CHECK_HTTP_MIN_INTERVAL_MS=100 (environment): must be at least 500: values may only be made stricter',
    );
  });

  it('the report command refuses invalid settings too', async () => {
    const run = await runCli(
      null,
      ['report', path.join(REPO_ROOT, 'test/fixtures/reports/sample-full.report.json')],
      {
        env: { DSGVO_CHECK_PDF_TIMEOUT_MS: '500' },
      },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('DSGVO_CHECK_PDF_TIMEOUT_MS=500');
  });

  it('--help and --version work with invalid settings', async () => {
    for (const flag of ['--help', '--version']) {
      const run = await runCli(null, [flag], { env: { DSGVO_CHECK_SCAN_MAX_PAGES: 'x' } });
      expect(run.code, run.stderr).toBe(0);
    }
  });
});
