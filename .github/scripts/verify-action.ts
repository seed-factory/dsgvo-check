import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ReportSchema } from '../../src/core/report-schema.ts';

assert.equal(process.env.OUTCOME, 'failure');
assert.equal(process.env.EXIT_CODE, '2');
assert.ok(process.env.HTML_PATH && existsSync(process.env.HTML_PATH));
assert.ok(existsSync('dsgvo-check-action/summary.md'));
assert.ok(process.env.JSON_PATH);
const report = ReportSchema.parse(JSON.parse(readFileSync(process.env.JSON_PATH, 'utf8')));
assert.equal(report.scan.status, 'failed');
assert.ok(report.summary.exitReasons.includes('unreachable'));
