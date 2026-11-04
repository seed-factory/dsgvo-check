/**
 * Completeness: every registered check and variant has a ruleset entry (severity and crm code or explicit null), de + en
 * texts, a legal note and violation/clean/inconclusive|error fixtures; every fixture declares `$expect` and is executed.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allChecks } from '../../../../src/checks/index.ts';
import { loadRuleset, loadTexts, type Texts } from '../../../../src/core/data/load.ts';
import { defineCheck } from '../../../../src/core/evaluation/check.ts';
import { CheckRegistry } from '../../../../src/core/evaluation/registry.ts';
import { completenessProblems, variantsWithoutFixture } from '../../../utils/completeness.ts';
import { REPO_ROOT } from '../../../utils/snapshot-builder.ts';

const data = () => ({
  ruleset: loadRuleset(),
  texts: { de: loadTexts('de'), en: loadTexts('en') },
});

describe('registry completeness', () => {
  it('the registry is valid (unique, well-formed ids and variants)', () => {
    const registry = new CheckRegistry(allChecks);
    expect(registry.ids()).toHaveLength(allChecks.length);
  });

  it('every check/variant has ruleset, texts de+en, legal note and passing fixtures', () => {
    expect(completenessProblems(new CheckRegistry(allChecks).all(), data())).toEqual([]);
  });

  it('the variant table in README.md is generated from the current ruleset', () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/emit-registry.ts'), '--check'], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});

/**
 * Variants that no fixture expects because the prototype cannot produce them (CONSENT-02 `cmp-cookie-with-uid` needs a
 * value-reading collector, CONSENT-05 `connect-only-after-reject` an egress proxy). The list may only shrink.
 */
const KNOWN_VARIANTS_WITHOUT_FIXTURE = [
  'CONSENT-02.cmp-cookie-with-uid',
  'CONSENT-05.connect-only-after-reject',
];

describe('variants without a fixture', () => {
  it('only the known list; it may only shrink', () => {
    expect(variantsWithoutFixture(new CheckRegistry(allChecks).all())).toEqual(
      KNOWN_VARIANTS_WITHOUT_FIXTURE,
    );
  });
});

describe('completeness rules (self-test)', () => {
  const fake = defineCheck({
    id: 'FAKE-01',
    module: 'dns',
    requires: ['dns'],
    variants: [{ variant: 'missing' }, { variant: 'weak' }],
    run: () => [],
  });
  const texts = (lang: 'de' | 'en', body: string): Texts => ({
    lang,
    messages: { 'FAKE-01.missing': { title: 'T', body, draft: true } },
    legalNotes: {},
    ui: {},
    actions: { 'FAKE-01.missing': 'Do it.', 'GHOST-01.x': 'Do it.' },
  });

  it('reports every gap', () => {
    const problems = completenessProblems([fake], {
      ruleset: {
        profile: { id: 'de-2026', version: 't', rechtsstand: 't', draft: true },
        checks: {
          'FAKE-01': {
            gating: true,
            variants: {
              missing: { severity: 'critical', crm: 'T3_OTHER' },
              extra: { severity: 'info', crm: null },
            },
          },
          'GHOST-01': { gating: true, variants: {} },
        },
      },
      texts: { de: texts('de', 'Wert {a}'), en: texts('en', 'Value {b}') },
      fixtures: () => ['violation.json'],
      runFixtures: false,
    });
    expect(problems).toEqual([
      'ruleset: unregistered check GHOST-01',
      'texts/de: unregistered check in action GHOST-01.x',
      'texts/en: unregistered check in action GHOST-01.x',
      'FAKE-01.weak: no ruleset severity',
      'FAKE-01.missing: T3 code T3_OTHER with severity critical',
      'FAKE-01.extra: ruleset variant not declared by the check',
      'FAKE-01: no legalNote in test/data/texts/de/dns.yaml',
      'FAKE-01: no legalNote in test/data/texts/en/dns.yaml',
      'FAKE-01.missing: de/en use different params (a vs b)',
      'FAKE-01.weak: no de text (test/data/texts/de/dns.yaml)',
      'FAKE-01.weak: no en text (test/data/texts/en/dns.yaml)',
      'FAKE-01.weak: no de action text (test/data/texts/de/<module>.yaml, section actions)',
      'FAKE-01.weak: no en action text (test/data/texts/en/<module>.yaml, section actions)',
      'FAKE-01: no test/unit/checks/dns/fixtures.ts FAKE-01/clean*.json',
      'FAKE-01: no test/unit/checks/dns/fixtures.ts FAKE-01/inconclusive*.json or error*.json',
    ]);
  });
});
