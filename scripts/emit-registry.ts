import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRuleset } from '../src/core/data/load.ts';

const docs = [
  { name: 'README.md', locked: 'locked' },
  { name: 'README.de.md', locked: 'fest' },
];
const BEGIN =
  '<!-- registry:begin: generated from test/data/ruleset by `corepack pnpm registry`, do not edit -->';
const END = '<!-- registry:end -->';
const SEVERITIES = ['critical', 'warning', 'info'] as const;

const rows = (locked: string) =>
  Object.entries(loadRuleset().checks).map(([id, check]) => [
    `\`${id}\``,
    ...SEVERITIES.map((severity) => {
      const names = Object.entries(check.variants)
        .filter(([, v]) => v.severity === severity)
        .map(([name, v]) => `\`${name}\`${v.locked ? ` (${locked})` : ''}`);
      return names.length > 0 ? names.join(', ') : '—';
    }),
  ]);

function table(header: string[], body: string[][]): string {
  const all = [header, ...body];
  const widths = header.map((_, col) => Math.max(...all.map((row) => row[col]!.length)));
  const line = (row: string[]) => `| ${row.map((cell, col) => cell.padEnd(widths[col]!)).join(' | ')} |`;
  const separator = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [line(header), separator, ...body.map(line)].join('\n');
}

let failed = false;
for (const { name, locked } of docs) {
  const doc = fileURLToPath(new URL(`../${name}`, import.meta.url));
  const rendered = table(['ID', '`critical`', '`warning`', '`info`'], rows(locked));
  const current = readFileSync(doc, 'utf8');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) {
    console.error(`${name}: registry markers not found`);
    failed = true;
    continue;
  }
  const next = `${current.slice(0, start + BEGIN.length)}\n${rendered}\n${current.slice(end)}`;
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error(`The variant table in ${name} is out of date: run corepack pnpm registry`);
      failed = true;
    }
  } else {
    writeFileSync(doc, next);
    console.log(`wrote ${doc}`);
  }
}
if (failed) process.exitCode = 1;
else if (process.argv.includes('--check')) console.log('registry tables up to date');
