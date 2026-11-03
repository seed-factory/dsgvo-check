/** Writes .env.example from the settings schema in src/core/config, its only source; `--check` fails on drift. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderEnvExample } from '../src/core/config/env-example.ts';

const file = fileURLToPath(new URL('../.env.example', import.meta.url));
const next = renderEnvExample();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // a missing file is drift too
  }
  if (current !== next) {
    console.error('.env.example is out of date: run `corepack pnpm env:example`');
    process.exit(1);
  }
  console.log('.env.example up to date');
} else {
  writeFileSync(file, next);
  console.log(`wrote ${file}`);
}
