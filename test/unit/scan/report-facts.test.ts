/** Facts the scan adds to the report for the reporters: egress source as a code, banner clicks and screenshots. */
import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../../src/core/report/schema.ts';
import { scan } from '../../../src/scan.ts';
import { fakeCollectors } from '../../utils/scan-harness.ts';
import { makeBrowser, makeCmp, makeHttp, makePage, makePhase } from '../../utils/snapshot-builder.ts';
import { opts } from './fixtures.ts';

const START = 'https://www.example.de/';
const visit = (phase: 'A' | 'B' | 'C') => makePage({ url: START, phase, role: 'start' });
const click = (action: 'reject' | 'accept', success: boolean) => ({
  action,
  cmpId: 'example-cmp',
  name: action === 'reject' ? 'Ablehnen' : 'Alle akzeptieren',
  clickedAt: 1,
  pageUrl: START,
  success,
});
const verify = (action: 'reject' | 'accept', verified: boolean) => ({
  action,
  verified,
  method: ['ui-closed'],
  stateAfter: [],
  persistedAfterReload: null,
});

function withConsentRun(over: {
  acceptClicked: boolean;
  acceptVerified: boolean;
  screenshot?: boolean;
  /** The reject was the save of the settings layer. */
  viaSettings?: boolean;
}) {
  return fakeCollectors({
    browser: async () => ({
      status: 'ok',
      sections: {
        browser: makeBrowser({
          phases: [
            makePhase('A', { pages: [visit('A')] }),
            makePhase('B', { pages: [visit('B')], click: click('reject', true) }),
            makePhase('C', { pages: [visit('C')], click: click('accept', over.acceptClicked) }),
          ],
          screenshots: over.screenshot
            ? [
                {
                  id: 'shot-B-banner',
                  phase: 'B',
                  kind: 'banner',
                  path: 'artifacts/banner-B.jpg',
                  sha256: 'a'.repeat(64),
                  width: 400,
                  height: 200,
                  viewport: 'desktop',
                  pageUrl: START,
                },
              ]
            : [],
        }),
        cmp: makeCmp({
          phases: [
            {
              phase: 'B',
              facts: [],
              verify: verify('reject', true),
              ...(over.viaSettings
                ? {
                    click: {
                      action: 'reject' as const,
                      clicked: true,
                      button: {
                        name: 'Speichern',
                        role: 'button',
                        kind: 'reject' as const,
                        kindConfidence: 'high' as const,
                      },
                      path: 'settings' as const,
                    },
                  }
                : {}),
            },
            {
              phase: 'C',
              facts: [],
              ...(over.acceptClicked ? { verify: verify('accept', over.acceptVerified) } : {}),
            },
          ],
        }),
        finalUrl: START,
      },
    }),
    http: async () => ({ status: 'ok', sections: { http: makeHttp() } }),
  });
}

describe('scan — facts for the report', () => {
  it('stores the egress source as a code, which the reporters word in their language', async () => {
    const unknown = await scan(opts());
    const asserted = await scan(opts({ assumeRegion: 'eea' }));

    expect(unknown.report.scan.environment?.egress.source).toBe('not-determined');
    expect(asserted.report.scan.environment?.egress).toMatchObject({
      region: 'asserted',
      assertedRegion: 'eea',
      source: 'assume-region',
    });
  });

  it.each([
    [true, true],
    [true, false],
    [false, false],
  ] as const)('records the banner clicks: accept clicked %s, confirmed %s', async (clicked, verified) => {
    const { report } = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: clicked, acceptVerified: verified }) }),
    );

    expect(report.scan.coverage?.consentActions).toEqual([
      { action: 'reject', clicked: true, verified: true },
      { action: 'accept', clicked, verified: clicked ? verified : null },
    ]);
  });

  it('a reject saved in the settings layer is recorded with its path; a first-layer reject has none', async () => {
    const settings = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: true, acceptVerified: true, viaSettings: true }) }),
    );
    const first = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: true, acceptVerified: true }) }),
    );

    expect(settings.report.scan.coverage?.consentActions?.[0]).toEqual({
      action: 'reject',
      clicked: true,
      verified: true,
      path: 'settings',
    });
    expect(first.report.scan.coverage?.consentActions?.[0]).toEqual({
      action: 'reject',
      clicked: true,
      verified: true,
    });
  });

  it('composes the disclaimer from the click outcome: no claim of a performed phase C without an accept', async () => {
    const failed = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: false, acceptVerified: false }) }),
    );
    const done = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: true, acceptVerified: true }) }),
    );

    expect(failed.report.disclaimer.text).not.toMatch(
      /Phase C \(Annahme im Einwilligungsbanner\) wurde durchgeführt/,
    );
    expect(failed.report.disclaimer.text).toMatch(/Phase C\) konnte nicht ausgelöst werden/);
    expect(done.report.disclaimer.text).toMatch(
      /Phase C \(Annahme im Einwilligungsbanner\) wurde durchgeführt/,
    );
  });

  it('keeps a banner screenshot that no finding cites as evidence of the report', async () => {
    const { report } = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: true, acceptVerified: true, screenshot: true }) }),
    );
    const shots = (report.evidence ?? []).filter((e) => e.type === 'screenshot') as Array<
      Extract<Evidence, { type: 'screenshot' }>
    >;

    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      path: 'artifacts/banner-B.jpg',
      sha256: 'a'.repeat(64),
      kind: 'banner',
      phase: 'B',
    });
    expect(shots[0]!.id).toMatch(/^ev-[0-9a-f]{12}$/);
    expect(report.disclaimer.text).toMatch(/Bildschirmfoto des Bannerbereichs/);
  });

  it('says nothing about screenshots when none was taken', async () => {
    const { report } = await scan(
      opts({ collectors: withConsentRun({ acceptClicked: true, acceptVerified: true }) }),
    );
    expect(report.disclaimer.text).not.toMatch(/Bildschirmfoto/);
  });
});
