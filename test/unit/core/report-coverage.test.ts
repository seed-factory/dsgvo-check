/** : coverage rows of the report (5.1 `coverage.pages`): one row per page, also when the start page redirected. */
import { describe, expect, it } from 'vitest';
import { coverageOf } from '../../../src/core/report.ts';
import {
  makeBrowser,
  makeBrowserPlan,
  makePage,
  makePhase,
  makeSnapshot,
} from '../../utils/snapshot-builder.ts';

describe('coverageOf', () => {
  it('a redirected start page is one row: phase A requested example.de, plan and B/C use the final URL', () => {
    const final = 'https://www.example.de/';
    const snapshot = makeSnapshot({
      browser: makeBrowser({
        phases: [
          makePhase('A', {
            pages: [makePage({ url: 'https://example.de/', finalUrl: final, role: 'start', phase: 'A' })],
          }),
          makePhase('B', { pages: [makePage({ url: final, finalUrl: final, role: 'start', phase: 'B' })] }),
        ],
      }),
      plan: {
        browser: makeBrowserPlan({
          pages: [{ url: final, role: 'start', order: 0, reasons: ['start'], source: 'start' }],
        }),
        probes: [],
      },
    });
    const rows = coverageOf(snapshot).pages;
    expect(rows).toEqual([
      { url: final, role: 'start', planned: true, observed: true, evaluated: true, phases: ['A', 'B'] },
    ]);
  });

  it('a plan entry with the requested URL matches the visit that ended on another URL', () => {
    const snapshot = makeSnapshot({
      browser: makeBrowser({
        phases: [
          makePhase('A', {
            pages: [
              makePage({
                url: 'https://www.example.de/impressum',
                finalUrl: 'https://www.example.de/impressum/',
                role: 'impressum',
                phase: 'A',
              }),
            ],
          }),
        ],
      }),
      plan: {
        browser: makeBrowserPlan({
          pages: [
            {
              url: 'https://www.example.de/impressum',
              role: 'impressum',
              order: 1,
              reasons: ['footer-link:impressum'],
              source: 'link',
            },
          ],
        }),
        probes: [],
      },
    });
    expect(coverageOf(snapshot).pages).toHaveLength(1);
    expect(coverageOf(snapshot).pages[0]).toMatchObject({ planned: true, observed: true, evaluated: true });
  });
});
