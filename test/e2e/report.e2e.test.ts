import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTexts } from '../../src/core/data/load.ts';
import { uiText } from '../../src/core/data/messages.ts';
import { sampleFullReport } from '../utils/report/fixtures.ts';
import { CLI, ensureBuilt, runCli } from './support/cli-harness.ts';

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

beforeAll(ensureBuilt);
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('report command regenerates reports without scanning', () => {
  it('defaults to HTML without starting PDF conversion', async () => {
    const run = await runCli(null, ['report', reportFile()]);
    tempDirs.push(run.outDir);
    expect(run.code, run.stderr).toBe(0);
    expect(run.html).not.toBeNull();
    expect(existsSync(path.join(run.outDir, 'report.pdf'))).toBe(false);
  });

  it('renders every finding in another language and does not enable PDF implicitly', async () => {
    const report = sampleFullReport();
    const source = reportFile(JSON.stringify(report));
    const original = readFileSync(source, 'utf8');
    const run = await runCli(null, ['report', source, '--format', 'html', '--lang', 'en']);
    tempDirs.push(run.outDir);
    expect(run.code, run.stderr).toBe(0);
    expect(run.html).toContain('<html lang="en">');
    for (const finding of report.findings) expect(run.html).toContain(finding.checkId);
    expect(run.html).not.toMatch(/T[0-9]_/);
    expect(run.json).toBeNull();
    expect(existsSync(path.join(run.outDir, 'report.pdf'))).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe(original);
  });

  describe('takes the defaults of its options from the settings', () => {
    it('DSGVO_CHECK_REPORT_LANG sets the language, a flag beats it', async () => {
      const source = reportFile();
      const byEnv = await runCli(null, ['report', source], { env: { DSGVO_CHECK_REPORT_LANG: 'en' } });
      tempDirs.push(byEnv.outDir);
      expect(byEnv.code, byEnv.stderr).toBe(0);
      expect(byEnv.html).toContain('<html lang="en">');
      const byFlag = await runCli(null, ['report', source, '--lang', 'de'], {
        env: { DSGVO_CHECK_REPORT_LANG: 'en' },
      });
      tempDirs.push(byFlag.outDir);
      expect(byFlag.html).toContain('<html lang="de">');
    });

    it('a .env file of the working directory counts, the environment beats it', async () => {
      const source = reportFile();
      const dotenv = 'DSGVO_CHECK_REPORT_LANG=en\n';
      const byFile = await runCli(null, ['report', source], { dotenv });
      tempDirs.push(byFile.outDir);
      expect(byFile.html).toContain('<html lang="en">');
      const byEnv = await runCli(null, ['report', source], {
        dotenv,
        env: { DSGVO_CHECK_REPORT_LANG: 'de' },
      });
      tempDirs.push(byEnv.outDir);
      expect(byEnv.html).toContain('<html lang="de">');
    });

    it('DSGVO_CHECK_REPORT_FORMATS sets the formats; without it html stays the default', async () => {
      const source = reportFile();
      const byEnv = await runCli(null, ['report', source], { env: { DSGVO_CHECK_REPORT_FORMATS: 'json' } });
      tempDirs.push(byEnv.outDir);
      expect(byEnv.code, byEnv.stderr).toBe(0);
      expect(byEnv.json).not.toBeNull();
      expect(byEnv.html).toBeNull();
      const other = await runCli(null, ['report', source], {
        env: { DSGVO_CHECK_REPORT_OUT_DIR: 'elsewhere' },
      });
      tempDirs.push(other.outDir);
      expect(other.html).not.toBeNull();
      expect(other.json).toBeNull();
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['unrelated JSON', JSON.stringify({ message: 'example' })],
    ['an unsupported schema version', JSON.stringify({ ...sampleFullReport(), schemaVersion: '99.0.0' })],
  ])('rejects %s with exit code 2 and a clear message', async (_name, content) => {
    const run = await runCli(null, ['report', reportFile(content), '--format', 'html', '--lang', 'en']);
    tempDirs.push(run.outDir);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(uiText(loadTexts('en'), 'report.cli.invalid'));
    expect(run.html).toBeNull();
    expect(existsSync(path.join(run.outDir, 'report.pdf'))).toBe(false);
  });

  it('creates HTML and a nonempty PDF when both formats are requested', async () => {
    const run = await runCli(null, ['report', reportFile(), '--format', 'html,pdf']);
    tempDirs.push(run.outDir);
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
    const out = tempDir();
    const result = await runWithoutBrowser([
      'report',
      source,
      '--format',
      'json,html,pdf',
      '--lang',
      'en',
      '--out',
      out,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(path.join(out, 'report.html'))).toBe(true);
    expect(existsSync(path.join(out, 'report.pdf'))).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe(original);
    const written = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(written.summary).toEqual(JSON.parse(original).summary);
    const warning = uiText(loadTexts('en'), 'report.pdf.skipped');
    expect(result.stderr.split('\n').filter((line) => line.includes(warning))).toHaveLength(1);
    expect(result.stderr).not.toContain("Executable doesn't exist");
  });

  it('PDF-only rendering keeps HTML in memory when the browser is unavailable', async () => {
    const out = tempDir();
    const result = await runWithoutBrowser([
      'report',
      reportFile(),
      '--format',
      'pdf',
      '--lang',
      'en',
      '--out',
      out,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(path.join(out, 'report.html'))).toBe(false);
    expect(existsSync(path.join(out, 'report.pdf'))).toBe(false);
    expect(result.stderr).toContain(uiText(loadTexts('en'), 'report.pdf.skipped'));
  });
});

function runWithoutBrowser(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(tempDir(), 'no-browser'),
    NO_COLOR: '1',
  };
  delete env.GITHUB_STEP_SUMMARY;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
