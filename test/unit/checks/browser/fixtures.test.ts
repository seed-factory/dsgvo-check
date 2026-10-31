/** The committed browser fixtures equal what scenarios.ts generates (run generate-fixtures.ts after changes). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { fixtureJson, fixturePath } from './generate-fixtures.ts';
import { SCENARIOS } from './scenarios.ts';

describe('browser fixtures', () => {
  it('every browser check has violation, clean and inconclusive scenarios', () => {
    for (const c of browserChecks) {
      const kinds = (SCENARIOS[c.id] ?? []).map((s) => s.file.split('-')[0]);
      expect(kinds.sort(), c.id).toEqual(['clean', 'inconclusive', 'violation']);
    }
  });

  const all = Object.entries(SCENARIOS).flatMap(([id, list]) =>
    list.map((s) => [`${id}/${s.file}`, id, s] as const),
  );
  it.each(all)('%s is up to date', (_name, id, s) => {
    expect(readFileSync(fixturePath(id, s), 'utf8')).toBe(fixtureJson(s));
  });
});
