/**
 * `dsgvo-check report <report.json>` regenerates HTML, JSON and PDF from a saved report without scanning, takes its
 * option defaults from the settings, and keeps going when no PDF browser is installed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTexts } from '../../src/core/data/load.ts';
import { uiText } from '../../src/core/data/messages.ts';
import { sampleFullReport } from '../utils/report/fixtures.ts';
import { type CliRun, ensureBuilt, runCli } from './support/cli-harness.ts';

/** Without a browser the PDF step must give up quickly instead of waiting for a download or a launch. */
const NO_BROWSER_TIMEOUT_MS = 30_000;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-report-cli-'));
  tempDirs.push(dir);
  return dir;
}

function reportFile(content = JSON.stringify(sampleFullReport())): string {
  const file = path.join(tempDir(), 'source.json');
  writeFileSync(file, content);
  return file;
}

/** `dsgvo-check report <args>` without fixture sites; its output directory is removed after the tests. */
async function runReport(args: string[], opts: Parameters<typeof runCli>[2] = {}): Promise<CliRun> {
  const run = await runCli(null, ['report', ...args], opts);
  tempDirs.push(run.outDir);
  return run;
}

/** `runReport` options for an environment whose Playwright browser directory is empty. */
const withoutBrowser = () => ({
  env: { PLAYWRIGHT_BROWSERS_PATH: path.join(tempDir(), 'no-browser') },
  timeoutMs: NO_BROWSER_TIMEOUT_MS,
});

function expectNoFile(dir: string, name: string): void {
  expect(existsSync(path.join(dir, name)), `${name} must not be written`).toBe(false);
}

function expectFile(dir: string, name: string): void {
  expect(existsSync(path.join(dir, name)), `${name} must be written`).toBe(true);
}

beforeAll(ensureBuilt);
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('report command regenerates reports without scanning', () => {
  it('defaults to HTML without starting PDF conversion', async () => {
    const run = await runReport([reportFile()]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.html).not.toBeNull();
    expectNoFile(run.outDir, 'report.pdf');
  });

  it('renders every finding in another language and does not enable PDF implicitly', async () => {
    const report = sampleFullReport();
    const source = reportFile(JSON.stringify(report));
    const original = readFileSync(source, 'utf8');

    const run = await runReport([source, '--format', 'html', '--lang', 'en']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.html).toContain('<html lang="en">');
    for (const finding of report.findings) expect(run.html).toContain(finding.checkId);
    expect(run.html).not.toMatch(/T[0-9]_/);
    expect(run.json).toBeNull();
    expectNoFile(run.outDir, 'report.pdf');
    expect(readFileSync(source, 'utf8')).toBe(original);
  });

  it('writes every language and profile below <lang>/<profile>/ and no PDF unless asked', async () => {
    const run = await runReport([
      reportFile(),
      '--format',
      'html',
      '--profile',
      'developer,owner',
      '--lang',
      'de,en',
    ]);

    expect(run.code, run.stderr).toBe(0);
    for (const lang of ['de', 'en']) {
      for (const profile of ['developer', 'owner']) {
        const dir = path.join(run.outDir, lang, profile);
        const html = readFileSync(path.join(dir, 'report.html'), 'utf8');
        expect(html).toContain(`<html lang="${lang}">`);
        expect(html).toContain(profile === 'owner' ? 'front-brief' : 'front-full');
        expectNoFile(dir, 'report.pdf');
      }
    }
    expectNoFile(run.outDir, 'report.html');
  });

  describe('takes the defaults of its options from the settings', () => {
    it('DSGVO_CHECK_REPORT_LANG sets the language, a flag beats it', async () => {
      const source = reportFile();

      const byEnv = await runReport([source], { env: { DSGVO_CHECK_REPORT_LANG: 'en' } });
      const byFlag = await runReport([source, '--lang', 'de'], { env: { DSGVO_CHECK_REPORT_LANG: 'en' } });

      expect(byEnv.code, byEnv.stderr).toBe(0);
      expect(byEnv.html).toContain('<html lang="en">');
      expect(byFlag.html).toContain('<html lang="de">');
    });

    it('a .env file of the working directory counts, the environment beats it', async () => {
      const source = reportFile();
      const dotenv = 'DSGVO_CHECK_REPORT_LANG=en\n';

      const byFile = await runReport([source], { dotenv });
      const byEnv = await runReport([source], { dotenv, env: { DSGVO_CHECK_REPORT_LANG: 'de' } });

      expect(byFile.html).toContain('<html lang="en">');
      expect(byEnv.html).toContain('<html lang="de">');
    });

    it('DSGVO_CHECK_REPORT_FORMATS sets the formats; without it html stays the default', async () => {
      const source = reportFile();

      const byEnv = await runReport([source], { env: { DSGVO_CHECK_REPORT_FORMATS: 'json' } });
      const other = await runReport([source], { env: { DSGVO_CHECK_REPORT_OUT_DIR: 'elsewhere' } });

      expect(byEnv.code, byEnv.stderr).toBe(0);
      expect(byEnv.json).not.toBeNull();
      expect(byEnv.html).toBeNull();
      expect(other.html).not.toBeNull();
      expect(other.json).toBeNull();
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['unrelated JSON', JSON.stringify({ message: 'example' })],
    ['an unsupported schema version', JSON.stringify({ ...sampleFullReport(), schemaVersion: '99.0.0' })],
  ])('rejects %s with exit code 2 and a clear message', async (_name, content) => {
    const run = await runReport([reportFile(content), '--format', 'html', '--lang', 'en']);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(uiText(loadTexts('en'), 'report.cli.invalid'));
    expect(run.html).toBeNull();
    expectNoFile(run.outDir, 'report.pdf');
  });

  it('creates HTML and a nonempty PDF when both formats are requested', async () => {
    const run = await runReport([reportFile(), '--format', 'html,pdf']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.html).not.toBeNull();
    const pdf = readFileSync(path.join(run.outDir, 'report.pdf'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.toString('latin1')).toMatch(/\/Type\s*\/Page\b/);
  });

  it('a missing PDF browser keeps the report and exits successfully with one warning', async () => {
    const source = reportFile();
    const original = readFileSync(source, 'utf8');

    const run = await runReport([source, '--format', 'json,html,pdf', '--lang', 'en'], withoutBrowser());

    expect(run.code, run.stderr).toBe(0);
    expectFile(run.outDir, 'report.html');
    expectNoFile(run.outDir, 'report.pdf');
    expect(readFileSync(source, 'utf8')).toBe(original);
    expect(run.json?.summary).toEqual(JSON.parse(original).summary);

    const warning = uiText(loadTexts('en'), 'report.pdf.skipped');
    expect(run.stderr.split('\n').filter((line) => line.includes(warning))).toHaveLength(1);
    expect(run.stderr).not.toContain("Executable doesn't exist");
  });

  it('PDF-only rendering keeps HTML in memory when the browser is unavailable', async () => {
    const run = await runReport([reportFile(), '--format', 'pdf', '--lang', 'en'], withoutBrowser());

    expect(run.code, run.stderr).toBe(0);
    expectNoFile(run.outDir, 'report.html');
    expectNoFile(run.outDir, 'report.pdf');
    expect(run.stderr).toContain(uiText(loadTexts('en'), 'report.pdf.skipped'));
  });
});
