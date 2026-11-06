import { describe, expect, it } from 'vitest';
import { embed03 } from '../../../../../src/checks/browser/embed-03.ts';
import { MAX_EVIDENCE } from '../../../../../src/checks/browser/evidence.ts';
import type { CmpSection } from '../../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import type { IframeFact, PhaseRecord, RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import {
  makeBrowserPlan,
  makeDom,
  makeLink,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../../utils/snapshot-builder.ts';
import {
  click,
  cmpFacts,
  cmpWith,
  footerLinks,
  page,
  phase,
  rejectCmp,
  req,
  type SiteSpec,
  START,
  site,
} from '../helpers.ts';
import { HISTORY, inPlayer, THUMBNAIL, VIDEOS, videoPages } from '../scenarios/embed-03.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['EMBED-03']!.find((s) => s.file === file)!.build();
const run = (phases: PhaseRecord[], spec: Omit<SiteSpec, 'phases'> = {}) =>
  runCheck(embed03, site({ phases, ...spec }));
const observations = (phases: PhaseRecord[], spec: Omit<SiteSpec, 'phases'> = {}) =>
  observationsOf(run(phases, spec));

const NOCOOKIE = 'https://www.youtube-nocookie.com/embed/abc123';
const player = inPlayer('A-f2', NOCOOKIE);
const playerDocument = (id = 'doc', p: Partial<RequestRecord> = {}) =>
  req(id, NOCOOKIE, { ...player, resourceType: 'document', isNavigation: true, ...p });
const image = (id: string, url: string, p: Partial<RequestRecord> = {}) =>
  req(id, url, { pageUrl: VIDEOS, resourceType: 'image', ...p });

describe('EMBED-03 external videos and thumbnails', () => {
  it('violation: a YouTube player frame on the video page → video-loaded as iframe, its document first', () => {
    const [o] = observationsOf(runCheck(embed03, scenario('violation-youtube-embed.json')));
    expect(o).toMatchObject({
      variant: 'video-loaded',
      subject: 'youtube',
      category: 'video',
      serviceId: 'youtube',
      phases: ['A'],
      pages: [VIDEOS],
      params: {
        service: 'YouTube',
        integrationType: 'iframe',
        integrations: 'iframe, other',
        pageCount: 1,
        requestCount: 2,
        moment: 'before-interaction',
        rejectConfirmed: null,
        afterRejectPageCount: 0,
        afterReject: false,
        bannerFound: false,
      },
    });
    expect(o?.evidence[0]).toMatchObject({ type: 'request', url: 'https://www.youtube.com/embed/abc123' });
  });

  it('violation: a thumbnail of the history page before the interaction and again after the confirmed reject', () => {
    const [o] = observationsOf(runCheck(embed03, scenario('violation-thumbnail-after-reject.json')));
    expect(o).toMatchObject({
      subject: 'youtube',
      phases: ['A', 'B'],
      pages: [HISTORY],
      params: {
        integrationType: 'thumbnail',
        moment: 'before-and-after-reject',
        rejectConfirmed: true,
        afterRejectPageCount: 1,
        afterReject: true,
      },
    });
    const evidence = o?.evidence ?? [];
    expect(evidence.some((e) => e.type === 'request' && e.phase === 'B' && !e.beforeClick)).toBe(true);
    expect(evidence.filter((e) => e.type === 'consent-state')).toEqual([
      expect.objectContaining({ origin: 'action', phase: 'B', page: START }),
      expect.objectContaining({ origin: 'stored', phase: 'B', page: START }),
    ]);
  });

  it('clean: a placeholder with a self-hosted preview and a channel link load nothing from a video service', () => {
    const r = runCheck(embed03, scenario('clean-local-preview.json'));
    expect(r).toMatchObject({ status: 'completed' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('inconclusive: the page chosen for its video link was behind a challenge and nothing was found', () => {
    expect(runCheck(embed03, scenario('inconclusive-video-page-blocked.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'video-page-not-evaluable',
    });
  });
});

/** Requests of phase A, and the (subject, integrationType, requestCount, frameResourceCount) of every finding. */
const GROUP_CASES: Array<[string, RequestRecord[], Array<[string, string, number, number]>]> = [
  [
    'a youtube-nocookie player that loads YouTube thumbnails, video data and a helper host is one youtube-nocookie finding',
    [
      playerDocument(),
      req('thumb', 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', { ...player, resourceType: 'image' }),
      req('video', 'https://rr1---sn-abc.googlevideo.com/videoplayback?expire=[redacted]', {
        ...player,
        resourceType: 'media',
      }),
      req('helper', 'https://player-helper.unknown-host.example/t.js', { ...player, resourceType: 'script' }),
    ],
    [['youtube-nocookie', 'iframe', 4, 1]],
  ],
  [
    'a Vimeo player that loads its thumbnail is one Vimeo iframe',
    (() => {
      const vimeo = inPlayer('A-f3', 'https://player.vimeo.com/video/123456789');
      return [
        req('doc', 'https://player.vimeo.com/video/123456789', {
          ...vimeo,
          resourceType: 'document',
          isNavigation: true,
        }),
        req('thumb', 'https://i.vimeocdn.com/video/123456789-abc_640', { ...vimeo, resourceType: 'image' }),
      ];
    })(),
    [['vimeo', 'iframe', 2, 0]],
  ],
  [
    'a thumbnail from img.youtube.com on the page itself is a thumbnail',
    [image('img', 'https://img.youtube.com/vi/abc123/0.jpg')],
    [['youtube', 'thumbnail', 1, 0]],
  ],
  [
    'beacon images of youtube-nocookie alone are video content, no thumbnail',
    [
      image('a', 'https://www.youtube-nocookie.com/generate_204?abc'),
      image('b', 'https://www.youtube-nocookie.com/generate_204?def'),
    ],
    [['youtube-nocookie', 'other', 2, 0]],
  ],
  [
    'a thumbnail on the page next to a youtube-nocookie player stays YouTube',
    [playerDocument(), image('thumb', THUMBNAIL)],
    [
      ['youtube', 'thumbnail', 1, 0],
      ['youtube-nocookie', 'iframe', 1, 0],
    ],
  ],
  [
    'an ad frame that loads the YouTube player API attaches nothing of its own to YouTube',
    (() => {
      const ad = inPlayer('A-f8', 'https://googleads.g.doubleclick.net/pagead/ads?client=[redacted]');
      return [
        req('api', 'https://www.youtube.com/iframe_api', { ...ad, resourceType: 'script' }),
        req('helper', 'https://cdn.other-site.de/x.js', { ...ad, resourceType: 'script' }),
        req('font', 'https://fonts.gstatic.com/s/inter/v1/a.woff2', { ...ad, resourceType: 'font' }),
      ];
    })(),
    [['youtube', 'js-api', 1, 0]],
  ],
  [
    'a frame of the site that redirects to a youtube-nocookie player is one youtube-nocookie finding',
    [
      req('hop', `${VIDEOS}/player`, {
        ...inPlayer('A-f2', `${VIDEOS}/player`),
        resourceType: 'document',
        isNavigation: true,
        status: 302,
      }),
      playerDocument('doc', { initiator: { type: 'redirect', url: `${VIDEOS}/player` } }),
      req('thumb', 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', { ...player, resourceType: 'image' }),
    ],
    [['youtube-nocookie', 'iframe', 2, 0]],
  ],
];

describe('EMBED-03 groups the requests by the video embed that made them', () => {
  it.each(GROUP_CASES)('%s', (_name, requests, want) => {
    const found = observations([phase('A', { pages: videoPages(), requests })]);
    expect(
      found.map((o) => [
        o.subject,
        o.params.integrationType,
        o.params.requestCount,
        o.params.frameResourceCount,
      ]),
    ).toEqual(want);
  });

  it('a late player beacon recorded with the next page belongs to the page of its frame', () => {
    const beacon = req('beacon', 'https://www.youtube-nocookie.com/youtubei/v1/log_event?alt=json', {
      ...player,
      pageUrl: START,
      resourceType: 'ping',
    });
    const [o] = observations([phase('A', { pages: videoPages(), requests: [playerDocument(), beacon] })]);
    expect(o).toMatchObject({ subject: 'youtube-nocookie', pages: [VIDEOS], params: { pageCount: 1 } });
  });

  it('a player beacon after the reject counts the page of its frame, where the reject is in effect', () => {
    const frameB = inPlayer('B-f2', NOCOOKIE);
    const b = (id: string, p: Partial<RequestRecord>) => req(id, NOCOOKIE, { ...frameB, phase: 'B', ...p });
    const [o] = observations(
      [
        phase('A', { pages: videoPages(), requests: [playerDocument()] }),
        phase('B', {
          click: click('reject'),
          reloaded: true,
          pages: [
            page(START, 'start', 'B'),
            page(START, 'start', 'B', { reload: true }),
            page(VIDEOS, 'nav', 'B'),
          ],
          requests: [
            b('B-doc', { resourceType: 'document', isNavigation: true, afterClick: true }),
            b('B-beacon', {
              url: 'https://www.youtube-nocookie.com/youtubei/v1/log_event?alt=json',
              resourceType: 'ping',
              afterClick: true,
              pageUrl: `${START}kontakt-next`,
            }),
          ],
        }),
      ],
      { cmp: rejectCmp({ confirmed: true, pages: { [VIDEOS]: 'in-effect' } }) },
    );
    expect(o).toMatchObject({
      pages: [VIDEOS],
      params: { moment: 'before-and-after-reject', rejectConfirmed: true, afterRejectPageCount: 1 },
    });
  });
});

const failed = {
  state: 'failed',
  status: undefined,
  delivery: 'sent',
  result: { kind: 'failed', errorText: 'net::ERR_FAILED' },
} as const;

/** Phases that give no finding although a video service appears in them. */
const NO_LOAD_CASES: Array<[string, PhaseRecord[]]> = [
  [
    'the thumbnail loads only after the accept',
    [
      phase('A', { pages: videoPages() }),
      phase('C', {
        click: click('accept'),
        requests: [image('c', THUMBNAIL, { phase: 'C', afterClick: true })],
      }),
    ],
  ],
  [
    'a failed thumbnail request',
    [phase('A', { pages: videoPages(), requests: [image('a', THUMBNAIL, failed)] })],
  ],
  [
    'a thumbnail request that never left the browser',
    [
      phase('A', {
        pages: videoPages(),
        requests: [
          image('a', THUMBNAIL, {
            state: 'attempted',
            status: undefined,
            delivery: 'attempted',
            result: { kind: 'none' },
          }),
        ],
      }),
    ],
  ],
  [
    'a thumbnail answered from the HTTP cache',
    [
      phase('A', {
        pages: videoPages(),
        requests: [image('a', THUMBNAIL, { state: 'from-cache', provenance: 'http-cache' })],
      }),
    ],
  ],
  [
    'a thumbnail answered by a service worker',
    [
      phase('A', {
        pages: videoPages(),
        requests: [image('a', THUMBNAIL, { state: 'from-sw', provenance: 'service-worker' })],
      }),
    ],
  ],
  [
    'a plain link to a YouTube video',
    [
      phase('A', {
        pages: videoPages(VIDEOS, {
          dom: makeDom({
            links: [
              ...footerLinks(),
              makeLink({
                text: 'Video ansehen',
                href: 'https://www.youtube.com/watch?v=abc123',
                region: 'main',
              }),
            ],
          }),
        }),
      }),
    ],
  ],
];

describe('EMBED-03 reports only videos that were delivered before the accept', () => {
  it.each(NO_LOAD_CASES)('counterexample: %s', (_name, phases) => {
    expect(run(phases)).toMatchObject({ status: 'completed' });
    expect(observations(phases)).toEqual([]);
  });

  it('counterexample: a direct bot signal of the CMP → inconclusive, no finding', () => {
    const r = run([phase('A', { pages: videoPages(), requests: [image('a', THUMBNAIL)] })], {
      cmp: cmpWith({
        phase: 'A',
        facts: [cmpFacts({ phase: 'A', botSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] })],
      }),
    });
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('counterexample: no phase A → inconclusive', () => {
    expect(run([phase('A', { status: 'skipped', pages: [] })])).toMatchObject({
      status: 'inconclusive',
      reason: 'no-network-observation',
    });
  });

  it('a video page behind a challenge with a video elsewhere: the finding, and the page as a limitation', () => {
    const r = run(
      [
        phase('A', {
          pages: videoPages(VIDEOS, { evaluable: false, notEvaluableReason: 'challenge' }),
          requests: [image('a', THUMBNAIL, { pageUrl: START })],
        }),
      ],
      {
        plan: makeBrowserPlan({
          pages: [{ url: VIDEOS, role: 'nav', order: 4, reasons: ['keyword:video'], source: 'link' }],
        }),
      },
    );
    expect(r).toMatchObject({ status: 'completed', outcome: { limitations: ['video-page-not-evaluable'] } });
    expect(variantsOf(r)).toEqual(['video-loaded']);
  });

  it('counterexample: a blocked page chosen for another keyword is no video page', () => {
    const r = run(
      [phase('A', { pages: videoPages(VIDEOS, { evaluable: false, notEvaluableReason: 'challenge' }) })],
      {
        plan: makeBrowserPlan({
          pages: [{ url: VIDEOS, role: 'nav', order: 4, reasons: ['keyword:karriere'], source: 'link' }],
        }),
      },
    );
    expect(r).toMatchObject({ status: 'completed', outcome: { limitations: [] } });
  });
});

describe('EMBED-03 names video frames of a page that loaded nothing', () => {
  const frame = (src: string, p: Partial<IframeFact> = {}): IframeFact => ({
    src,
    srcdoc: false,
    visible: true,
    depth: 1,
    loading: 'lazy',
    ...p,
  });
  const withFrames = (iframes: IframeFact[]) =>
    videoPages(VIDEOS, { dom: makeDom({ links: footerLinks(), iframes }) });

  it('a youtube-nocookie frame in the DOM without any request: no finding, the frame as a limitation', () => {
    const r = run([phase('A', { pages: withFrames([frame(NOCOOKIE)]) })]);
    expect(r).toMatchObject({ status: 'completed', outcome: { limitations: ['video-embed-not-loaded'] } });
    expect(variantsOf(r)).toEqual([]);
  });

  it.each([
    ['its player was requested', [playerDocument()]],
    ['its player request failed', [playerDocument('doc', failed)]],
  ])('counterexample: a video frame whose %s is no frame without a request', (_name, requests) => {
    const r = run([phase('A', { pages: withFrames([frame(NOCOOKIE)]), requests })]);
    expect(r.outcome?.limitations ?? []).not.toContain('video-embed-not-loaded');
  });

  it('counterexample: a frame of another category or of the site itself is no video frame', () => {
    const r = run([
      phase('A', {
        pages: withFrames([
          frame('https://www.google.com/maps/embed?pb=[redacted]'),
          frame('https://www.example.de/player.html'),
        ]),
      }),
    ]);
    expect(r.outcome?.limitations ?? []).toEqual([]);
  });
});

const THUMB_B = (id: string, p: Partial<RequestRecord> = {}) =>
  image(id, THUMBNAIL, { pageUrl: HISTORY, phase: 'B', afterClick: true, ...p });
/** Phase B of a reject on the start page: the start page, its reload and the history page as the control page. */
const rejectPhase = (requests: RequestRecord[]) =>
  phase('B', {
    click: click('reject'),
    reloaded: true,
    pages: [
      page(START, 'start', 'B'),
      page(START, 'start', 'B', { reload: true }),
      page(HISTORY, 'nav', 'B'),
    ],
    requests,
  });
const historyA = (requests: RequestRecord[] = []) =>
  phase('A', { pages: videoPages(HISTORY), requests: requests.map((r) => ({ ...r, pageUrl: HISTORY })) });
const confirmed = rejectCmp({ confirmed: true, pages: { [HISTORY]: 'in-effect' } });

const MOMENT_CASES: Array<[string, PhaseRecord[], CmpSection, Record<string, unknown>]> = [
  [
    'only after the confirmed reject',
    [historyA(), rejectPhase([THUMB_B('b')])],
    confirmed,
    { moment: 'after-reject', rejectConfirmed: true, afterRejectPageCount: 1, afterReject: true },
  ],
  [
    'counterexample: phase B before its click stays before the interaction',
    [historyA(), rejectPhase([THUMB_B('b', { afterClick: false })])],
    confirmed,
    { moment: 'before-interaction', rejectConfirmed: null, afterRejectPageCount: 0, afterReject: false },
  ],
  [
    'a reject the CMP state did not confirm',
    [historyA([image('a', THUMBNAIL)]), rejectPhase([THUMB_B('b')])],
    rejectCmp({ confirmed: false }),
    { moment: 'before-and-after-reject', rejectConfirmed: false, afterRejectPageCount: 1, afterReject: true },
  ],
  [
    'loads after the reject only on a page that shows the banner again do not confirm it',
    [historyA([image('a', THUMBNAIL)]), rejectPhase([THUMB_B('b')])],
    rejectCmp({ confirmed: true, pages: { [HISTORY]: 'banner-again' } }),
    { moment: 'before-and-after-reject', rejectConfirmed: false, afterRejectPageCount: 0, afterReject: true },
  ],
];

describe('EMBED-03 states whether the video loaded before the interaction, after the reject, or both', () => {
  it.each(MOMENT_CASES)('%s', (_name, phases, cmp, want) => {
    const found = observations(phases, { cmp });
    expect(found).toHaveLength(1);
    expect(found[0]?.params).toMatchObject(want);
  });

  const render = (lang: 'de' | 'en', phases: PhaseRecord[], cmp: CmpSection) => {
    const [o] = observations(phases, { cmp });
    return renderMessage(loadTexts(lang), 'EMBED-03.video-loaded', o!.params);
  };
  const both = [historyA([image('a', THUMBNAIL)]), rejectPhase([THUMB_B('b')])];

  it('a thumbnail after the confirmed reject: the title says "also after the confirmed rejection"', () => {
    expect(render('de', both, confirmed)).toMatchObject({
      title: 'Externer Videodienst geladen, auch nach bestätigter Ablehnung: YouTube',
      body:
        'Ein externer Videodienst von YouTube wurde als Vorschaubild ohne Player geladen, Zeitpunkt: vor einer ' +
        'Interaktion mit dem Einwilligungsbanner und erneut nach bestätigter Ablehnung (1 Seite, davon 1 nach der ' +
        'Ablehnung).',
    });
    expect(render('en', both, confirmed)).toMatchObject({
      title: 'External video service loaded, also after confirmed rejection: YouTube',
      body:
        'An external video service of YouTube was loaded as a thumbnail image without a player, timing: before any ' +
        'interaction with the consent banner and again after confirmed rejection (1 page, 1 of them after the ' +
        'rejection).',
    });
  });

  it('an unconfirmed reject is named as a click on "Ablehnen" that was not confirmed', () => {
    const cmp = rejectCmp({ confirmed: false });
    expect(render('de', both, cmp).title).toBe('Externer Videodienst geladen, auch nach Ablehnung: YouTube');
    expect(render('de', both, cmp).body).toContain(
      'und erneut nach dem Klick auf „Ablehnen“ (Ablehnung nicht bestätigt)',
    );
    expect(render('en', both, cmp).body).toContain(
      'and again after the click on "Reject" (rejection not confirmed)',
    );
  });

  it('the action serves thumbnails from the site, or loads the player after a click; a mixed summary names the player', () => {
    const action = (lang: 'de' | 'en', integrationType: string) =>
      formatMessage(
        loadTexts(lang).actions['EMBED-03.video-loaded']!,
        { service: 'YouTube', integrationType },
        lang,
      );
    expect(action('de', 'thumbnail')).toBe(
      'Liefern Sie Vorschaubilder von YouTube vom eigenen Server aus oder laden Sie sie erst nach einer Einwilligung.',
    );
    expect(action('de', 'iframe')).toBe(
      'Laden Sie den Player von YouTube erst nach einem Klick der Besucher oder nach einer Einwilligung.',
    );
    expect(action('de', 'iframe, thumbnail')).toBe(action('de', 'iframe'));
    expect(action('en', 'thumbnail')).toBe(
      'Serve the thumbnails of YouTube from your own server or load them only after consent.',
    );
    expect(action('en', 'js-api')).toBe(
      'Load the player of YouTube only after visitors click on it or after consent.',
    );
  });
});

describe('EMBED-03 evidence', () => {
  it('12 video chunks before the interaction and the same after the confirmed reject: B requests and the reject proof', () => {
    const chunks = (prefix: string, p: Partial<RequestRecord> = {}) =>
      Array.from({ length: 12 }, (_, i) =>
        image(`${prefix}-${i}`, `https://i.ytimg.com/vi/abc123/frame-${i}.jpg`, { pageUrl: HISTORY, ...p }),
      );
    const [o] = observations(
      [historyA(chunks('a')), rejectPhase(chunks('b', { phase: 'B', afterClick: true }))],
      {
        cmp: confirmed,
      },
    );
    const evidence = o?.evidence ?? [];
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
    expect(
      evidence.filter((e) => e.type === 'request' && e.phase === 'B' && !e.beforeClick).length,
    ).toBeGreaterThanOrEqual(1);
    expect(evidence.filter((e) => e.type === 'consent-state')).toHaveLength(2);
  });

  it('the fonts of the player frame are named in the finding and one of them reaches the evidence behind many requests', () => {
    const chunks = Array.from({ length: 12 }, (_, i) =>
      req(`c-${i}`, `https://rr1---sn-abc.googlevideo.com/videoplayback?part=${i}`, {
        ...player,
        resourceType: 'media',
      }),
    );
    const font = req('font', 'https://fonts.gstatic.com/s/roboto/v48/a.woff2', {
      ...player,
      resourceType: 'font',
    });
    const [o] = observations([
      phase('A', { pages: videoPages(), requests: [playerDocument(), ...chunks, font] }),
    ]);
    expect(o?.params).toMatchObject({
      frameFontServices: 'Google Fonts',
      frameFontRequestCount: 1,
      frameResourceCount: 1,
    });
    const evidence = o?.evidence ?? [];
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
    expect(evidence[0]).toMatchObject({ url: NOCOOKIE });
    expect(evidence.some((e) => e.type === 'request' && e.url === font.url)).toBe(true);
    expect(renderMessage(loadTexts('de'), 'EMBED-03.video-loaded', o!.params).body).toContain(
      ' Der Videoplayer lud dabei Schriften von Google Fonts (1 Anfrage).',
    );
    expect(renderMessage(loadTexts('en'), 'EMBED-03.video-loaded', o!.params).body).toContain(
      ' The video player also loaded fonts from Google Fonts (1 request).',
    );
  });
});
