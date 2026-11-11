/**
 * Registry completeness rules as a function returning human-readable problems: the test shows every gap at once and
 * the rules themselves are unit-tested.
 */

import type { Ruleset, Texts } from '../../src/core/data/load.ts';
import {
  formatMessage,
  MessageSyntaxError,
  templateParams,
  validateTemplate,
} from '../../src/core/data/messages.ts';
import type { AnyCheck } from '../../src/core/evaluation/check.ts';
import {
  SCENARIOS,
  scenarioFixture,
  scenariosOf,
  VARIANT_SCENARIOS,
} from '../unit/checks/browser/scenarios/index.ts';
import { DNS_FIXTURES, dnsFixture } from '../unit/checks/dns/fixtures.ts';
import { findFixtureLeaks } from './fixture-redaction.ts';
import { fixtureFrom, loadFixtures, runCheck, type SnapshotFixture, variantsOf } from './snapshot-builder.ts';

/** Fixtures of a check: browser and dns ones are built from TS tables, the http ones are JSON files. */
function checkFixtures(check: AnyCheck, problems?: string[]): SnapshotFixture[] {
  if (check.module === 'dns') {
    return (DNS_FIXTURES[check.id] ?? []).map((f) =>
      fixtureFrom(f.file, dnsFixture(f), `test/unit/checks/dns/fixtures.ts (${check.id}/${f.file})`),
    );
  }
  if (check.module !== 'browser') return loadFixtures(check.module, check.id);

  return scenariosOf(check.id).map((s) => {
    const raw = scenarioFixture(s);
    if (problems) {
      for (const leak of findFixtureLeaks(raw)) problems.push(`${check.id}/${s.file}: ${leak}`);
    }
    return fixtureFrom(
      s.file,
      raw,
      `test/unit/checks/browser/scenarios/${check.id.toLowerCase()}.ts (${check.id}/${s.file})`,
    );
  });
}

export interface CompletenessData {
  ruleset: Ruleset;
  texts: { de: Texts; en: Texts };
  /** Override fixture names (tests); default: `checkFixtures`. */
  fixtures?: (check: AnyCheck) => string[];
  /** Skip running fixtures (self-test of the rules). */
  runFixtures?: boolean;
}

function params(t: Texts, key: string): string[] | null {
  const m = t.messages[key];
  if (!m) return null;
  return [...new Set([...templateParams(m.title), ...templateParams(m.body)])].sort();
}

const LANGS = ['de', 'en'] as const;

/** Ruleset entries and message keys that name a check which is not registered. */
function unregisteredChecks(known: ReadonlySet<string>, d: CompletenessData): string[] {
  const problems: string[] = [];

  for (const id of Object.keys(d.ruleset.checks))
    if (!known.has(id)) problems.push(`ruleset: unregistered check ${id}`);

  for (const lang of LANGS) {
    for (const key of Object.keys(d.texts[lang].messages)) {
      if (key.startsWith('diagnostic.')) continue;
      if (!known.has(key.split('.')[0] as string))
        problems.push(`texts/${lang}: unregistered check in ${key}`);
    }
    for (const key of Object.keys(d.texts[lang].actions)) {
      if (!known.has(key.split('.')[0] as string))
        problems.push(`texts/${lang}: unregistered check in action ${key}`);
    }
  }
  return problems;
}

/** The check and its ruleset entry declare the same variants. */
function rulesetProblems(check: AnyCheck, d: CompletenessData): string[] {
  const id = check.id;
  const entry = d.ruleset.checks[id];
  const declared = check.variants.map((v) => v.variant);
  if (!entry) return [`${id}: no ruleset entry (test/data/ruleset/de-2026/${check.module}.yaml)`];

  const problems: string[] = [];
  for (const v of declared) if (!entry.variants[v]) problems.push(`${id}.${v}: no ruleset severity`);
  for (const [v, rule] of Object.entries(entry.variants)) {
    if (!declared.includes(v)) problems.push(`${id}.${v}: ruleset variant not declared by the check`);
    // Ruleset rule: a T3 catalog code stays at most `warning`.
    if (rule.crm?.startsWith('T3_') && rule.severity === 'critical')
      problems.push(`${id}.${v}: T3 code ${rule.crm} with severity critical`);
  }
  return problems;
}

/** Legal note and message texts in both languages: present, well-formed templates, the same parameters in de and en. */
function textProblems(check: AnyCheck, d: CompletenessData): string[] {
  const problems: string[] = [];
  const id = check.id;

  for (const lang of LANGS) {
    if (!d.texts[lang].legalNotes[id])
      problems.push(`${id}: no legalNote in test/data/texts/${lang}/${check.module}.yaml`);
  }

  for (const { variant } of check.variants) {
    const key = `${id}.${variant}`;
    for (const lang of LANGS) {
      const m = d.texts[lang].messages[key];
      if (!m) {
        problems.push(`${key}: no ${lang} text (test/data/texts/${lang}/${check.module}.yaml)`);
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

    for (const lang of LANGS) {
      if (!d.texts[lang].actions[key])
        problems.push(
          `${key}: no ${lang} action text (test/data/texts/${lang}/<module>.yaml, section actions)`,
        );
    }

    const pde = params(d.texts.de, key);
    const pen = params(d.texts.en, key);
    if (pde && pen && pde.join(',') !== pen.join(',')) {
      problems.push(`${key}: de/en use different params (${pde.join(',')} vs ${pen.join(',')})`);
    }
  }
  return problems;
}

/** Every check has a violation, a clean and an inconclusive (or error) fixture. */
function fixtureCoverageProblems(check: AnyCheck, files: readonly string[]): string[] {
  const id = check.id;
  const dir =
    {
      browser: `test/unit/checks/browser/scenarios/${id.toLowerCase()}.ts ${id}/`,
      dns: `test/unit/checks/dns/fixtures.ts ${id}/`,
    }[check.module as string] ?? `test/fixtures/snapshots/${check.module}/${id}/`;
  const problems: string[] = [];

  if (!files.some((f) => f.startsWith('violation'))) problems.push(`${id}: no ${dir}violation*.json`);
  if (!files.some((f) => f.startsWith('clean'))) problems.push(`${id}: no ${dir}clean*.json`);
  if (!files.some((f) => f.startsWith('inconclusive') || f.startsWith('error'))) {
    problems.push(`${id}: no ${dir}inconclusive*.json or error*.json`);
  }
  return problems;
}

const UNFORMATTED = /\{[A-Za-z]\w*\}|[{}]|\[missing text|undefined/;

/**
 * Title, body and action of every observation format with its own params. The action is formatted like the finding
 * texts, and the front page aggregates the same params, so a name only the text knows would stay visible there.
 */
function textParamProblems(
  check: AnyCheck,
  fixture: string,
  result: ReturnType<typeof runCheck>,
  texts: CompletenessData['texts'],
): string[] {
  const problems = new Set<string>();
  for (const o of result.outcome?.observations ?? []) {
    const key = `${check.id}.${o.variant}`;
    for (const lang of LANGS) {
      const m = texts[lang].messages[key];
      const parts = { title: m?.title, body: m?.body, action: texts[lang].actions[key] };
      for (const [part, template] of Object.entries(parts)) {
        if (template === undefined) continue;
        const rendered = formatMessage(template, o.params, lang);
        const prefix = `${check.id}/${fixture}: ${lang} ${part} of ${key}`;
        const left = UNFORMATTED.exec(rendered);
        if (left) problems.add(`${prefix} leaves ${left[0]} unformatted`);
        if (part === 'action' && (rendered === '' || rendered.startsWith(' '))) {
          problems.add(`${prefix} is blank or starts with a space`);
        }
      }
    }
  }
  return [...problems];
}

/** Runs each fixture through the check and compares status, variants and reason with its `$expect` block. */
function fixtureRunProblems(
  check: AnyCheck,
  fixtures: readonly SnapshotFixture[],
  texts: CompletenessData['texts'],
): string[] {
  const problems: string[] = [];
  const id = check.id;

  for (const fx of fixtures) {
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
    problems.push(...textParamProblems(check, fx.name, result, texts));
  }
  return problems;
}

export function completenessProblems(checks: readonly AnyCheck[], d: CompletenessData): string[] {
  const problems = unregisteredChecks(new Set(checks.map((c) => c.id)), d);
  if (d.runFixtures !== false) {
    const browserIds = new Set(checks.filter((check) => check.module === 'browser').map((check) => check.id));
    for (const id of Object.keys({ ...SCENARIOS, ...VARIANT_SCENARIOS })) {
      if (!browserIds.has(id)) problems.push(`browser fixtures: unregistered check ${id}`);
    }
  }

  for (const check of checks) {
    problems.push(...rulesetProblems(check, d), ...textProblems(check, d));

    const fixtures = d.runFixtures === false ? [] : checkFixtures(check, problems);
    const files = d.fixtures ? d.fixtures(check) : fixtures.map((f) => f.name);
    problems.push(...fixtureCoverageProblems(check, files));

    if (d.runFixtures === false) continue;
    problems.push(...fixtureRunProblems(check, fixtures, d.texts));
  }
  return problems;
}

/** Lists declared variants without a snapshot fixture so gaps remain visible under the fixture rule. */
export function variantsWithoutFixture(checks: readonly AnyCheck[]): string[] {
  const out: string[] = [];
  for (const check of checks) {
    const seen = new Set(checkFixtures(check).flatMap((f) => f.expect?.variants ?? []));
    for (const v of check.variants) if (!seen.has(v.variant)) out.push(`${check.id}.${v.variant}`);
  }
  return out.sort();
}
