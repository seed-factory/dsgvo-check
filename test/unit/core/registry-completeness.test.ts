/**
 * L0 completeness (D05): every registered check and every variant has a ruleset entry, de + en texts,
 * a crm mapping (string or explicit null), a legal note, and violation/clean/inconclusive|error fixtures.
 * Every fixture must declare `$expect` and is executed. Green on an empty registry.
 */
import { describe, expect, it } from 'vitest';
import { allChecks } from '../../../src/checks/index.ts';
import { defineCheck } from '../../../src/core/check.ts';
import { loadCrm, loadRuleset, loadTexts, type Texts } from '../../../src/core/data.ts';
import { CheckRegistry } from '../../../src/core/registry.ts';
import { completenessProblems, variantsWithoutFixture } from '../../utils/completeness.ts';

const data = () => ({
  ruleset: loadRuleset(),
  crm: loadCrm(),
  texts: { de: loadTexts('de'), en: loadTexts('en') },
});

describe('registry completeness', () => {
  it('the registry is valid (unique, well-formed ids and variants)', () => {
    const registry = new CheckRegistry(allChecks);
    expect(registry.ids()).toHaveLength(allChecks.length);
  });

  it('every check/variant has ruleset, texts de+en, legal note, crm mapping and passing fixtures', () => {
    expect(completenessProblems(new CheckRegistry(allChecks).all(), data())).toEqual([]);
  });
});

/**
 * Variants that no fixture expects (FT-08): most are covered by targeted L1 tests in test/unit/checks/**, the rest
 * cannot occur in the prototype (CONSENT-05 `connect-only-after-reject` needs the egress proxy). The list may only
 * shrink: a new variant without a fixture, or a stale entry after a fixture was added, fails the test.
 */
const KNOWN_VARIANTS_WITHOUT_FIXTURE = [
  'CONSENT-01.cookieless-ping',
  'CONSENT-01.first-party-proxy',
  'CONSENT-01.library-loaded',
  'CONSENT-01.request-not-completed',
  'CONSENT-01.third-party-resource',
  'CONSENT-01.unknown-host',
  'CONSENT-02.cmp-cookie-with-uid',
  'CONSENT-02.storage-rejected-or-attempted',
  'CONSENT-02.unknown-first-party-persistent',
  'CONSENT-02.unknown-third-party-persistent',
  'CONSENT-03.no-banner-consent-services',
  'CONSENT-04.blocking-no-reject',
  'CONSENT-04.close-means-accept',
  'CONSENT-04.cmp-not-supported',
  'CONSENT-04.no-choice-at-first-layer',
  'CONSENT-04.nonblocking-no-reject',
  'CONSENT-04.pur-abo',
  'CONSENT-04.reject-as-link',
  'CONSENT-04.reject-ineffective',
  'CONSENT-04.reject-not-actionable',
  'CONSENT-05.connect-only-after-reject',
  'CONSENT-05.cookieless-ping-after-reject',
  'EMBED-01.preconnect-only',
  'LEGAL-01.footer-covered-by-banner',
  'LEGAL-01.link-missing-on-some-pages',
  'LEGAL-01.links-broken',
  'LEGAL-01.reachable-via-intermediate',
  'LEGAL-01.unresolved',
  'MAIL-01.legacy-pct',
  'MAIL-02.ptr-mechanism',
  'PRIV-01.ambiguous-match',
  'PRIV-01.category-only',
];

describe('variants without a fixture (FT-08)', () => {
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
  });

  it('reports every gap', () => {
    const problems = completenessProblems([fake], {
      ruleset: {
        profile: { id: 'de-2026', version: 't', rechtsstand: 't', draft: true },
        checks: {
          'FAKE-01': {
            gating: true,
            variants: { missing: { severity: 'warning' }, extra: { severity: 'info' } },
          },
          'GHOST-01': { gating: true, variants: {} },
        },
      },
      crm: { 'FAKE-01.missing': null },
      texts: { de: texts('de', 'Wert {a}'), en: texts('en', 'Value {b}') },
      fixtures: () => ['violation.json'],
      runFixtures: false,
    });
    expect(problems).toEqual([
      'ruleset: unregistered check GHOST-01',
      'FAKE-01.weak: no ruleset severity',
      'FAKE-01.extra: ruleset variant not declared by the check',
      'FAKE-01: no legalNote in data/texts/de/dns.yaml',
      'FAKE-01: no legalNote in data/texts/en/dns.yaml',
      'FAKE-01.missing: de/en use different params (a vs b)',
      'FAKE-01.weak: no de text (data/texts/de/dns.yaml)',
      'FAKE-01.weak: no en text (data/texts/en/dns.yaml)',
      'FAKE-01.weak: no crm mapping (string or explicit null)',
      'FAKE-01: no test/fixtures/snapshots/dns/FAKE-01/clean*.json',
      'FAKE-01: no test/fixtures/snapshots/dns/FAKE-01/inconclusive*.json or error*.json',
    ]);
  });
});
