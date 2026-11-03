/**
 * Writes the variant table of the implemented checks into docs/03-checks.md §2.1 from data/ruleset, which is the
 * single source of variants, default severities and `locked` marks. `--check` fails on drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRuleset } from '../src/core/data.ts';

const doc = fileURLToPath(new URL('../docs/03-checks.md', import.meta.url));
const BEGIN = '<!-- registry:begin: generated from data/ruleset by `corepack pnpm registry`, do not edit -->';
const END = '<!-- registry:end -->';
const SEVERITIES = ['critical', 'warning', 'info'] as const;

const rows = Object.entries(loadRuleset().checks).map(([id, check]) => {
  const cells = SEVERITIES.map((severity) => {
    const names = Object.entries(check.variants)
      .filter(([, v]) => v.severity === severity)
      .map(([name, v]) => `\`${name}\`${v.locked ? '²' : ''}`);
    return names.length > 0 ? names.join(', ') : '—';
  });
  return `| \`${id}\` | ${cells.join(' | ')} |`;
});
const table = ['| ID | `critical` | `warning` | `info` |', '|---|---|---|---|', ...rows].join('\n');

const current = readFileSync(doc, 'utf8');
const start = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (start < 0 || end < start) {
  console.error('docs/03-checks.md: registry markers not found');
  process.exit(1);
}
const next = `${current.slice(0, start + BEGIN.length)}\n${table}\n${current.slice(end)}`;

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error('docs/03-checks.md §2.1 is out of date: run `corepack pnpm registry`');
    process.exit(1);
  }
  console.log('registry table up to date');
} else {
  writeFileSync(doc, next);
  console.log(`wrote ${doc}`);
}
