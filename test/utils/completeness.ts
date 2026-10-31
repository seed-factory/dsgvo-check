/**
 * Registry completeness rules (D05, BRIEF "Тесты обязательны") as a function returning human-readable problems,
 * so the L0 test shows every gap at once and the rules themselves are unit-tested.
 */
import type { AnyCheck } from '../../src/core/check.ts';
import type { CrmMapping, Ruleset, Texts } from '../../src/core/data.ts';
import { MessageSyntaxError, templateParams, validateTemplate } from '../../src/core/messages.ts';
import { fixtureFiles, loadFixtures, runCheck, variantsOf } from './snapshot-builder.ts';

export interface CompletenessData {
  ruleset: Ruleset;
  crm: CrmMapping;
  texts: { de: Texts; en: Texts };
  /** Override fixture lookup (tests); default reads test/fixtures/snapshots/<module>/<id>/. */
  fixtures?: (check: AnyCheck) => string[];
  /** Skip running fixtures (self-test of the rules). */
  runFixtures?: boolean;
}

function params(t: Texts, key: string): string[] | null {
  const m = t.messages[key];
  if (!m) return null;
  return [...new Set([...templateParams(m.title), ...templateParams(m.body)])].sort();
}

export function completenessProblems(checks: readonly AnyCheck[], d: CompletenessData): string[] {
  const problems: string[] = [];
  const known = new Set(checks.map((c) => c.id));

  for (const id of Object.keys(d.ruleset.checks))
    if (!known.has(id)) problems.push(`ruleset: unregistered check ${id}`);
  for (const key of Object.keys(d.crm)) {
    if (!known.has(key.split('.')[0] as string)) problems.push(`crm: unregistered check in ${key}`);
  }
  for (const lang of ['de', 'en'] as const) {
    for (const key of Object.keys(d.texts[lang].messages)) {
      if (key.startsWith('diagnostic.')) continue;
      if (!known.has(key.split('.')[0] as string))
        problems.push(`texts/${lang}: unregistered check in ${key}`);
    }
  }

  for (const check of checks) {
    const id = check.id;
    const entry = d.ruleset.checks[id];
    const declared = check.variants.map((v) => v.variant);
    if (!entry) problems.push(`${id}: no ruleset entry (data/ruleset/de-2026/${check.module}.yaml)`);
    else {
      for (const v of declared) if (!entry.variants[v]) problems.push(`${id}.${v}: no ruleset severity`);
      for (const v of Object.keys(entry.variants)) {
        if (!declared.includes(v)) problems.push(`${id}.${v}: ruleset variant not declared by the check`);
      }
    }
    for (const lang of ['de', 'en'] as const) {
      if (!d.texts[lang].legalNotes[id])
        problems.push(`${id}: no legalNote in data/texts/${lang}/${check.module}.yaml`);
    }
    for (const v of declared) {
      const key = `${id}.${v}`;
      for (const lang of ['de', 'en'] as const) {
        const m = d.texts[lang].messages[key];
        if (!m) {
          problems.push(`${key}: no ${lang} text (data/texts/${lang}/${check.module}.yaml)`);
          continue;
        }
        for (const part of [m.title, m.body]) {
          try {
            validateTemplate(part);
          } catch (err) {
            if (err instanceof MessageSyntaxError)
              problems.push(`${key}: ${lang} template error: ${err.message}`);
          }
        }
      }
      const pde = params(d.texts.de, key);
      const pen = params(d.texts.en, key);
      if (pde && pen && pde.join(',') !== pen.join(',')) {
        problems.push(`${key}: de/en use different params (${pde.join(',')} vs ${pen.join(',')})`);
      }
      if (!Object.hasOwn(d.crm, key)) problems.push(`${key}: no crm mapping (string or explicit null)`);
    }

    const files = d.fixtures ? d.fixtures(check) : fixtureFiles(check.module, id);
    const dir = `test/fixtures/snapshots/${check.module}/${id}/`;
    if (!files.some((f) => f.startsWith('violation'))) problems.push(`${id}: no ${dir}violation*.json`);
    if (!files.some((f) => f.startsWith('clean'))) problems.push(`${id}: no ${dir}clean*.json`);
    if (!files.some((f) => f.startsWith('inconclusive') || f.startsWith('error'))) {
      problems.push(`${id}: no ${dir}inconclusive*.json or error*.json`);
    }

    if (d.runFixtures === false) continue;
    for (const fx of loadFixtures(check.module, id)) {
      if (!fx.expect) {
        problems.push(`${id}/${fx.name}: missing $expect`);
        continue;
      }
      const result = runCheck(check, fx.snapshot);
      const got = variantsOf(result);
      const want = [...(fx.expect.variants ?? [])].sort();
      if (result.status !== fx.expect.status) {
        problems.push(
          `${id}/${fx.name}: status ${result.status} (${result.reason ?? ''}) ≠ expected ${fx.expect.status}`,
        );
      }
      if (got.join(',') !== want.join(','))
        problems.push(`${id}/${fx.name}: variants [${got}] ≠ expected [${want}]`);
      if (fx.expect.reason && result.reason !== fx.expect.reason) {
        problems.push(`${id}/${fx.name}: reason ${result.reason} ≠ expected ${fx.expect.reason}`);
      }
      if (fx.kind === 'violation' && got.length === 0)
        problems.push(`${id}/${fx.name}: violation fixture emits nothing`);
    }
  }
  return problems;
}

/**
 * Declared variants that no fixture expects (`$expect.variants`), as `checkId.variant` (FT-08 suggestion). Fixtures
 * per ID stay the rule of the BRIEF (S-38 rejected a per-variant rule); this list only makes the gaps visible, so a
 * new variant without any fixture is a deliberate decision.
 */
export function variantsWithoutFixture(checks: readonly AnyCheck[]): string[] {
  const out: string[] = [];
  for (const check of checks) {
    const seen = new Set(loadFixtures(check.module, check.id).flatMap((f) => f.expect?.variants ?? []));
    for (const v of check.variants) if (!seen.has(v.variant)) out.push(`${check.id}.${v.variant}`);
  }
  return out.sort();
}
