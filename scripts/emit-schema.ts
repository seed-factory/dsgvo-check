/** Writes schema/report.schema.json (JSON Schema 2020-12) from the zod report schema. `--check` fails on drift. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportJsonSchema } from '../src/core/report-schema.ts';

const out = fileURLToPath(new URL('../schema/report.schema.json', import.meta.url));
const json = `${JSON.stringify(reportJsonSchema(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    // missing file counts as drift
  }
  if (current !== json) {
    console.error('schema/report.schema.json is out of date: run `corepack pnpm schema`');
    process.exit(1);
  }
  console.log('schema up to date');
} else {
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
