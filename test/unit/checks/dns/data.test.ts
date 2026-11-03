/** Rendering of every emitted MAIL-* observation in de and en without unresolved placeholders. */
import { describe, expect, it } from 'vitest';
import { dnsChecks } from '../../../../src/checks/dns/index.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../src/core/data/messages.ts';
import { checkFixtures } from '../../../utils/completeness.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, type ZoneSpec } from './zone.ts';

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
    checkFixtures(check).map((fx) => runCheck(check, fx.snapshot)),
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
