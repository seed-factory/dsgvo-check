/**
 * the browser checks, ruleset, texts (de/en) and CRM mapping use exactly the variants of the approved
 * registry docs/03-checks.md §2.1 ("Реестр вариантов и messageId") with its default severities. The registry is
 * parsed from the document itself, independently of the data files, so a rename on either side fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { loadCrm, loadRuleset, loadTexts } from '../../../../src/core/data.ts';

type Severity = 'critical' | 'warning' | 'info';
const COLUMNS: readonly Severity[] = ['critical', 'warning', 'info'];

/** `ID → variant → severity` from the §2.1 table (footnote marks such as ² are dropped). */
function parseRegistry(markdown: string): Map<string, Map<string, Severity>> {
  const start = markdown.indexOf('### 2.1.');
  const end = markdown.indexOf('\n## ', start);
  if (start < 0 || end < 0) throw new Error('§2.1 not found in docs/03-checks.md');
  const out = new Map<string, Map<string, Severity>>();
  for (const line of markdown.slice(start, end).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const ids = [...(cells[1] ?? '').matchAll(/`([A-Z]+-\d{2})`/g)].map((m) => m[1] as string);
    const variants = new Map<string, Severity>();
    COLUMNS.forEach((sev, i) => {
      for (const m of (cells[2 + i] ?? '').matchAll(/`([a-z0-9-]+)`/g)) variants.set(m[1] as string, sev);
    });
    for (const id of ids) out.set(id, variants);
  }
  return out;
}

const registry = parseRegistry(
  readFileSync(path.resolve(import.meta.dirname, '../../../../docs/03-checks.md'), 'utf8'),
);
const ruleset = loadRuleset();
const crm = loadCrm();
const texts = { de: loadTexts('de'), en: loadTexts('en') };
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('browser variants follow the registry 03-checks §2.1', () => {
  it('the registry parser sees the table', () => {
    expect(registry.get('CONSENT-04')?.get('banner-not-recognized')).toBe('info');
    expect(registry.get('VULN-02')?.get('version-listed')).toBe('warning');
  });

  it.each(browserChecks.map((c) => [c.id, c] as const))('%s', (id, check) => {
    const want = registry.get(id);
    expect(want, `${id} is not in the registry`).toBeDefined();
    const names = sorted(want?.keys() ?? []);
    expect(sorted(check.variants.map((v) => v.variant)), 'check variants').toEqual(names);
    const rules = ruleset.checks[id]?.variants ?? {};
    expect(sorted(Object.keys(rules)), 'ruleset variants').toEqual(names);
    for (const [v, sev] of want ?? []) expect(rules[v]?.severity, `${id}.${v} severity`).toBe(sev);
    const prefix = `${id}.`;
    expect(sorted(Object.keys(crm).filter((k) => k.startsWith(prefix))), 'crm keys').toEqual(
      names.map((v) => prefix + v),
    );
    for (const lang of ['de', 'en'] as const) {
      const keys = Object.keys(texts[lang].messages).filter((k) => k.startsWith(prefix));
      expect(sorted(keys), `texts ${lang}`).toEqual(names.map((v) => prefix + v));
    }
  });
});
