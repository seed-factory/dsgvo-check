/**
 * Writes test/fixtures/snapshots/browser/<ID>/*.json from scenarios.ts.
 * Run: node test/unit/checks/browser/generate-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_FIXTURES_DIR } from '../../../utils/snapshot-builder.ts';
import { fixtureBody } from './helpers.ts';
import { SCENARIOS, type Scenario } from './scenarios.ts';

export function fixtureJson(s: Scenario): string {
  const body = { $description: s.description, $expect: s.expect, ...fixtureBody(s.build()) };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function fixturePath(checkId: string, s: Scenario): string {
  return path.join(SNAPSHOT_FIXTURES_DIR, 'browser', checkId, s.file);
}

if (import.meta.main) {
  for (const [checkId, list] of Object.entries(SCENARIOS)) {
    for (const s of list) {
      const file = fixturePath(checkId, s);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, fixtureJson(s));
      console.log(path.relative(process.cwd(), file));
    }
  }
}
