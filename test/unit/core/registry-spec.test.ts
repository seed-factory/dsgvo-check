/**
 * L0 (FT-09): the canonical variant registry `docs/03-checks.md` §2.1 against the prototype's ruleset, check
 * declarations, texts (de, en) and crm mapping. The internal completeness test only compares the data with itself;
 * this one fails when a `checkId.variant`, its default severity or its `locked` mark drifts from the spec.
 * Scope: the checks of the prototype (BRIEF: 14 P0 without PRIV-02, plus CONSENT-05).
 */
import { describe, expect, it } from 'vitest';
import { allChecks } from '../../../src/checks/index.ts';
import { loadCrm, loadRuleset, loadTexts } from '../../../src/core/data.ts';
import { loadSpecRegistry, parseSpecRegistry, type SpecVariant } from '../../utils/spec-registry.ts';

/** docs/prototype/BRIEF.md "Объём". */
const PROTOTYPE_IDS = [
  'CONSENT-01',
  'CONSENT-02',
  'CONSENT-03',
  'CONSENT-04',
  'CONSENT-05',
  'EMBED-01',
  'EMBED-02',
  'HDR-01',
  'LEGAL-01',
  'MAIL-01',
  'MAIL-02',
  'PRIV-01',
  'TLS-01',
  'TLS-02',
  'TRACK-01',
] as const;

/**
 * Deliberate differences of the prototype, each with its reason. Keys are `checkId.variant`; an entry that no longer
 * differs fails the test, so the list cannot go stale.
 */
const ALLOWED_DIFFERENCES: Readonly<Record<string, string>> = {};

const key = (v: Pick<SpecVariant, 'checkId' | 'variant'>) => `${v.checkId}.${v.variant}`;

describe('variant registry docs/03-checks.md §2.1 = prototype data (FT-09)', () => {
  const spec = loadSpecRegistry().filter((v) => (PROTOTYPE_IDS as readonly string[]).includes(v.checkId));
  const ruleset = loadRuleset();
  const crm = loadCrm();
  const texts = { de: loadTexts('de'), en: loadTexts('en') };

  it('the registry implements exactly the checks of the prototype', () => {
    expect(allChecks.map((c) => c.id).sort()).toEqual([...PROTOTYPE_IDS]);
    expect([...new Set(spec.map((v) => v.checkId))].sort()).toEqual([...PROTOTYPE_IDS]);
  });

  it('every spec variant exists with the same severity and locked mark; nothing else is declared', () => {
    const problems: string[] = [];
    const specKeys = new Set(spec.map(key));
    for (const v of spec) {
      const entry = ruleset.checks[v.checkId]?.variants[v.variant];
      const check = allChecks.find((c) => c.id === v.checkId);
      if (!entry) problems.push(`${key(v)}: missing in ruleset`);
      else {
        if (entry.severity !== v.severity)
          problems.push(`${key(v)}: ruleset ${entry.severity}, spec ${v.severity}`);
        if ((entry.locked ?? false) !== v.locked)
          problems.push(`${key(v)}: ruleset locked=${entry.locked ?? false}, spec locked=${v.locked}`);
      }
      if (!check?.variants.some((d) => d.variant === v.variant))
        problems.push(`${key(v)}: not declared by the check`);
      for (const lang of ['de', 'en'] as const)
        if (!texts[lang].messages[key(v)]) problems.push(`${key(v)}: no ${lang} text`);
      if (!(key(v) in crm)) problems.push(`${key(v)}: no crm mapping`);
    }
    for (const id of PROTOTYPE_IDS) {
      for (const variant of Object.keys(ruleset.checks[id]?.variants ?? {}))
        if (!specKeys.has(`${id}.${variant}`)) problems.push(`${id}.${variant}: not in §2.1 (ruleset)`);
      for (const d of allChecks.find((c) => c.id === id)?.variants ?? [])
        if (!specKeys.has(`${id}.${d.variant}`)) problems.push(`${id}.${d.variant}: not in §2.1 (check)`);
    }
    const unexplained = problems.filter((p) => !((p.split(':')[0] as string) in ALLOWED_DIFFERENCES));
    expect(unexplained).toEqual([]);
    const stale = Object.keys(ALLOWED_DIFFERENCES).filter(
      (k) => !problems.some((p) => p.startsWith(`${k}:`)),
    );
    expect(stale).toEqual([]);
  });
});

describe('§2.1 parser (self-test)', () => {
  const md = [
    '## 2. Реестр',
    '### 2.1. Реестр вариантов',
    '| ID | `critical` | `warning` | `info` | Не варианты |',
    '|---|---|---|---|---|',
    '| `AB-01` | `x-y` | — | `z`, `w`² | `reason-only` |',
    '| `CD-01`, `CD-02`³ | — | `v` | — | — |',
    '## 3. Дальше',
    '| `EF-01` | `not-parsed` | — | — | — |',
  ].join('\n');

  it('reads severities, locked marks and shared rows; ignores the reason column and later sections', () => {
    expect(parseSpecRegistry(md)).toEqual([
      { checkId: 'AB-01', variant: 'x-y', severity: 'critical', locked: false },
      { checkId: 'AB-01', variant: 'z', severity: 'info', locked: false },
      { checkId: 'AB-01', variant: 'w', severity: 'info', locked: true },
      { checkId: 'CD-01', variant: 'v', severity: 'warning', locked: false },
      { checkId: 'CD-02', variant: 'v', severity: 'warning', locked: false },
    ]);
  });

  it('fails loudly when the section is gone', () => {
    expect(() => parseSpecRegistry('# nothing here')).toThrow(/2\.1/);
  });
});
