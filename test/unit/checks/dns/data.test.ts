/**
 * Ruleset table for MAIL-* (tested separately, D23), the D19 rule "T3 codes not above warning", and rendering of
 * every emitted observation in de and en without unresolved placeholders.
 */
import { describe, expect, it } from 'vitest';
import { dnsChecks } from '../../../../src/checks/dns/index.ts';
import { loadCrm, loadRuleset, loadTexts } from '../../../../src/core/data.ts';
import { renderMessage } from '../../../../src/core/messages.ts';
import { loadFixtures, observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, type ZoneSpec } from './zone.ts';

const ruleset = loadRuleset();
const crm = loadCrm();

describe('ruleset de-2026 for MAIL-*', () => {
  it('matches the registry (docs/03-checks.md §2.1) and the consensus table (§4, D19)', () => {
    const table = Object.fromEntries(
      ['MAIL-01', 'MAIL-02'].map((id) => [
        id,
        Object.fromEntries(
          Object.entries(ruleset.checks[id]?.variants ?? {}).map(([v, e]) => [v, e.severity]),
        ),
      ]),
    );
    expect(table).toEqual({
      'MAIL-01': {
        'record-not-found': 'warning',
        'policy-none': 'warning',
        'record-invalid': 'warning',
        'weak-option': 'info',
        'legacy-pct': 'info',
      },
      'MAIL-02': {
        'record-not-found': 'warning',
        'permissive-qualifier': 'warning',
        'record-invalid': 'warning',
        'softfail-without-enforcement': 'warning',
        'softfail-with-enforcement': 'info',
        'ptr-mechanism': 'info',
      },
    });
    expect(ruleset.checks['MAIL-01']?.gating).toBe(true);
    expect(ruleset.checks['MAIL-02']?.gating).toBe(true);
  });

  it('T3 codes are never critical (D19)', () => {
    for (const check of dnsChecks) {
      for (const { variant } of check.variants) {
        const code = crm[`${check.id}.${variant}`];
        if (code?.startsWith('T3_')) {
          expect(ruleset.checks[check.id]?.variants[variant]?.severity, `${check.id}.${variant}`).not.toBe(
            'critical',
          );
        }
      }
    }
  });
});

/** Extra scenarios so that every declared variant is rendered at least once. */
const base: ZoneSpec = { 'MX example.de': ['10 mx.example.de'], 'TXT _dmarc.www.example.de': 'NXDOMAIN' };
const SCENARIOS: ZoneSpec[] = [
  {
    ...base,
    'TXT _dmarc.example.de': ['v=DMARC1; p=reject; t=y; pct=50; sp=none'],
    'TXT example.de': ['v=spf1 ptr'],
  },
  { ...base, 'TXT _dmarc.example.de': ['v=DMARC1; p=reject'], 'TXT example.de': ['v=spf1 ?all'] },
  {
    ...base,
    'MX example.de': ['0 .'],
    'TXT _dmarc.example.de': ['v=DMARC1; p=quarantine'],
    'TXT example.de': ['v=spf1 ~all'],
  },
  {
    ...base,
    'MX example.de': ['0 .'],
    'TXT _dmarc.example.de': ['v=DMARC1; p=bogus'],
    'TXT example.de': ['v=spf1'],
  },
];

describe('texts render for every emitted observation', () => {
  const fromFixtures = dnsChecks.flatMap((check) =>
    loadFixtures(check.module, check.id).map((fx) => runCheck(check, fx.snapshot)),
  );
  const fromScenarios = SCENARIOS.flatMap((spec) => dnsChecks.map((c) => runCheck(c, dnsSnapshot(spec))));
  const observations = [...fromFixtures, ...fromScenarios].flatMap((r) =>
    r.outcome ? observationsOf(r) : [],
  );

  it('every declared variant is emitted by a fixture or a scenario', () => {
    const emitted = new Set(observations.map((o) => `${o.checkId}.${o.variant}`));
    const declared = dnsChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
    expect(declared.filter((k) => !emitted.has(k))).toEqual([]);
  });

  it.each(['de', 'en'] as const)('%s: no unresolved {param} and no missing text', (lang) => {
    const texts = loadTexts(lang);
    for (const o of observations) {
      const m = renderMessage(texts, `${o.checkId}.${o.variant}`, o.params);
      expect(`${m.title} ${m.body}`, `${o.checkId}.${o.variant}`).not.toMatch(
        /[{}]|\[missing text|undefined/,
      );
    }
  });
});
