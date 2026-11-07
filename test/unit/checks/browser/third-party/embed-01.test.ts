import { describe, expect, it } from 'vitest';
import { embed01 } from '../../../../../src/checks/browser/embed-01.ts';
import { embed02 } from '../../../../../src/checks/browser/embed-02.ts';
import { MAX_EVIDENCE } from '../../../../../src/checks/browser/evidence.ts';
import type { CmpSection } from '../../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import type { PhaseRecord, RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { makeDom, observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  defaultPages,
  IMPRESSUM,
  page,
  phase,
  rejectCmp,
  req,
  START,
  settingsRejectCmp,
  site,
} from '../helpers.ts';
import {
  CAPTCHA_FRAME,
  FRAME_CSS,
  FRAME_FONT,
  frameWithFont,
  inMapFrame,
  MAP_EMBED,
  mapWithFonts,
  TYPEKIT_USAGE,
} from '../scenarios/embed-01.ts';
import { SCENARIOS, VARIANT_SCENARIOS } from '../scenarios/index.ts';
import { AFTER_CLICK, expectMoment, momentCases, rejectPhase } from './reject-moment.ts';

const scenario = (file: string) => SCENARIOS['EMBED-01']!.find((s) => s.file === file)!.build();
const css = (id: string, p = {}) =>
  req(id, 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet', ...p });

describe('EMBED-01 external fonts', () => {
  it('violation: Google Fonts CSS and font file → fonts-loaded', () => {
    const [o] = observationsOf(runCheck(embed01, scenario('violation-google-fonts.json')));
    expect(o).toMatchObject({
      variant: 'fonts-loaded',
      subject: 'google-fonts',
      category: 'fonts',
      params: { service: 'Google Fonts', pageCount: 1, afterReject: false },
    });
    expect(o?.evidence).toHaveLength(2);
  });

  it('counterexample: an unfinished font request is not a load', () => {
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { requests: [css('a', { state: 'failed', status: undefined })] })] }),
    );
    expect(variantsOf(r)).toEqual(['preconnect-only']);
  });

  it('a load after the reject stays fonts-loaded', () => {
    const afterReject = runCheck(
      embed01,
      site({
        phases: [
          phase('A'),
          phase('B', { click: click('reject'), requests: [css('b', { phase: 'B', afterClick: true })] }),
        ],
      }),
    );
    expect(observationsOf(afterReject)[0]).toMatchObject({
      variant: 'fonts-loaded',
      phases: ['B'],
      params: { afterReject: true },
    });
  });

  it('p.typekit.net alone (purpose not verified) is not a font load; Bunny Fonts (EU) still is', () => {
    const typekit = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://p.typekit.net/p.css?s=1', { resourceType: 'stylesheet' })],
          }),
        ],
      }),
    );
    expect(variantsOf(typekit)).toEqual([]);
    const bunny = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://fonts.bunny.net/css?family=inter', { resourceType: 'stylesheet' })],
          }),
        ],
      }),
    );
    expect(observationsOf(bunny)[0]).toMatchObject({ variant: 'fonts-loaded', provider: { country: 'SI' } });
  });

  it('the collector gap "preconnect-without-request" (as in BASE_KNOWN_GAPS) is reported as a limitation', () => {
    const gaps = ['pagehide-beacons', 'preconnect-without-request', 'blocked-cookies-not-recorded'];
    const r = runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })], knownGaps: gaps }));
    expect(r.outcome?.limitations).toEqual(['preconnect-not-observable']);
    const none = runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })] }));
    expect(none.outcome?.limitations).toEqual([]);
  });

  it('a page taller than the largest viewport of the reveal is a limitation, in phases A and B only', () => {
    const capped = {
      outcome: 'revealed',
      documentHeightPx: 20_000,
      viewportHeightPx: 10_000,
      capped: true,
    } as const;
    const tall = (ph: 'A' | 'B' | 'C') => ({ pages: [page(START, 'start', ph, { reveal: capped })] });
    const limitations = (phases: PhaseRecord[]) => runCheck(embed01, site({ phases })).outcome?.limitations;

    expect(limitations([phase('A', { ...tall('A'), requests: [css('a')] })])).toEqual([
      'reveal-height-capped',
    ]);
    expect(limitations([phase('A', { requests: [css('a')] }), phase('B', tall('B'))])).toEqual([
      'reveal-height-capped',
    ]);
    // Phase C is not read by the check; a revealed page within the limit and an older snapshot are no limitation.
    expect(limitations([phase('A', { requests: [css('a')] }), phase('C', tall('C'))])).toEqual([]);
    const whole = { outcome: 'revealed', documentHeightPx: 4_000, viewportHeightPx: 4_000 } as const;
    const fits = [page(START, 'start', 'A', { reveal: whole })];
    expect(limitations([phase('A', { pages: fits, requests: [css('a')] })])).toEqual([]);
  });
});

describe('EMBED-01 font files from other third-party servers', () => {
  const font = (id: string, url: string, p = {}) => req(id, url, { resourceType: 'font', ...p });

  it('font files of a host outside the catalog → fonts-loaded named by its domain', () => {
    const r = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [
              font('a', 'https://cdn.booking-widget.example/fonts/Display-Regular.ttf'),
              font('b', 'https://cdn.booking-widget.example/fonts/Display-Bold.ttf'),
              req('c', 'https://cdn.booking-widget.example/sdk.js'),
            ],
          }),
        ],
      }),
    );
    const [o] = observationsOf(r);
    expect(observationsOf(r)).toHaveLength(1);
    expect(o).toMatchObject({
      variant: 'fonts-loaded',
      subject: 'unknown:booking-widget.example',
      category: 'fonts',
      params: { service: 'booking-widget.example', fontService: false, pageCount: 1 },
    });
    expect(o?.evidence).toHaveLength(2);
    expect(renderMessage(loadTexts('de'), 'EMBED-01.fonts-loaded', o!.params).body).toMatch(
      /^Schriftdateien wurden vom Drittanbieter-Server booking-widget\.example geladen, Zeitpunkt: vor jeder Interaktion, kein Einwilligungsbanner gefunden/,
    );
  });

  it('font files a widget of the page fetches from its vendor → fonts-loaded with the widget as the service', () => {
    const [o] = observationsOf(
      runCheck(
        embed01,
        site({
          phases: [phase('A', { requests: [font('a', 'https://assets.calendly.com/fonts/x.woff2')] })],
        }),
      ),
    );
    expect(o).toMatchObject({
      subject: 'calendly',
      serviceId: 'calendly',
      params: { service: 'Calendly', fontService: false },
    });
  });

  it('counterexample: font files from a CDN stay a resource of CONSENT-01', () => {
    const r = runCheck(
      embed01,
      site({
        phases: [
          phase('A', { requests: [font('a', 'https://cdnjs.cloudflare.com/ajax/libs/fa/6.0.0/fa.woff2')] }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it("counterexample: the fonts of an embedded player are the player frame's fonts, not a font load of the site", () => {
    const frame = {
      frameId: 'A-f2',
      isMainFrame: false,
      frameUrl: 'https://www.youtube-nocookie.com/embed/abc',
    };
    const r = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://www.youtube-nocookie.com/embed/abc', {
                ...frame,
                isNavigation: true,
                resourceType: 'document',
              }),
              font('b', 'https://fonts.gstatic.com/s/roboto/v48/x.woff2', frame),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(r)).toMatchObject([
      {
        variant: 'fonts-in-embed-frame',
        subject: 'google-fonts@youtube-nocookie',
        params: { service: 'Google Fonts', embedService: 'YouTube (youtube-nocookie.com)', requestCount: 1 },
        related: [{ checkId: 'EMBED-03', subject: 'youtube-nocookie', relation: 'embedded-in' }],
      },
    ]);
  });
});

describe("EMBED-01 fonts of an embed's frame", () => {
  const frameScenario = (file: string) =>
    VARIANT_SCENARIOS['EMBED-01']!.find((s) => s.file === file)!.build();
  const frameFont = (id: string, p: Partial<RequestRecord> = {}) => inMapFrame(id, FRAME_FONT, 'font', p);
  const de = loadTexts('de');
  const en = loadTexts('en');

  it('violation: the Google Maps frame on Kontakt loads Google Fonts → one finding of the font service in the map', () => {
    const [o, ...more] = observationsOf(
      runCheck(embed01, frameScenario('violation-fonts-in-map-frame.json')),
    );
    expect(more).toEqual([]);
    expect(o).toMatchObject({
      variant: 'fonts-in-embed-frame',
      subject: 'google-fonts@google-maps',
      serviceId: 'google-fonts',
      provider: { name: 'Google Ireland Limited', country: 'IE' },
      category: 'fonts',
      phases: ['A'],
      pages: [CONTACT],
      params: {
        service: 'Google Fonts',
        embedService: 'Google Maps',
        pageCount: 1,
        requestCount: 2,
        moment: 'before-interaction',
        rejectConfirmed: null,
        afterReject: false,
        rejectPath: null,
        bannerFound: false,
      },
      related: [{ checkId: 'EMBED-02', subject: 'google-maps', relation: 'embedded-in' }],
    });
    // The font requests as recorded in the map frame; the map document is EMBED-02's own request.
    expect(o?.evidence.map((e) => e.type === 'request' && [e.url, e.frameUrl])).toEqual([
      [FRAME_CSS, MAP_EMBED],
      [FRAME_FONT, MAP_EMBED],
    ]);

    expect(renderMessage(de, 'EMBED-01.fonts-in-embed-frame', o!.params)).toMatchObject({
      title: 'Externe Schriftarten von einer Einbettung geladen: Google Fonts in Google Maps',
      body:
        'Der Rahmen des eingebetteten Dienstes Google Maps lud Schriftdateien oder Stylesheets von Google Fonts ' +
        '(2 Anfragen), Zeitpunkt: vor jeder Interaktion, kein Einwilligungsbanner gefunden (1 Seite).',
    });
    expect(renderMessage(en, 'EMBED-01.fonts-in-embed-frame', o!.params)).toMatchObject({
      title: 'External fonts loaded by an embed: Google Fonts in Google Maps',
      body:
        'The frame of the embedded service Google Maps loaded font files or stylesheets of Google Fonts ' +
        '(2 requests), timing: before any interaction, no consent banner found (1 page).',
    });
    expect(formatMessage(de.actions['EMBED-01.fonts-in-embed-frame']!, o!.params, 'de')).toBe(
      'Binden Sie Google Maps erst nach einer Einwilligung oder nach einem Klick der Besucher ein ' +
        '(Zwei-Klick-Lösung). Die Schriften von Google Fonts, die der Rahmen der Einbettung lädt, lassen sich ' +
        'nicht vom eigenen Server ausliefern.',
    );
    expect(formatMessage(en.actions['EMBED-01.fonts-in-embed-frame']!, o!.params, 'en')).toBe(
      'Embed Google Maps only after consent or after visitors click on it (two-click solution). The fonts of ' +
        "Google Fonts that the embed's frame loads cannot be served from your own server.",
    );
  });

  it("counterexample: the site's own Google Fonts stay fonts-loaded beside the map frame's, each with its requests", () => {
    const found = observationsOf(
      runCheck(embed01, frameScenario('violation-site-fonts-beside-map-frame-fonts.json')),
    );
    expect(found.map((o) => [o.variant, o.subject, o.pages])).toEqual([
      ['fonts-loaded', 'google-fonts', [START]],
      ['fonts-in-embed-frame', 'google-fonts@google-maps', [CONTACT]],
    ]);
    const [site, frame] = found;
    expect(site?.evidence).toEqual([expect.objectContaining({ type: 'request', page: START })]);
    expect(site?.evidence[0]).not.toHaveProperty('frameUrl');
    expect(frame?.evidence.every((e) => e.type === 'request' && e.frameUrl === MAP_EMBED)).toBe(true);
    expect(frame?.params).toMatchObject({ requestCount: 2 });
  });

  it.each([
    ['an embed frame that loads no font', 'clean-map-frame-without-fonts.json'],
    ['a map frame whose fonts load only after the accept', 'clean-map-frame-fonts-after-accept.json'],
    ['the fonts of a reCAPTCHA and a Calendly frame', 'clean-captcha-and-widget-frame-fonts.json'],
    ["a map frame that only calls Adobe Fonts' usage counter", 'clean-map-frame-typekit-usage-hit.json'],
  ])('counterexample: %s gives no finding', (_name, file) => {
    expect(variantsOf(runCheck(embed01, frameScenario(file)))).toEqual([]);
  });

  it('counterexample: a map frame whose only font-service request is the kit script of Adobe Fonts gives no frame finding', () => {
    const document = inMapFrame('a', MAP_EMBED, 'document', { isNavigation: true });
    const kitScript = inMapFrame('b', 'https://use.typekit.net/abc1234.js', 'script');
    const snapshot = site({ phases: [phase('A', { requests: [document, kitScript] })] });

    expect(variantsOf(runCheck(embed01, snapshot))).toEqual([]);
    const [map] = observationsOf(runCheck(embed02, snapshot));
    expect(map?.params).toMatchObject({ frameFontServices: null, frameFontRequestCount: 0 });
  });

  it("the map's finding names the same frame fonts: the usage hit beside an Adobe Fonts kit is no font and no helper host", () => {
    const kit = inMapFrame('b', 'https://use.typekit.net/abc1234.css', 'stylesheet');
    const usage = inMapFrame('c', TYPEKIT_USAGE, 'stylesheet');
    const document = inMapFrame('a', MAP_EMBED, 'document', { isNavigation: true });
    const snapshot = site({ phases: [phase('A', { requests: [document, kit, usage] })] });

    const [fonts, ...more] = observationsOf(runCheck(embed01, snapshot));
    expect(more).toEqual([]);
    expect(fonts).toMatchObject({
      variant: 'fonts-in-embed-frame',
      subject: 'adobe-fonts@google-maps',
      params: { service: 'Adobe Fonts', embedService: 'Google Maps', requestCount: 1 },
    });
    expect(fonts?.evidence.map((e) => e.type === 'request' && e.url)).toEqual([kit.url]);

    const [map] = observationsOf(runCheck(embed02, snapshot));
    expect(map?.params).toMatchObject({
      frameFontServices: 'Adobe Fonts',
      frameFontRequestCount: 1,
      frameHelperCount: 0,
      frameResourceCount: 2,
    });

    const [onlyUsage] = observationsOf(
      runCheck(embed02, frameScenario('clean-map-frame-typekit-usage-hit.json')),
    );
    expect(onlyUsage?.params).toMatchObject({
      frameFontServices: null,
      frameFontRequestCount: 0,
      frameHelperCount: 0,
      frameResourceCount: 1,
    });
  });

  it('counterexample: an unfinished font request of the frame is no load and no connection hint of the site', () => {
    const r = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [
              inMapFrame('a', MAP_EMBED, 'document', { isNavigation: true }),
              frameFont('b', { state: 'failed', status: undefined }),
            ],
          }),
        ],
      }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('one finding per font service and embed: two map frames on two pages are one, a player frame its own', () => {
    const player = {
      frameId: 'A-player',
      isMainFrame: false,
      frameUrl: 'https://www.youtube-nocookie.com/embed/abc',
    };
    const r = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [
              ...mapWithFonts('A'),
              inMapFrame('S-1', MAP_EMBED, 'document', {
                pageUrl: START,
                frameId: 'A-map2',
                isNavigation: true,
              }),
              inMapFrame('S-2', FRAME_FONT, 'font', { pageUrl: START, frameId: 'A-map2' }),
              req('P-1', 'https://www.youtube-nocookie.com/embed/abc', {
                ...player,
                isNavigation: true,
                resourceType: 'document',
              }),
              req('P-2', FRAME_FONT, { ...player, resourceType: 'font' }),
            ],
          }),
        ],
      }),
    );
    expect(
      observationsOf(r).map((o) => [o.subject, o.pages, o.params.pageCount, o.params.requestCount]),
    ).toEqual([
      ['google-fonts@google-maps', [START, CONTACT].sort(), 2, 3],
      ['google-fonts@youtube-nocookie', [START], 1, 1],
    ]);
  });

  it("a frame's late font request counts for the page of the frame's document; the map's finding, where it was recorded", () => {
    const snapshot = site({
      phases: [
        phase('A', {
          requests: [
            inMapFrame('a', MAP_EMBED, 'document', { isNavigation: true }),
            frameFont('b', { pageUrl: IMPRESSUM }),
          ],
        }),
      ],
    });
    const [fonts] = observationsOf(runCheck(embed01, snapshot));
    expect(fonts).toMatchObject({
      variant: 'fonts-in-embed-frame',
      pages: [CONTACT],
      params: { pageCount: 1 },
    });
    const [map] = observationsOf(runCheck(embed02, snapshot));
    expect(map).toMatchObject({
      variant: 'maps-loaded',
      pages: [CONTACT, IMPRESSUM].sort(),
      params: { pageCount: 2, frameFontRequestCount: 1 },
    });
  });

  it.each(
    momentCases({
      load: frameFont,
      phaseA: (requests = []) => phase('A', { requests }),
      control: CONTACT,
    }),
  )('%s', (_name, { phases, cmp, want }) => {
    expectMoment(observationsOf(runCheck(embed01, site({ phases, cmp }))), 'fonts-in-embed-frame', want);
  });

  it('after the confirmed reject: the title and body say so, and the evidence shows the reject proof', () => {
    const phases = [
      phase('A', { requests: mapWithFonts('A') }),
      rejectPhase(CONTACT, mapWithFonts('B', AFTER_CLICK)),
    ];
    const [o] = observationsOf(runCheck(embed01, site({ phases, cmp: confirmed })));
    const m = renderMessage(de, 'EMBED-01.fonts-in-embed-frame', o!.params);
    expect(m.title).toBe(
      'Externe Schriftarten von einer Einbettung geladen, auch nach bestätigter Ablehnung: Google Fonts in Google Maps',
    );
    expect(m.body).toContain(
      'Zeitpunkt: vor einer Interaktion mit dem Einwilligungsbanner und erneut nach bestätigter Ablehnung ' +
        '(1 Seite, davon 1 nach der Ablehnung).',
    );
    expect(o?.evidence.some((e) => e.type === 'request' && e.phase === 'B' && !e.beforeClick)).toBe(true);
    expect(
      o?.evidence
        .filter((e) => e.type === 'consent-state')
        .map((e) => e.type === 'consent-state' && e.origin),
    ).toEqual(['action', 'stored']);
  });
});

describe('EMBED-01 without a completed font load names what was observed', () => {
  const failed = { state: 'failed', status: undefined } as const;
  const hintedStart = page(START, 'start', 'A', {
    dom: makeDom({ linkRels: [{ rel: 'preconnect', href: 'https://fonts.gstatic.com/', source: 'dom' }] }),
  });
  const otherHostFont = req('a', 'https://static.other-unknown.net/fonts/x.woff2', {
    resourceType: 'font',
    ...failed,
  });

  /** Input, what the finding rests on, and its title in de and en. */
  const CASES: Array<[string, Partial<PhaseRecord>, string, string, string]> = [
    [
      'an unfinished font file request to a host outside the catalog',
      { requests: [otherHostFont] },
      'attempt',
      'Nicht abgeschlossener Schriftabruf: other-unknown.net',
      'Unfinished font request: other-unknown.net',
    ],
    [
      'an unfinished request to a font service',
      { requests: [css('a', failed)] },
      'attempt',
      'Nicht abgeschlossener Schriftabruf: Google Fonts',
      'Unfinished font request: Google Fonts',
    ],
    [
      'a preconnect to a font service',
      { pages: [hintedStart, ...defaultPages('A').slice(1)] },
      'hint',
      'Nur Verbindungsvorbereitung zu einem Schriftdienst: Google Fonts',
      'Only a connection hint to a font service: Google Fonts',
    ],
    [
      'a preconnect and an unfinished request to a font service',
      { pages: [hintedStart, ...defaultPages('A').slice(1)], requests: [css('a', failed)] },
      'hint-and-attempt',
      'Verbindungsvorbereitung oder nicht abgeschlossener Schriftabruf: Google Fonts',
      'Connection hint or unfinished font request: Google Fonts',
    ],
  ];

  it.each(CASES)('%s', (_name, input, observed, deTitle, enTitle) => {
    const [o] = observationsOf(runCheck(embed01, site({ phases: [phase('A', input)] })));
    expect(o).toMatchObject({ variant: 'preconnect-only', params: { observed } });
    const de = loadTexts('de');
    const en = loadTexts('en');
    expect(renderMessage(de, 'EMBED-01.preconnect-only', o!.params).title).toBe(deTitle);
    expect(renderMessage(en, 'EMBED-01.preconnect-only', o!.params).title).toBe(enTitle);
    const actions = [
      formatMessage(de.actions['EMBED-01.preconnect-only']!, o!.params, 'de'),
      formatMessage(en.actions['EMBED-01.preconnect-only']!, o!.params, 'en'),
    ].join('\n');
    if (observed === 'attempt') expect(actions).not.toMatch(/Verbindungsvorbereitung|connection hint/);
    else expect(actions).toMatch(/Verbindungsvorbereitung/);
  });

  it('counterexample: a preconnect to fonts.gstatic.com without a download names the font service and the link', () => {
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { pages: [hintedStart, ...defaultPages('A').slice(1)] })] }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'preconnect-only',
      subject: 'google-fonts',
      params: { embedFrameFonts: false, embedServices: null, embedCount: 0 },
    });
    expect(o?.evidence[0]).toMatchObject({
      type: 'link',
      href: 'https://fonts.gstatic.com/',
      text: 'rel=preconnect',
    });
    expect(renderMessage(loadTexts('de'), 'EMBED-01.preconnect-only', o!.params).body).toBe(
      'Zu Google Fonts wurde nur eine Verbindungsvorbereitung (preconnect/dns-prefetch) oder ein nicht ' +
        'abgeschlossener Abruf beobachtet; ein abgeschlossener Abruf von Schriftdateien wurde nicht festgestellt.',
    );
  });

  const player = {
    frameId: 'A-player',
    isMainFrame: false,
    frameUrl: 'https://www.youtube-nocookie.com/embed/abc',
  };
  /** The frames that load Google Fonts beside the hint, the variants, and the embeds the hint's text names. */
  const FRAME_CASES: Array<[string, RequestRecord[], string[], string, number]> = [
    ['the map frame', mapWithFonts('A'), ['preconnect-only', 'fonts-in-embed-frame'], 'Google Maps', 1],
    [
      'the map frame and a player frame',
      [
        ...mapWithFonts('A'),
        req('P-1', player.frameUrl, { ...player, isNavigation: true, resourceType: 'document' }),
        req('P-2', FRAME_FONT, { ...player, resourceType: 'font' }),
      ],
      ['preconnect-only', 'fonts-in-embed-frame', 'fonts-in-embed-frame'],
      'Google Maps, YouTube (youtube-nocookie.com)',
      2,
    ],
    [
      'a reCAPTCHA frame',
      frameWithFont('captcha', CAPTCHA_FRAME),
      ['preconnect-only'],
      'Google reCAPTCHA',
      1,
    ],
  ];

  it.each(FRAME_CASES)(
    "a preconnect of the site beside the fonts that %s downloads: the hint's text is about the site and names the frames",
    (_name, requests, variants, embedServices, embedCount) => {
      const pages = [hintedStart, ...defaultPages('A').slice(1)];
      const found = observationsOf(runCheck(embed01, site({ phases: [phase('A', { pages, requests })] })));
      expect(found.map((o) => o.variant)).toEqual(variants);
      const [o] = found;
      expect(o).toMatchObject({
        subject: 'google-fonts',
        params: { observed: 'hint', embedFrameFonts: true, embedServices, embedCount },
      });

      const de = renderMessage(loadTexts('de'), 'EMBED-01.preconnect-only', o!.params);
      const en = renderMessage(loadTexts('en'), 'EMBED-01.preconnect-only', o!.params);
      expect(de.title).toBe('Nur Verbindungsvorbereitung der Website zu einem Schriftdienst: Google Fonts');
      expect(en.title).toBe('Only a connection hint from the site to a font service: Google Fonts');
      const frames =
        embedCount === 1
          ? [`Der Rahmen von ${embedServices} lud`, `The frame of ${embedServices}, however,`]
          : [`Die Rahmen von ${embedServices} luden`, `The frames of ${embedServices}, however,`];
      expect(de.body).toBe(
        'Zu Google Fonts wurde außerhalb der Rahmen eingebetteter Dienste nur eine Verbindungsvorbereitung ' +
          '(preconnect/dns-prefetch) oder ein nicht abgeschlossener Abruf beobachtet; ein abgeschlossener Abruf ' +
          `von Schriftdateien wurde dort nicht festgestellt. ${frames[0]} dagegen Schriftdateien oder Stylesheets ` +
          'von Google Fonts; diese Abrufe sind nicht Teil dieses Befunds.',
      );
      expect(en.body).toBe(
        'Only a connection hint (preconnect/dns-prefetch) or an unfinished request to Google Fonts was observed ' +
          'outside the frames of embedded services; no completed download of font files was found there. ' +
          `${frames[1]} loaded font files or stylesheets of Google Fonts; those requests are not part of this ` +
          'finding.',
      );
    },
  );

  it('counterexample: a link to a font service with another rel than a connection hint is ignored', () => {
    const start = page(START, 'start', 'A', {
      dom: makeDom({ linkRels: [{ rel: 'stylesheet', href: 'https://fonts.gstatic.com/', source: 'dom' }] }),
    });
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { pages: [start, ...defaultPages('A').slice(1)] })] }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('failed requests repeated after the reject leave room for the connection hint in the evidence', () => {
    const files = (prefix: string, p: Partial<RequestRecord> = {}) =>
      Array.from({ length: 7 }, (_, i) =>
        req(`${prefix}-${i}`, `https://fonts.gstatic.com/s/roboto/v48/w${i}.woff2`, {
          resourceType: 'font',
          ...failed,
          ...p,
        }),
      );
    const [o] = observationsOf(
      runCheck(
        embed01,
        site({
          phases: [
            phase('A', { pages: [hintedStart, ...defaultPages('A').slice(1)], requests: files('a') }),
            phase('B', { click: click('reject'), requests: files('b', { phase: 'B', afterClick: true }) }),
          ],
        }),
      ),
    );
    expect(o).toMatchObject({ variant: 'preconnect-only', params: { observed: 'hint-and-attempt' } });
    expect(o?.evidence.filter((e) => e.type === 'request')).toHaveLength(7);
    expect(o?.evidence).toContainEqual(expect.objectContaining({ type: 'link', text: 'rel=preconnect' }));
  });

  it('a completed load carries no such param', () => {
    const [o] = observationsOf(runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })] })));
    expect(o?.variant).toBe('fonts-loaded');
    expect(o?.params).not.toHaveProperty('observed');
  });
});

const confirmed = rejectCmp({ confirmed: true, pages: { [CONTACT]: 'in-effect' } });

describe('EMBED-01 names where the reject was pressed', () => {
  const both = [
    phase('A', { requests: [css('a')] }),
    rejectPhase(CONTACT, [css('b', { ...AFTER_CLICK, pageUrl: CONTACT })]),
  ];
  it.each([
    ['the save of the settings layer', both, settingsRejectCmp(), 'settings', ' über die Einstellungen:'],
    ['a first-layer reject', both, confirmed, 'first-layer', 'bestätigter Ablehnung: Google Fonts'],
    [
      'counterexample: no load after the reject',
      [phase('A', { requests: [css('a')] })],
      settingsRejectCmp(),
      null,
      'Externe Schriftarten geladen: Google Fonts',
    ],
  ])('%s', (_name, phases, cmp, rejectPath, title) => {
    const [o] = observationsOf(runCheck(embed01, site({ phases, cmp })));
    expect(o).toMatchObject({ variant: 'fonts-loaded', params: { rejectPath } });
    expect(renderMessage(loadTexts('de'), 'EMBED-01.fonts-loaded', o!.params).title).toContain(title);
  });
});

describe('EMBED-01 states whether the fonts loaded before the interaction, after the reject, or both', () => {
  it.each(momentCases({ load: css, phaseA: (requests = []) => phase('A', { requests }), control: CONTACT }))(
    '%s',
    (_name, { phases, cmp, want }) => {
      expectMoment(observationsOf(runCheck(embed01, site({ phases, cmp }))), 'fonts-loaded', want);
    },
  );

  const both = [
    phase('A', { requests: [css('a')] }),
    rejectPhase(CONTACT, [css('b', { ...AFTER_CLICK, pageUrl: CONTACT })]),
  ];
  const render = (lang: 'de' | 'en', cmp: CmpSection) => {
    const [o] = observationsOf(runCheck(embed01, site({ phases: both, cmp })));
    return renderMessage(loadTexts(lang), 'EMBED-01.fonts-loaded', o!.params);
  };

  it('a confirmed reject: the body counts the pages after it', () => {
    expect(render('de', confirmed).body).toBe(
      'Schriftdateien oder Stylesheets von Google Fonts wurden von einem externen Server geladen, Zeitpunkt: vor ' +
        'einer Interaktion mit dem Einwilligungsbanner und erneut nach bestätigter Ablehnung (2 Seiten, davon 1 ' +
        'nach der Ablehnung).',
    );
  });

  it('an unconfirmed reject is named as a click on "Ablehnen" that was not confirmed', () => {
    const cmp = rejectCmp({ confirmed: false });
    expect(render('de', cmp).body).toContain('nach dem Klick auf „Ablehnen“ (Ablehnung nicht bestätigt)');
    expect(render('en', cmp).body).toContain('after the click on "Reject" (rejection not confirmed)');
  });

  it('the evidence shows the load after the confirmed reject and the reject proof, within the cap', () => {
    const files = (prefix: string, p: Partial<RequestRecord> = {}) =>
      Array.from({ length: 12 }, (_, i) =>
        req(`${prefix}-${i}`, `https://fonts.gstatic.com/s/roboto/v48/w${i}.woff2`, {
          resourceType: 'font',
          ...p,
        }),
      );
    const [o] = observationsOf(
      runCheck(
        embed01,
        site({
          phases: [phase('A', { requests: files('a') }), rejectPhase(CONTACT, files('b', AFTER_CLICK))],
          cmp: confirmed,
        }),
      ),
    );
    const evidence = o?.evidence ?? [];
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
    expect(evidence.some((e) => e.type === 'request' && e.phase === 'B' && !e.beforeClick)).toBe(true);
    expect(
      evidence.filter((e) => e.type === 'consent-state').map((e) => e.type === 'consent-state' && e.origin),
    ).toEqual(['action', 'stored']);
  });

  it('counterexample: without a load after the reject there is no reject proof', () => {
    const [o] = observationsOf(
      runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })], cmp: confirmed })),
    );
    expect(o?.evidence.filter((e) => e.type === 'consent-state')).toEqual([]);
  });
});
