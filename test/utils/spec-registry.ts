/**
 * Parser for the canonical variant registry `docs/03-checks.md` §2.1 (AGENTS.md "реестр §2.1 — канон"):
 * every `checkId.variant` with its default severity and the `locked` mark (²). Used by the test that compares
 * the registry with ruleset, check declarations, texts and the crm mapping.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type SpecSeverity = 'critical' | 'warning' | 'info';

export interface SpecVariant {
  checkId: string;
  variant: string;
  severity: SpecSeverity;
  locked: boolean;
}

export const CHECKS_SPEC_PATH = fileURLToPath(new URL('../../docs/03-checks.md', import.meta.url));

const SEVERITY_COLUMNS: readonly SpecSeverity[] = ['critical', 'warning', 'info'];

/** Split a Markdown table row into trimmed cells (no escaped pipes in the registry). */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Variants of the §2.1 table. Throws when the section or the table is missing, so a moved heading fails loudly
 * instead of comparing against an empty registry.
 */
export function parseSpecRegistry(markdown: string): SpecVariant[] {
  const start = markdown.search(/^### 2\.1\.[^\n]*$/m);
  if (start < 0) throw new Error('docs/03-checks.md: section "### 2.1." not found');
  const rest = markdown.slice(start);
  const bodyStart = rest.indexOf('\n') + 1;
  const next = bodyStart > 0 ? rest.slice(bodyStart).search(/^#{1,3} /m) : -1;
  const section = next < 0 ? rest : rest.slice(0, bodyStart + next);
  const rows = section.split('\n').filter((l) => /^\|\s*`[A-Z]+-\d{2}`/.test(l));
  if (rows.length === 0) throw new Error('docs/03-checks.md §2.1: no registry rows');
  const out: SpecVariant[] = [];
  for (const row of rows) {
    const [idCell = '', ...rest] = cells(row);
    const ids = [...idCell.matchAll(/`([A-Z]+-\d{2})`/g)].map((m) => m[1] as string);
    SEVERITY_COLUMNS.forEach((severity, i) => {
      const cell = rest[i] ?? '';
      for (const m of cell.matchAll(/`([a-z0-9-]+)`(²)?/g)) {
        for (const checkId of ids) out.push({ checkId, variant: m[1] as string, severity, locked: !!m[2] });
      }
    });
  }
  return out;
}

export function loadSpecRegistry(path = CHECKS_SPEC_PATH): SpecVariant[] {
  return parseSpecRegistry(readFileSync(path, 'utf8'));
}
