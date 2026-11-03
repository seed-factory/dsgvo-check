/** Rendering of every emitted HDR-01 / TLS-01 / TLS-02 observation in de and en without unresolved placeholders. */
import { describe, expect, it } from 'vitest';
import { httpChecks } from '../../../../src/checks/http/index.ts';
import { loadTexts } from '../../../../src/core/data.ts';
import { renderMessage } from '../../../../src/core/messages.ts';
import { loadFixtures, observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';

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
