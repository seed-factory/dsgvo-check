import { describe, expect, it } from 'vitest';
import { embed02 } from '../../../../../src/checks/browser/embed-02.ts';
import type { PageVisit } from '../../../../../src/core/snapshot/browser.ts';
import { observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import { CONTACT, click, phase, req, site } from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['EMBED-02']!.find((s) => s.file === file)!.build();

describe('EMBED-02 external maps', () => {
  it('violation: Google Maps iframe and tiles on Kontakt → maps-loaded as iframe', () => {
    const [o] = observationsOf(runCheck(embed02, scenario('violation-maps-contact.json')));
    expect(o).toMatchObject({
      variant: 'maps-loaded',
      subject: 'google-maps',
      pages: [CONTACT],
      params: {
        service: 'Google Maps',
        integrationType: 'iframe',
        integrations: 'iframe, tiles',
        afterReject: false,
      },
    });
  });

  it('clean: two-click placeholder and a plain link, no request', () => {
    expect(variantsOf(runCheck(embed02, scenario('clean-two-click-placeholder.json')))).toEqual([]);
  });

  it('inconclusive: Kontakt behind a challenge and nothing found', () => {
    expect(runCheck(embed02, scenario('inconclusive-contact-blocked.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'contact-page-not-evaluable',
    });
  });

  it('counterexample: the map appears only after accept (C) → no finding', () => {
    const r = runCheck(
      embed02,
      site({
        phases: [
          phase('A'),
          phase('C', {
            click: click('accept'),
            requests: [
              req('c', 'https://www.google.com/maps/embed?pb=[redacted]', {
                phase: 'C',
                afterClick: true,
                resourceType: 'document',
              }),
            ],
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('OpenStreetMap tiles after the reject → tiles, afterReject', () => {
    const r = runCheck(
      embed02,
      site({
        phases: [
          phase('A'),
          phase('B', {
            click: click('reject'),
            requests: [
              req('b', 'https://tile.openstreetmap.org/12/2200/1343.png', {
                phase: 'B',
                afterClick: true,
                resourceType: 'image',
              }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'openstreetmap',
      params: { integrationType: 'tiles', afterReject: true },
      provider: { name: 'OpenStreetMap Foundation', country: 'GB' },
    });
  });

  it('a page taller than the largest viewport of the reveal is a limitation beside the finding', () => {
    const capped = {
      outcome: 'revealed',
      documentHeightPx: 20_000,
      viewportHeightPx: 10_000,
      capped: true,
    } as const;
    const withReveal = (reveal: PageVisit['reveal']) => {
      const built = scenario('violation-maps-contact.json');
      const a = built.browser?.phases.find((p) => p.phase === 'A');
      const contact = a?.pages.find((p) => p.role === 'contact');
      if (contact && reveal) contact.reveal = reveal;
      return runCheck(embed02, built);
    };

    const r = withReveal(capped);
    expect(r.outcome?.limitations).toEqual(['reveal-height-capped']);
    expect(variantsOf(r)).toEqual(['maps-loaded']);
    expect(withReveal(undefined).outcome?.limitations).toEqual([]);
    expect(withReveal({ outcome: 'fits-viewport', documentHeightPx: 700 }).outcome?.limitations).toEqual([]);
  });

  it('a blocked attempt is not described as a load', () => {
    const r = runCheck(
      embed02,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://maps.googleapis.com/maps/api/js?key=[redacted]', {
                state: 'blocked-by-browser',
              }),
            ],
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });
});

describe('EMBED-02 resources of the map frame', () => {
  it('fonts and helper hosts the map frame loads are counted with the map, the map requests lead the evidence', () => {
    const frame = {
      frameId: 'A-f2',
      isMainFrame: false,
      frameUrl: 'https://www.google.com/maps/embed?pb=[redacted]',
      pageUrl: CONTACT,
    };
    const r = runCheck(
      embed02,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://www.google.com/maps/embed?pb=[redacted]', {
                ...frame,
                isNavigation: true,
                resourceType: 'document',
              }),
              req('b', 'https://fonts.gstatic.com/s/roboto/v48/x.woff2', { ...frame, resourceType: 'font' }),
              req('c', 'https://helper.unknown-host.example/t.js', frame),
            ],
          }),
        ],
      }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      subject: 'google-maps',
      params: { frameResourceCount: 2, integrationType: 'iframe' },
    });
    expect(o?.evidence[0]).toMatchObject({ url: 'https://www.google.com/maps/embed?pb=[redacted]' });
  });
});
