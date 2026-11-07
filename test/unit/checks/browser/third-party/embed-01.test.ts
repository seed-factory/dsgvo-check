import { describe, expect, it } from 'vitest';
import { embed01 } from '../../../../../src/checks/browser/embed-01.ts';
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
  page,
  phase,
  rejectCmp,
  req,
  START,
  settingsRejectCmp,
  site,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';
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
    if (observed === 'hint') {
      expect(o?.subject).toBe('google-fonts');
      expect(o?.evidence[0]).toMatchObject({
        type: 'link',
        href: 'https://fonts.gstatic.com/',
        text: 'rel=preconnect',
      });
    }
  });

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
