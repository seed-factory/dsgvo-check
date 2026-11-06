import { describe, expect, it } from 'vitest';
import { embed01 } from '../../../../../src/checks/browser/embed-01.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import type { PhaseRecord } from '../../../../../src/core/snapshot/browser.ts';
import { makeDom, observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import { click, cmpFacts, cmpWith, defaultPages, page, phase, req, START, site } from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

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

  it('clean: self-hosted fonts', () => {
    expect(variantsOf(runCheck(embed01, scenario('clean-self-hosted.json')))).toEqual([]);
  });

  it('inconclusive: no phase A', () => {
    expect(runCheck(embed01, scenario('inconclusive-no-network.json'))).toMatchObject({
      status: 'inconclusive',
    });
  });

  it('counterexample: preconnect to fonts.gstatic.com without a download → preconnect-only (info), not warning', () => {
    const start = page(START, 'start', 'A', {
      dom: makeDom({ linkRels: [{ rel: 'preconnect', href: 'https://fonts.gstatic.com/', source: 'dom' }] }),
    });
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { pages: [start, ...defaultPages('A').slice(1)] })] }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({ variant: 'preconnect-only', subject: 'google-fonts' });
    expect(o?.evidence[0]).toMatchObject({
      type: 'link',
      href: 'https://fonts.gstatic.com/',
      text: 'rel=preconnect',
    });
  });

  it('counterexample: an unfinished font request is not a load', () => {
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { requests: [css('a', { state: 'failed', status: undefined })] })] }),
    );
    expect(variantsOf(r)).toEqual(['preconnect-only']);
  });

  it('a load after the reject stays fonts-loaded; a load only after accept is no finding', () => {
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
    const afterAccept = runCheck(
      embed01,
      site({
        phases: [
          phase('A'),
          phase('C', { click: click('accept'), requests: [css('c', { phase: 'C', afterClick: true })] }),
        ],
      }),
    );
    expect(variantsOf(afterAccept)).toEqual([]);
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

  it('bot signal → inconclusive', () => {
    const r = runCheck(
      embed01,
      site({
        phases: [phase('A', { requests: [css('a')] })],
        cmp: cmpWith({
          phase: 'A',
          facts: [
            cmpFacts({ phase: 'A', botSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] }),
          ],
        }),
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
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

  it('counterexample: the fonts of an embedded player belong to the embed, not to the site', () => {
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
    expect(variantsOf(r)).toEqual([]);
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

  it('a completed load carries no such param', () => {
    const [o] = observationsOf(runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })] })));
    expect(o?.variant).toBe('fonts-loaded');
    expect(o?.params).not.toHaveProperty('observed');
  });
});
