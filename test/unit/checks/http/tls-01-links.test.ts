import { describe, expect, it } from 'vitest';
import { tls01 } from '../../../../src/checks/http/tls-01.ts';
import { loadRuleset, loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage } from '../../../../src/core/data/messages.ts';
import type { LinkFact, PageVisit, PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import type { HttpHop, RedirectChain } from '../../../../src/core/snapshot/http.ts';
import type { Snapshot } from '../../../../src/core/snapshot/index.ts';
import {
  makeBrowser,
  makeDom,
  makeHttp,
  makeLink,
  makePage,
  makePhase,
  makeSnapshot,
  makeTarget,
  observationsOf,
  runCheck,
  variantsOf,
} from '../../../utils/snapshot-builder.ts';
import { BIG, chain } from './tls-01-fixtures.ts';

describe('TLS-01 same-site links to http', () => {
  const SITE = 'https://www.example.test/';
  const HSTS = { name: 'strict-transport-security', value: 'max-age=31536000' };

  /** http and https chains of a host variant; `http` decides what its plain-http root does. */
  const wwwUpgraded = (headers: HttpHop['headers'] = []) => [
    chain(
      'http://www.example.test/',
      [
        { status: 301, location: 'https://www.example.test/' },
        { url: 'https://www.example.test/', status: 200, bodyBytes: BIG, tlsAuthorized: true, headers },
      ],
      { hostVariant: 'target' },
    ),
    chain('https://www.example.test/', [{ status: 200, bodyBytes: BIG, tlsAuthorized: true, headers }]),
  ];
  const wwwServed = () => [
    chain('http://www.example.test/', [{ status: 200, bodyBytes: 50_000, bodyKind: 'html' }]),
    chain('https://www.example.test/', [{ status: 200, bodyBytes: BIG, tlsAuthorized: true }]),
  ];
  const apexClosed = () =>
    chain('http://example.test/', [], { hostVariant: 'apex', outcome: 'connection-refused' });

  const link = (href: string | null, p: Partial<LinkFact> = {}): LinkFact =>
    makeLink({ text: 'Startseite', href, hrefKind: 'http', sameSite: true, region: 'nav', ...p });
  const visit = (url: string, links: LinkFact[], p: Partial<PageVisit> = {}): PageVisit =>
    makePage({ url, phase: 'A', role: url === SITE ? 'start' : 'other', dom: makeDom({ links }), ...p });

  /** A scan of `site` (SITE): the chains, then the apex chain (port 80 closed unless given, null for none). */
  function scanWithLinks(
    chains: RedirectChain[],
    phases: PhaseRecord[] | null,
    o: { collection?: Partial<Snapshot['collection']>; apex?: RedirectChain | null; site?: string } = {},
  ) {
    const apex = o.apex === undefined ? apexClosed() : o.apex;
    return runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget(o.site ?? SITE),
        http: makeHttp({ chains: [...chains, ...(apex ? [apex] : [])] }),
        ...(phases ? { browser: makeBrowser({ phases }) } : {}),
        collection: o.collection ?? {},
      }),
    );
  }
  const phaseA = (...pages: PageVisit[]) => [makePhase('A', { pages })];
  const linksOnStart = (...links: LinkFact[]) => phaseA(visit(SITE, links));
  const linkObservations = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r).filter((o) => o.variant.startsWith('internal-http-link'));

  it('a visible nav link to an http subdomain the scan did not probe → internal-http-link, medium', () => {
    const r = scanWithLinks(wwwUpgraded([HSTS]), linksOnStart(link('http://work.example.test/')));
    expect(r.status).toBe('completed');
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({
        variant: 'internal-http-link',
        confidence: 'medium',
        subject: 'http-link:work',
        phases: ['A'],
        pages: [SITE],
        params: expect.objectContaining({
          host: 'work.example.test',
          href: 'http://work.example.test/',
          text: 'Startseite',
          httpState: 'not-probed',
          count: 1,
          links: 1,
          visible: 'yes',
        }),
      }),
    ]);
    const evidence = linkObservations(r)[0]?.evidence ?? [];
    expect(evidence).toEqual([
      {
        type: 'link',
        phase: 'A',
        page: SITE,
        href: 'http://work.example.test/',
        text: 'Startseite',
        region: 'nav',
        visible: true,
      },
    ]);
  });

  it('hidden banner links to a host that serves http content → one internal-http-link, high, both pages', () => {
    const banner = (path: string, text: string) =>
      link(`http://www.example.test/${path}`, { text, region: 'banner', visible: false });
    const legal = [banner('impressum', 'Impressum'), banner('datenschutz', 'Datenschutz')];
    const r = scanWithLinks(
      wwwServed(),
      phaseA(visit(SITE, legal), visit('https://www.example.test/kontakt', legal, { order: 1 })),
    );
    const links = linkObservations(r);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      variant: 'internal-http-link',
      confidence: 'high',
      subject: 'http-link:www',
      pages: [SITE, 'https://www.example.test/kontakt'],
      params: { host: 'www.example.test', httpState: 'served', count: 2, links: 2, visible: 'no' },
    });
    // the probe of the host comes first: the per-finding evidence cap never drops it
    expect(links[0]?.evidence.map((e) => e.type)).toEqual(['redirect-chain', 'link', 'link']);
    // the entry finding of the same host stays as it was
    expect(variantsOf(r)).toEqual(['internal-http-link', 'no-redirect']);
  });

  it.each<[string, Partial<HttpHop>, string, string]>([
    ['a stub of at most 1 KiB', { bodyBytes: 300 }, 'medium', 'unknown'],
    ['a stub cut at the read limit', { bodyBytes: 300, bodyTruncated: true }, 'high', 'served'],
    ['a page of content', { bodyBytes: 50_000 }, 'high', 'served'],
  ])(
    'a link to a host whose http root answers 200 with %s: internal-http-link of its confidence and state',
    (_n, hop, confidence, httpState) => {
      const root = chain('http://www.example.test/', [{ status: 200, bodyKind: 'html', ...hop }]);
      const r = scanWithLinks(
        [root, wwwServed()[1]!],
        linksOnStart(link('http://www.example.test/impressum')),
      );
      expect(linkObservations(r)).toEqual([
        expect.objectContaining({
          variant: 'internal-http-link',
          confidence,
          params: expect.objectContaining({ httpState }),
        }),
      ]);
    },
  );

  it('a link to a host that redirects to https without HSTS → internal-http-link-upgraded', () => {
    const r = scanWithLinks(
      wwwUpgraded(),
      linksOnStart(link('http://www.example.test/produkte', { text: 'Produkte' })),
    );
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({
        variant: 'internal-http-link-upgraded',
        confidence: 'high',
        subject: 'http-link:www',
        params: expect.objectContaining({
          host: 'www.example.test',
          location: 'https://www.example.test/',
          hstsHost: 'www.example.test',
        }),
      }),
    ]);
    expect(linkObservations(r)[0]?.evidence.map((e) => e.type)).toEqual(['redirect-chain', 'link']);
  });

  it.each(['max-age=0', 'max-age=31536000; max-age=0'])(
    'a header without effect (%s) is no HSTS: the upgraded link is still reported',
    (value) => {
      const r = scanWithLinks(
        wwwUpgraded([{ name: 'strict-transport-security', value }]),
        linksOnStart(link('http://www.example.test/produkte')),
      );
      expect(linkObservations(r).map((o) => o.variant)).toEqual(['internal-http-link-upgraded']);
    },
  );

  it('counterexample: HSTS repeating a directive the browser ignores (preload) is in force: no link finding', () => {
    const r = scanWithLinks(
      wwwUpgraded([{ name: 'strict-transport-security', value: 'max-age=31536000; preload; preload' }]),
      linksOnStart(link('http://www.example.test/produkte')),
    );
    expect(linkObservations(r)).toEqual([]);
  });

  it('HSTS of the linked host outside the redirect the link takes protects nothing: still upgraded', () => {
    const toApex = chain(
      'http://www.example.test/',
      [
        { status: 301, location: 'https://example.test/' },
        { url: 'https://example.test/', status: 200, bodyBytes: BIG, tlsAuthorized: true },
      ],
      { hostVariant: 'target' },
    );
    const wwwHttps = chain('https://www.example.test/', [
      { status: 200, bodyBytes: BIG, tlsAuthorized: true, headers: [HSTS] },
    ]);
    const r = scanWithLinks([toApex, wwwHttps], linksOnStart(link('http://www.example.test/produkte')));
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({
        variant: 'internal-http-link-upgraded',
        params: expect.objectContaining({ location: 'https://example.test/', hstsHost: 'example.test' }),
      }),
    ]);
    // The text names the host whose https answer was on the way, not the linked one that sent HSTS elsewhere.
    const params = linkObservations(r)[0]!.params;
    for (const [lang, wrong] of [
      ['de', 'https-Antworten von www.example.test'],
      ['en', 'https responses of www.example.test'],
    ] as const) {
      const t = loadTexts(lang);
      const body = formatMessage(t.messages['TLS-01.internal-http-link-upgraded']!.body, params, lang);
      const action = formatMessage(t.actions['TLS-01.internal-http-link-upgraded']!, params, lang);
      expect(body).toContain('example.test');
      expect(body).not.toContain(wrong);
      expect(action).toContain('example.test');
      expect(action).not.toContain('www.example.test');
    }
  });

  it('a probe cut on an https redirect back to http is no upgrade → internal-http-link, medium (unknown)', () => {
    const backToHttp = chain(
      'http://www.example.test/',
      [
        { status: 301, location: 'https://www.example.test/' },
        {
          url: 'https://www.example.test/',
          status: 302,
          location: 'http://www.example.test/next',
          tlsAuthorized: true,
          headers: [HSTS],
        },
      ],
      { hostVariant: 'target', outcome: 'timeout' },
    );
    const r = scanWithLinks(
      [backToHttp, ...wwwUpgraded([HSTS]).slice(1)],
      linksOnStart(link('http://www.example.test/produkte')),
    );
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({
        variant: 'internal-http-link',
        confidence: 'medium',
        params: expect.objectContaining({ httpState: 'unknown' }),
      }),
    ]);
  });

  it('HSTS on an IP address has no effect in browsers: the upgraded link to it is reported', () => {
    const ip = 'https://192.0.2.1/';
    const chains = [
      chain('http://192.0.2.1/', [
        { status: 301, location: ip },
        { url: ip, status: 200, bodyBytes: BIG, tlsAuthorized: true, headers: [HSTS] },
      ]),
      chain(ip, [{ status: 200, bodyBytes: BIG, tlsAuthorized: true, headers: [HSTS] }]),
    ];
    const r = scanWithLinks(chains, phaseA(visit(ip, [link('http://192.0.2.1/legal')])), {
      site: ip,
      apex: null,
    });
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({ variant: 'internal-http-link-upgraded', subject: 'http-link:@' }),
    ]);
  });

  it('a link to a host whose http probe timed out → internal-http-link, medium (unknown)', () => {
    const apex = chain('http://example.test/', [], { hostVariant: 'apex', outcome: 'timeout' });
    const r = scanWithLinks(wwwUpgraded([HSTS]), linksOnStart(link('http://example.test/')), {
      apex,
    });
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({
        variant: 'internal-http-link',
        confidence: 'medium',
        subject: 'http-link:@',
        params: expect.objectContaining({ httpState: 'unknown' }),
      }),
    ]);
  });

  it('the pages of a host are counted once and the visible, most prominent link speaks for it', () => {
    const r = scanWithLinks(
      wwwUpgraded([HSTS]),
      phaseA(
        visit(SITE, [
          link('http://work.example.test/a', { text: 'Versteckt', region: 'banner', visible: false }),
          link('http://work.example.test/', { text: 'Startseite', region: 'nav' }),
          link('http://work.example.test/', { text: 'Startseite', region: 'nav' }),
        ]),
        visit('https://www.example.test/b', [link('http://work.example.test/')], { order: 1 }),
      ),
    );
    const [o] = linkObservations(r);
    expect(o?.params).toMatchObject({
      href: 'http://work.example.test/',
      text: 'Startseite',
      count: 2,
      links: 2,
    });
    expect(o?.params.visible).toBe('yes');
    expect(o?.evidence).toHaveLength(2);
  });

  it('a link inside a same-site frame counts like one in the page', () => {
    const r = scanWithLinks(
      wwwUpgraded([HSTS]),
      phaseA(
        visit(SITE, [link('http://work.example.test/', { frameUrl: 'https://www.example.test/frame' })]),
      ),
    );
    expect(linkObservations(r).map((o) => o.variant)).toEqual(['internal-http-link']);
  });

  it.each<[string, () => ReturnType<typeof scanWithLinks>]>([
    [
      'an external http link',
      () => scanWithLinks(wwwServed(), linksOnStart(link('http://other.test/', { sameSite: false }))),
    ],
    [
      'a look-alike host that only starts with the site name',
      () =>
        scanWithLinks(
          wwwServed(),
          linksOnStart(link('http://example.test.other.test/', { sameSite: false })),
        ),
    ],
    [
      'mailto, javascript and fragment links',
      () =>
        scanWithLinks(
          wwwServed(),
          phaseA(
            visit(SITE, [
              link(null, { hrefKind: 'mailto' }),
              link(null, { hrefKind: 'javascript' }),
              link(null, { hrefKind: 'fragment' }),
            ]),
          ),
        ),
    ],
    [
      'a link inside a cross-site frame',
      () =>
        scanWithLinks(
          wwwServed(),
          linksOnStart(link('http://www.example.test/', { frameUrl: 'https://other.test/embed' })),
        ),
    ],
    [
      'a link to a host that redirects to https with a valid HSTS header',
      () => scanWithLinks(wwwUpgraded([HSTS]), linksOnStart(link('http://www.example.test/produkte'))),
    ],
    [
      'a link to a host that redirects to https of another host with a valid HSTS header',
      () =>
        scanWithLinks(wwwUpgraded([HSTS]), linksOnStart(link('http://example.test/legal')), {
          apex: chain(
            'http://example.test/',
            [
              { status: 301, location: SITE },
              { url: SITE, status: 200, bodyBytes: BIG, tlsAuthorized: true, headers: [HSTS] },
            ],
            { hostVariant: 'apex' },
          ),
        }),
    ],
    [
      'a link to a host whose http port is closed',
      () => scanWithLinks(wwwUpgraded([HSTS]), linksOnStart(link('http://example.test/'))),
    ],
    [
      'a link on a page that is itself served over http',
      () =>
        scanWithLinks(
          wwwUpgraded([HSTS]),
          phaseA(visit('http://www.example.test/alt', [link('http://work.example.test/')])),
        ),
    ],
    [
      'a link on a page that could not be evaluated (challenge)',
      () =>
        scanWithLinks(
          wwwUpgraded([HSTS]),
          phaseA(
            visit(SITE, []),
            visit('https://www.example.test/b', [link('http://work.example.test/')], {
              order: 1,
              evaluable: false,
              notEvaluableReason: 'challenge',
            }),
          ),
        ),
    ],
    [
      'a protocol-relative link resolved on an https page',
      () =>
        scanWithLinks(wwwServed(), linksOnStart(link('https://www.example.test/', { hrefKind: 'https' }))),
    ],
  ])('counterexample: %s gives no link finding', (_name, scan) => {
    const r = scan();
    expect(linkObservations(r)).toEqual([]);
    expect(r.outcome?.limitations ?? []).not.toContain('page-links-not-observed');
  });

  it('repeats in phases B and C add nothing: one observation with the phase A pages', () => {
    const work = link('http://work.example.test/');
    const r = scanWithLinks(wwwUpgraded([HSTS]), [
      makePhase('A', { pages: [visit(SITE, [work])] }),
      makePhase('B', {
        pages: [
          visit(SITE, [work], { phase: 'B' }),
          visit('https://www.example.test/b', [work], { phase: 'B' }),
        ],
      }),
      makePhase('C', { pages: [visit(SITE, [work], { phase: 'C' })] }),
    ]);
    expect(linkObservations(r)).toHaveLength(1);
    expect(linkObservations(r)[0]).toMatchObject({ phases: ['A'], pages: [SITE] });
  });

  it.each<[string, Partial<Snapshot['collection']>]>([
    ['skipped as tls-blocked', { browser: { status: 'skipped', reason: 'tls-blocked', durationMs: 0 } }],
    ['failed', { browser: { status: 'error', durationMs: 0 } }],
  ])(
    'browser %s: partial with page-links-not-observed, the http entries still evaluated',
    (_n, collection) => {
      const r = scanWithLinks(wwwServed(), null, { collection });
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toContain('page-links-not-observed');
      expect(variantsOf(r)).toEqual(['no-redirect']);
    },
  );

  it('browser ran but phase A has no evaluable page: partial with page-links-not-observed', () => {
    const r = scanWithLinks(
      wwwUpgraded([HSTS]),
      phaseA(visit(SITE, [link('http://work.example.test/')], { evaluable: false, dom: null })),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['page-links-not-observed']);
  });

  it('browser not selected (--checks TLS-01): no limitation, completed', () => {
    const r = scanWithLinks(wwwUpgraded([HSTS]), null, {
      collection: { browser: { status: 'not-run', reason: 'not-required', durationMs: 0 } },
    });
    expect(r.status).toBe('completed');
    expect(r.outcome?.limitations ?? []).toEqual([]);
  });

  it('levels: http link to unencrypted or unknown content is a warning (T1_UNENCRYPTED), an upgraded one info', () => {
    const variants = loadRuleset().checks['TLS-01']?.variants;
    expect(variants?.['internal-http-link']).toEqual({ severity: 'warning', crm: 'T1_UNENCRYPTED' });
    expect(variants?.['internal-http-link-upgraded']).toEqual({ severity: 'info', crm: null });
  });
});
