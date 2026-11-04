/**
 * Checks the built CLI (`dist/cli.js`) the way a user meets it: help and version work, and an unsupported URL ends
 * with exit code 2 and a valid failed report instead of a crash.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageVersion, runChecks } from './common.ts';
import { readReport } from './report.ts';

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
}

runChecks({
  'help exits with 0': () => {
    const help = cli('--help');
    assert.equal(help.status, 0, help.stderr);
  },

  'version equals package.json': () => {
    const result = cli('--version');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageVersion());
  },

  'ftp:// URL ends with exit code 2 and reason invalid-input': () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dsgvo-ci-invalid-'));
    const result = cli('ftp://example.test/', '--out', out, '--format', 'json');
    assert.equal(result.status, 2, result.stderr);

    const report = readReport(path.join(out, 'report.json'));
    assert.equal(report.scan.status, 'failed');
    assert.ok(
      report.summary.exitReasons.includes('invalid-input'),
      `exitReasons: ${report.summary.exitReasons}`,
    );
  },
});
