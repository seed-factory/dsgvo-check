/** Helpers shared by the CI step scripts: package version, report reading and GitHub step outputs. */
import { appendFileSync, readFileSync } from 'node:fs';
import { type Report, ReportSchema } from '../../src/core/report/schema.ts';

const PACKAGE_JSON = new URL('../../package.json', import.meta.url);

/** `version` from package.json: the image tag and the Action tag follow it. */
export function packageVersion(): string {
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };
  return version;
}

/** report.json parsed against the report schema, so a malformed report fails the step too. */
export function readReport(file: string): Report {
  return ReportSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** A variable GitHub sets for every step; missing means the script runs outside Actions. */
export function githubFile(name: 'GITHUB_OUTPUT' | 'GITHUB_STEP_SUMMARY'): string {
  const file = process.env[name];
  if (!file) throw new Error(`${name} is not set: run this script as a GitHub Actions step.`);
  return file;
}

export function setOutput(name: string, value: string): void {
  appendFileSync(githubFile('GITHUB_OUTPUT'), `${name}=${value}\n`);
}

/** Runs named checks in order and prints each one, so a failed step shows which check broke. */
export function runChecks(checks: Readonly<Record<string, () => void>>): void {
  for (const [name, check] of Object.entries(checks)) {
    check();
    console.log(`ok  ${name}`);
  }
}
