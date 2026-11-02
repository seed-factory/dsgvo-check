import { expect, it } from 'vitest';
import { renderJson } from '../../../src/reporters/json.ts';
import { normalizeReport } from '../../utils/normalize-report.ts';
import { sampleFullReport } from '../../utils/report-fixtures.ts';

it('keeps the published JSON report contract visible as a normalized file snapshot', async () => {
  const json = renderJson(sampleFullReport(), {
    texts: { lang: 'de', messages: {}, legalNotes: {}, ui: {} },
    lang: 'de',
    outDir: '/tmp/report-contract',
    color: false,
  });
  const normalized = `${JSON.stringify(normalizeReport(JSON.parse(json)), null, 2)}\n`;
  await expect(normalized).toMatchFileSnapshot('./__snapshots__/report-contract.json');
});
