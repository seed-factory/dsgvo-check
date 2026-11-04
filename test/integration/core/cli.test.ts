/** CLI exit codes and failed reports ("invalid input" / "unreachable"). Runs src/cli.ts via type stripping. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFLINE_HOOK, offlineHookEnv } from '../../utils/preload/offline-network-hook.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { REPO_ROOT } from '../../utils/snapshot-builder.ts';

const cli = path.join(REPO_ROOT, 'src/cli.ts');

/**
 * Loopback-only, no internet: a preload makes the resolver answer ENOTFOUND for every host and log each lookup.
 */
function run(...args: string[]) {
  const lookupLog = path.join(mkdtempSync(path.join(tmpdir(), 'cli-dns-')), 'lookups.log');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(OFFLINE_HOOK).href, cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...offlineHookEnv(lookupLog) },
    timeout: 60_000,
  });
  const lookups = existsSync(lookupLog) ? readFileSync(lookupLog, 'utf8').split('\n').filter(Boolean) : [];
  return { ...r, lookups };
}

describe('dsgvo-check CLI', () => {
  it('help → 0', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--fail-on <level>');
    expect(r.stdout).toContain('install');
  });

  it('help carries the Nutzungshinweise (own sites, UA token, phase C, DNS with --proxy)', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Nutzungshinweise');
    expect(r.stdout).toMatch(/eigener oder im Auftrag betreuter Websites/);
    expect(r.stdout).toMatch(/dsgvo-check\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\//);
    expect(r.stdout).toContain('Phase C');
    expect(r.stdout).toContain('--proxy');
  });

  it('a failed report written by the CLI itself carries the conditional disclaimer paragraphs', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'cli-out-'));
    const r = run('https://example.de', '--lang', 'fr', '--out', out);
    expect(r.status).toBe(2);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(report.disclaimer.text).toMatch(/Der Scan wurde nicht durchgeführt/);
    expect(report.disclaimer.text).toMatch(/eigener oder im Auftrag betreuter Websites/);
  });

  it('unknown option → 2', () => {
    expect(run('--bogus').status).toBe(2);
  });

  it('missing URL → 2', () => {
    expect(run().status).toBe(2);
  });

  it.each([
    [['ftp://example.de'], 'invalid-input'],
    [['https://example.de', '--lang', 'fr'], 'invalid-input'],
    [['https://example.de', '--timeout', 'soon'], 'invalid-input'],
    [['https://does-not-exist.invalid'], 'unreachable'],
  ])('%j → 2 with a valid failed report', (args, reason) => {
    const out = mkdtempSync(path.join(tmpdir(), 'cli-out-'));

    const r = run(...args, '--out', out);

    expect(r.status).toBe(2);
    const file = path.join(out, 'report.json');
    expect(existsSync(file)).toBe(true);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    expectValidReport(report);
    expect(report.scan.status).toBe('failed');
    expect(report.summary.exitReasons).toContain(reason);
  });

  it('the unreachable target is resolved only by the offline test resolver', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'cli-out-'));
    const r = run('https://does-not-exist.invalid', '--out', out);

    expect(r.status).toBe(2);
    expect(r.lookups).toEqual(['does-not-exist.invalid']);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(report.scan.failure.code).toBe('target-nxdomain');
  });

  it.each([
    ['rejected by the CLI', ['--lang', 'fr']],
    ['rejected by scan()', []],
  ])('a target with credentials and query (%s) is redacted in report.json and stderr', (_n, extra) => {
    const out = mkdtempSync(path.join(tmpdir(), 'cli-out-'));
    const r = run('https://demo-user:demo-password@example.de/?sid=demo-session', ...extra, '--out', out);

    expect(r.status).toBe(2);
    const json = readFileSync(path.join(out, 'report.json'), 'utf8');
    expectValidReport(JSON.parse(json));
    for (const secret of ['demo-user', 'demo-password', 'demo-session']) {
      expect(json).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
    expect(r.lookups).toEqual([]);
  });
});
