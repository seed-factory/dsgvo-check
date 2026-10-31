/**
 * Ruleset table for HDR-01 / TLS-01 / TLS-02 against the registry (docs/03-checks.md §2.1), the D19 rule "T3 codes
 * not above warning", and rendering of every emitted observation in de and en without unresolved placeholders.
 */
import { describe, expect, it } from 'vitest';
import { httpChecks } from '../../../../src/checks/http/index.ts';
import { loadCrm, loadRuleset, loadTexts } from '../../../../src/core/data.ts';
import { renderMessage } from '../../../../src/core/messages.ts';
import { loadFixtures, observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';

const ruleset = loadRuleset();
const crm = loadCrm();

describe('ruleset de-2026 for HDR-01 / TLS-01 / TLS-02', () => {
  it('matches the registry (docs/03-checks.md §2.1)', () => {
    const table = Object.fromEntries(
      ['HDR-01', 'TLS-01', 'TLS-02'].map((id) => [
        id,
        Object.fromEntries(
          Object.entries(ruleset.checks[id]?.variants ?? {}).map(([v, e]) => [v, e.severity]),
        ),
      ]),
    );
    expect(table).toEqual({
      'HDR-01': {
        'hsts-missing': 'warning',
        'anti-framing-missing': 'warning',
        'referrer-policy-permissive': 'warning',
        'header-missing': 'info',
      },
      'TLS-01': {
        'https-unavailable': 'critical',
        'form-on-http-page': 'critical',
        'no-redirect': 'warning',
        'client-side-redirect-only': 'warning',
        'redirect-chain-detail': 'info',
      },
      'TLS-02': {
        'certificate-invalid': 'critical',
        'chain-incomplete': 'warning',
        'certificate-expiring': 'warning',
        'certificate-expiry-approaching': 'info',
      },
    });
    for (const id of ['HDR-01', 'TLS-01', 'TLS-02']) expect(ruleset.checks[id]?.gating).toBe(true);
  });

  it('T3 codes are never critical (D19)', () => {
    for (const check of httpChecks) {
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

describe('texts render for every emitted observation', () => {
  const observations = httpChecks
    .flatMap((check) => loadFixtures(check.module, check.id).map((fx) => runCheck(check, fx.snapshot)))
    .flatMap((r) => (r.outcome ? observationsOf(r) : []));

  it('every declared variant is emitted by a fixture', () => {
    const emitted = new Set(observations.map((o) => `${o.checkId}.${o.variant}`));
    const declared = httpChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
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
