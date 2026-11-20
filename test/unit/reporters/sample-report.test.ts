import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import { ReportSchema } from '../../../src/core/report/schema.ts';
import { renderJson } from '../../../src/reporters/json.ts';
import { sampleFullReport } from '../../utils/report/fixtures.ts';

/** The fixture is the visible JSON report contract: a contract change shows up as a diff of this file. */
describe('sample report fixture', () => {
  it('matches the JSON renderer and report schema', () => {
    const fixture = readFileSync('test/fixtures/reports/sample-full.report.json', 'utf8');
    expect(() => ReportSchema.parse(JSON.parse(fixture))).not.toThrow();
    expect(fixture).toBe(
      renderJson(sampleFullReport(), { texts: loadTexts('de'), lang: 'de', outDir: '.', color: false }),
    );
  });
});
