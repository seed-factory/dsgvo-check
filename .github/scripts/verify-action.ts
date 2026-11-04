/**
 * Checks the outputs of the Action step in ci.yml, which scans a host that cannot be resolved: the step fails with
 * exit code 2, and the reports it promises exist and say why.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readReport, runChecks } from './common.ts';

/** Set by the workflow step from `steps.action.outcome` and `steps.action.outputs.*`. */
const step = {
  outcome: process.env.OUTCOME,
  exitCode: process.env.EXIT_CODE,
  jsonPath: process.env.JSON_PATH,
  htmlPath: process.env.HTML_PATH,
};

/** `out` of the Action step in ci.yml. */
const OUT_DIR = 'dsgvo-check-action';

runChecks({
  'step failed with exit code 2': () => {
    assert.equal(step.outcome, 'failure');
    assert.equal(step.exitCode, '2');
  },

  'html-path and summary.md exist': () => {
    assert.ok(step.htmlPath && existsSync(step.htmlPath), `html-path: ${step.htmlPath}`);
    assert.ok(existsSync(`${OUT_DIR}/summary.md`), `${OUT_DIR}/summary.md is missing`);
  },

  'report.json is a failed scan with reason unreachable': () => {
    assert.ok(step.jsonPath, 'json-path is empty');
    const report = readReport(step.jsonPath);
    assert.equal(report.scan.status, 'failed');
    assert.ok(
      report.summary.exitReasons.includes('unreachable'),
      `exitReasons: ${report.summary.exitReasons}`,
    );
  },
});
