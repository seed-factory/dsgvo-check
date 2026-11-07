import { describe, expect, it } from 'vitest';
import { embed01 } from '../../../../../src/checks/browser/embed-01.ts';
import { embed02 } from '../../../../../src/checks/browser/embed-02.ts';
import { MAX_EVIDENCE } from '../../../../../src/checks/browser/evidence.ts';
import type { CmpSection } from '../../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import type { PageVisit, PhaseRecord, RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  phase,
  rejectCmp,
  req,
  START,
  settingsRejectCmp,
  settingsRejectPlan,
  site,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { AFTER_CLICK, expectMoment, momentCases, rejectPhase } from './reject-moment.ts';

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

  it('violation: the map of Kontakt loads before the interaction and again after the confirmed reject', () => {
    const [o] = observationsOf(runCheck(embed02, scenario('violation-maps-after-reject.json')));
    expect(o).toMatchObject({
      phases: ['A', 'B'],
      params: { moment: 'before-and-after-reject', rejectConfirmed: true, afterRejectPageCount: 1 },
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

const TILE = 'https://maps.googleapis.com/maps/vt?pb=[redacted]';
const tile = (id: string, p: Partial<RequestRecord> = {}) =>
  req(id, TILE, { pageUrl: CONTACT, resourceType: 'image', ...p });
const confirmed = rejectCmp({ confirmed: true, pages: { [CONTACT]: 'in-effect' } });

describe('EMBED-02 states whether the map loaded before the interaction, after the reject, or both', () => {
  it.each(momentCases({ load: tile, phaseA: (requests = []) => phase('A', { requests }), control: CONTACT }))(
    '%s',
    (_name, { phases, cmp, want }) => {
      expectMoment(observationsOf(runCheck(embed02, site({ phases, cmp }))), 'maps-loaded', want);
    },
  );

  const render = (lang: 'de' | 'en', phases: PhaseRecord[], cmp: CmpSection) => {
    const [o] = observationsOf(runCheck(embed02, site({ phases, cmp })));
    return renderMessage(loadTexts(lang), 'EMBED-02.maps-loaded', o!.params);
  };
  const both = [phase('A', { requests: [tile('a')] }), rejectPhase(CONTACT, [tile('b', AFTER_CLICK)])];

  it('a confirmed reject: the body counts the pages after it', () => {
    expect(render('de', both, confirmed).body).toBe(
      'Ein externer Kartendienst von Google Maps wurde als Kartenkacheln geladen, Zeitpunkt: vor einer Interaktion ' +
        'mit dem Einwilligungsbanner und erneut nach bestätigter Ablehnung (1 Seite, davon 1 nach der Ablehnung).',
    );
    expect(render('en', both, confirmed).body).toBe(
      'An external map service of Google Maps was loaded as map tiles, timing: before any interaction with the ' +
        'consent banner and again after confirmed rejection (1 page, 1 of them after the rejection).',
    );
  });

  it('an unconfirmed reject is named as a click on "Ablehnen" that was not confirmed', () => {
    const cmp = rejectCmp({ confirmed: false });
    expect(render('de', both, cmp).body).toContain(
      'und erneut nach dem Klick auf „Ablehnen“ (Ablehnung nicht bestätigt)',
    );
    expect(render('en', both, cmp).body).toContain(
      'and again after the click on "Reject" (rejection not confirmed)',
    );
  });

  it('loads only after the reject: the body gives that moment alone', () => {
    const after = [phase('A'), rejectPhase(CONTACT, [tile('b', AFTER_CLICK)])];
    expect(render('de', after, confirmed).body).toContain('Zeitpunkt: nach bestätigter Ablehnung (1 Seite');
  });

  it('a report written before the moment was recorded keeps its timing in the body', () => {
    const texts = loadTexts('de');
    const old = {
      service: 'Google Maps',
      integrationType: 'iframe',
      afterReject: true,
      bannerFound: true,
      pageCount: 1,
    };
    expect(renderMessage(texts, 'EMBED-02.maps-loaded', old)).toMatchObject({
      title: 'Externer Kartendienst geladen: Google Maps',
      body: expect.stringContaining(
        'Zeitpunkt: vor einer Interaktion mit dem Einwilligungsbanner bzw. nach Ablehnung',
      ),
    });
  });
});

describe('EMBED-02 names a reject saved in the settings layer of a first layer without reject', () => {
  const both = [phase('A', { requests: [tile('a')] }), rejectPhase(CONTACT, [tile('b', AFTER_CLICK)])];
  const observe = (phases: PhaseRecord[], cmp: CmpSection) =>
    observationsOf(runCheck(embed02, site({ phases, cmp, plan: settingsRejectPlan() })));
  const render = (lang: 'de' | 'en', cmp: CmpSection) =>
    renderMessage(loadTexts(lang), 'EMBED-02.maps-loaded', observe(both, cmp)[0]!.params);

  it.each([
    [
      'a confirmed save in the settings layer',
      settingsRejectCmp(),
      { rejectConfirmed: true, rejectPath: 'settings' },
    ],
    [
      'a save the platform policy did not record',
      settingsRejectCmp({ confirmed: false }),
      { rejectConfirmed: false, rejectPath: 'settings' },
    ],
    ['a first-layer reject', confirmed, { rejectConfirmed: true, rejectPath: 'first-layer' }],
  ])('%s: the params name where the reject was pressed', (_name, cmp, want) => {
    expect(observe(both, cmp)).toMatchObject([
      { params: { moment: 'before-and-after-reject', afterRejectPageCount: 1, ...want } },
    ]);
  });

  it('counterexample: loads before the interaction only name no reject path', () => {
    expect(observe([phase('A', { requests: [tile('a')] })], settingsRejectCmp())[0]?.params).toMatchObject({
      moment: 'before-interaction',
      rejectPath: null,
    });
  });

  it('the map after the confirmed save: "auch nach bestätigter Ablehnung über die Einstellungen", and why', () => {
    expect(render('de', settingsRejectCmp())).toMatchObject({
      title:
        'Externer Kartendienst geladen, auch nach bestätigter Ablehnung über die Einstellungen: Google Maps',
      body:
        'Ein externer Kartendienst von Google Maps wurde als Kartenkacheln geladen, Zeitpunkt: vor einer Interaktion ' +
        'mit dem Einwilligungsbanner und erneut nach bestätigter Ablehnung über die Einstellungen (1 Seite, davon 1 ' +
        'nach der Ablehnung). Die erste Ebene des Einwilligungsbanners bot keine Ablehnung; abgelehnt wurde in den ' +
        'Einstellungen, in denen alle optionalen Kategorien bereits ausgeschaltet waren.',
    });
    expect(render('en', settingsRejectCmp())).toMatchObject({
      title: 'External map service loaded, also after confirmed rejection via the settings: Google Maps',
      body:
        'An external map service of Google Maps was loaded as map tiles, timing: before any interaction with the ' +
        'consent banner and again after confirmed rejection via the settings (1 page, 1 of them after the ' +
        'rejection). The first layer of the consent banner offered no rejection; the rejection was saved in the ' +
        'settings, where every optional category was already switched off.',
    });
  });

  it('a save that was not confirmed: "auch nach Ablehnung über die Einstellungen", named as the save of the settings', () => {
    const cmp = settingsRejectCmp({ confirmed: false });
    expect(render('de', cmp).title).toBe(
      'Externer Kartendienst geladen, auch nach Ablehnung über die Einstellungen: Google Maps',
    );
    expect(render('de', cmp).body).toContain(
      'und erneut nach dem Speichern der Einstellungen (Ablehnung nicht bestätigt)',
    );
    expect(render('en', cmp).title).toBe(
      'External map service loaded, also after rejection via the settings: Google Maps',
    );
    expect(render('en', cmp).body).toContain('and again after saving the settings (rejection not confirmed)');
  });

  it('the scenario fixture: one maps-loaded finding with the reject proof of the settings save', () => {
    const [o] = observationsOf(runCheck(embed02, scenario('violation-maps-after-settings-reject.json')));
    expect(o?.params).toMatchObject({ rejectPath: 'settings', rejectConfirmed: true });
    expect(o?.evidence.filter((e) => e.type === 'consent-state').map((e) => e.origin)).toEqual([
      'action',
      'stored',
    ]);
  });
});

describe('EMBED-02 evidence after the reject', () => {
  const tiles = (prefix: string, p: Partial<RequestRecord> = {}) =>
    Array.from({ length: 12 }, (_, i) =>
      req(`${prefix}-${i}`, `https://maps.googleapis.com/maps/vt/tile-${i}.png`, {
        pageUrl: CONTACT,
        resourceType: 'image',
        ...p,
      }),
    );

  it('12 tiles before the interaction and the same after the confirmed reject: B requests and the reject proof', () => {
    const [o] = observationsOf(
      runCheck(
        embed02,
        site({
          phases: [phase('A', { requests: tiles('a') }), rejectPhase(CONTACT, tiles('b', AFTER_CLICK))],
          cmp: confirmed,
        }),
      ),
    );
    const evidence = o?.evidence ?? [];
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
    const afterClick = evidence.filter((e) => e.type === 'request' && e.phase === 'B' && !e.beforeClick);
    expect(afterClick.length).toBeGreaterThanOrEqual(1);
    expect(evidence.filter((e) => e.type === 'consent-state')).toEqual([
      expect.objectContaining({ origin: 'action', phase: 'B', page: START }),
      expect.objectContaining({ origin: 'stored', phase: 'B', page: START }),
    ]);
  });

  it.each([
    ['loads before the interaction only', [phase('A', { requests: [tile('a')] })], confirmed],
    [
      'a reject the CMP state did not confirm',
      [phase('A', { requests: [tile('a')] }), rejectPhase(CONTACT, [tile('b', AFTER_CLICK)])],
      rejectCmp({ confirmed: false }),
    ],
  ] as const)('counterexample: %s gives no reject proof', (_name, phases, cmp) => {
    const [o] = observationsOf(runCheck(embed02, site({ phases: [...phases], cmp })));
    expect(o?.evidence.filter((e) => e.type === 'consent-state')).toEqual([]);
  });
});

describe('EMBED-02 resources of the map frame', () => {
  const frame = {
    frameId: 'A-f2',
    isMainFrame: false,
    frameUrl: 'https://www.google.com/maps/embed?pb=[redacted]',
    pageUrl: CONTACT,
  };
  const mapDocument = req('a', 'https://www.google.com/maps/embed?pb=[redacted]', {
    ...frame,
    isNavigation: true,
    resourceType: 'document',
  });
  const frameCss = req('b', 'https://fonts.googleapis.com/css2?family=Roboto', {
    ...frame,
    resourceType: 'stylesheet',
  });
  const frameFont = req('c', 'https://fonts.gstatic.com/s/roboto/v48/x.woff2', {
    ...frame,
    resourceType: 'font',
  });
  const helper = req('d', 'https://helper.unknown-host.example/t.js', frame);
  const mapOf = (requests: RequestRecord[]) =>
    observationsOf(runCheck(embed02, site({ phases: [phase('A', { requests })] })));

  it('fonts and helper hosts the map frame loads are counted with the map, the map requests lead the evidence', () => {
    const [o] = mapOf([mapDocument, frameFont, helper]);
    expect(o).toMatchObject({
      subject: 'google-maps',
      params: { frameResourceCount: 2, integrationType: 'iframe' },
    });
    expect(o?.evidence[0]).toMatchObject({ url: 'https://www.google.com/maps/embed?pb=[redacted]' });
  });

  it('the map frame loading Google Fonts and a helper host: one finding that names Google Fonts', () => {
    const observations = mapOf([mapDocument, frameCss, frameFont, helper]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      subject: 'google-maps',
      params: {
        frameFontServices: 'Google Fonts',
        frameFontRequestCount: 2,
        frameHelperCount: 1,
        frameResourceCount: 3,
      },
    });
    const urls = observations[0]?.evidence.flatMap((e) => (e.type === 'request' ? [e.url] : []));
    expect(urls).toEqual(expect.arrayContaining([frameCss.url]));

    const params = observations[0]!.params;
    expect(renderMessage(loadTexts('de'), 'EMBED-02.maps-loaded', params).body).toContain(
      ' Der Kartenrahmen lud dabei Schriften von Google Fonts (2 Anfragen). Der Kartenrahmen stellte außerdem 1 Anfrage an Hilfshosts.',
    );
    expect(renderMessage(loadTexts('en'), 'EMBED-02.maps-loaded', params).body).toContain(
      ' The map frame also loaded fonts from Google Fonts (2 requests). The map frame also made 1 request to helper hosts.',
    );
  });

  it('a font request of the frame reaches the evidence behind 12 map tiles', () => {
    const tiles = Array.from({ length: 12 }, (_, i) =>
      req(`t-${i}`, `https://maps.googleapis.com/maps/vt/tile-${i}.png`, { ...frame, resourceType: 'image' }),
    );
    const [o] = mapOf([mapDocument, ...tiles, frameFont]);
    const evidence = o?.evidence ?? [];
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
    expect(evidence[0]).toMatchObject({ url: mapDocument.url });
    expect(evidence.some((e) => e.type === 'request' && e.url === frameFont.url)).toBe(true);
  });

  it('counterexample: a map frame with a helper host only names no font service', () => {
    const [o] = mapOf([mapDocument, helper]);
    expect(o?.params).toMatchObject({
      frameFontServices: null,
      frameFontRequestCount: 0,
      frameHelperCount: 1,
    });
    const de = renderMessage(loadTexts('de'), 'EMBED-02.maps-loaded', o!.params).body;
    expect(de).not.toMatch(/Schrift/);
    expect(de).toContain('Der Kartenrahmen stellte außerdem 1 Anfrage an Hilfshosts.');
  });

  it('counterexample: the fonts of the page itself stay EMBED-01, the frame fonts EMBED-02, none in both', () => {
    const pageCss = req('p', 'https://fonts.googleapis.com/css2?family=Roboto', {
      pageUrl: CONTACT,
      resourceType: 'stylesheet',
    });
    const snapshot = site({
      phases: [phase('A', { requests: [pageCss, mapDocument, frameCss, frameFont] })],
    });

    const fonts = observationsOf(runCheck(embed01, snapshot));
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatchObject({ variant: 'fonts-loaded', subject: 'google-fonts' });
    expect(fonts[0]?.evidence).toEqual([expect.objectContaining({ type: 'request', url: pageCss.url })]);
    expect(fonts[0]?.evidence[0]).not.toHaveProperty('frameUrl');

    const [map] = observationsOf(runCheck(embed02, snapshot));
    expect(map?.params).toMatchObject({ frameFontServices: 'Google Fonts', frameFontRequestCount: 2 });
    expect(map?.evidence.filter((e) => e.type === 'request' && !e.frameUrl)).toEqual([]);
  });
});
