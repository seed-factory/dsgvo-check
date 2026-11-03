import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReportSchema } from '../../src/core/report/schema.ts';

const run = (args: string[]) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
assert.equal(run(['--help']).status, 0);
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const versionRun = run(['--version']);
assert.equal(versionRun.status, 0);
assert.equal(versionRun.stdout.trim(), version);
const out = mkdtempSync(path.join(tmpdir(), 'dsgvo-ci-invalid-'));
const result = run(['ftp://example.test/', '--out', out, '--format', 'json']);
assert.equal(result.status, 2, result.stderr);
const report = ReportSchema.parse(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')));
assert.equal(report.scan.status, 'failed');
assert.ok(report.summary.exitReasons.includes('invalid-input'));
