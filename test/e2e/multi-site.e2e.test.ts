/** One run over a targets file: a directory per site, every language and profile as its own report, the sites one after another. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Report } from '../../src/core/report/schema.ts';
import { expectValidReport } from '../utils/report/validator.ts';
import {
  type CliRun,
  type E2eEnvironment,
  ensureBuilt,
  runCli,
  SECRET_MARKER,
  startE2eEnvironment,
} from './support/cli-harness.ts';

const CLEAN = 'www.clean-shop.test';
const TRACKER = 'www.tracker-shop.test';
/** Two scans and eight PDF prints. */
const RUN_TIMEOUT_MS = 600_000;

let env: E2eEnvironment;
let run: CliRun;
const tempDirs: string[] = [];

beforeAll(async () => {
  ensureBuilt();
  env = await startE2eEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('a run over a targets file', () => {
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsgvo-targets-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'targets.txt');
    writeFileSync(file, `# shops\n\nhttps://${CLEAN}/\nhttps://${TRACKER}/ # with tracking\n`);
    run = await runCli(
      env,
      [
        '--targets',
        file,
        '--profile',
        'developer,owner',
        '--lang',
        'de,en',
        '--format',
        'console,json,html,pdf',
        '--max-pages',
        '3',
        '--timeout',
        '4m',
      ],
      { timeoutMs: RUN_TIMEOUT_MS - 30_000 },
    );
    tempDirs.push(run.outDir);
  }, RUN_TIMEOUT_MS);

  const siteFile = (host: string, ...parts: string[]) => path.join(run.outDir, host, ...parts);

  it('exits with the worst code of its sites and keeps the root of the output directory empty', () => {
    expect(run.signal, run.stderr).toBeNull();
    expect(run.code, run.stderr).toBe(1);
    expect(existsSync(path.join(run.outDir, 'report.json'))).toBe(false);
  });

  it.each([
    [CLEAN, 0],
    [TRACKER, 1],
  ])(
    '%s: valid report.json and the exit code of its own scan, named on stderr in the first language',
    (host, code) => {
      const report = JSON.parse(readFileSync(siteFile(host, 'report.json'), 'utf8')) as Report;
      expectValidReport(report);
      expect(report.summary.exitCode).toBe(code);
      expect(run.stderr).toContain(`https://${host}/: Exit-Code ${code}`);
    },
  );

  it.each(
    [CLEAN, TRACKER].flatMap((host) =>
      ['de', 'en'].flatMap((lang) => ['developer', 'owner'].map((profile) => [host, lang, profile])),
    ),
  )('%s: report.html and report.pdf in %s/%s', (host, lang, profile) => {
    const html = readFileSync(siteFile(host, lang, profile, 'report.html'), 'utf8');
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(profile === 'owner' ? 'front-brief' : 'front-full');
    expect(
      readFileSync(siteFile(host, lang, profile, 'report.pdf'))
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect(existsSync(siteFile(host, 'report.html'))).toBe(false);
  });

  it('the owner report differs from the developer report', () => {
    const owner = readFileSync(siteFile(TRACKER, 'en', 'owner', 'report.html'), 'utf8');
    const developer = readFileSync(siteFile(TRACKER, 'en', 'developer', 'report.html'), 'utf8');
    expect(owner).not.toBe(developer);
  });

  it('scans the sites one after another', () => {
    const times = (host: string) => env.server.requestsTo(host).map((r) => r.at);
    const clean = times(CLEAN);
    const tracker = times(TRACKER);
    expect(clean.length).toBeGreaterThan(0);
    expect(tracker.length).toBeGreaterThan(0);
    expect(Math.max(...clean)).toBeLessThan(Math.min(...tracker));
  });

  it('leaks no cookie or storage value', () => {
    expect(run.allText).not.toContain(SECRET_MARKER);
  });
});
