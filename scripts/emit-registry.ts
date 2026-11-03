/** Writes the variant table of the implemented checks into README.md (section "Was geprüft wird") from test/data/ruleset, the single source of variants, severities and `locked` marks; `--check` fails on drift. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRuleset } from '../src/core/data/load.ts';

const doc = fileURLToPath(new URL('../README.md', import.meta.url));
const BEGIN =
  '<!-- registry:begin: generated from test/data/ruleset by `corepack pnpm registry`, do not edit -->';
const END = '<!-- registry:end -->';
const SEVERITIES = ['critical', 'warning', 'info'] as const;

const rows = Object.entries(loadRuleset().checks).map(([id, check]) => [
  `\`${id}\``,
  ...SEVERITIES.map((severity) => {
    const names = Object.entries(check.variants)
      .filter(([, v]) => v.severity === severity)
      .map(([name, v]) => `\`${name}\`${v.locked ? '²' : ''}`);
    return names.length > 0 ? names.join(', ') : '—';
  }),
]);

/** Biome pads the columns of tables in README.md; the generated table is padded the same way so `biome check` and `--check` agree. */
function table(header: string[], body: string[][]): string {
  const all = [header, ...body];
  const widths = header.map((_, col) => Math.max(...all.map((row) => row[col]!.length)));
  const line = (row: string[]) => `| ${row.map((cell, col) => cell.padEnd(widths[col]!)).join(' | ')} |`;
  const separator = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [line(header), separator, ...body.map(line)].join('\n');
}
const rendered = table(['ID', '`critical`', '`warning`', '`info`'], rows);

const current = readFileSync(doc, 'utf8');
const start = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (start < 0 || end < start) {
  console.error('README.md: registry markers not found');
  process.exit(1);
}
const next = `${current.slice(0, start + BEGIN.length)}\n${rendered}\n${current.slice(end)}`;

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error('The variant table in README.md is out of date: run `corepack pnpm registry`');
    process.exit(1);
  }
  console.log('registry table up to date');
} else {
  writeFileSync(doc, next);
  console.log(`wrote ${doc}`);
}
