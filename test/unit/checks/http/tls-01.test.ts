import { describe, expect, it } from 'vitest';
import { tls01 } from '../../../../src/checks/http/tls-01.ts';
import { loadRuleset, loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage } from '../../../../src/core/data/messages.ts';
import type { LinkFact, PageVisit, PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import type {
  DocumentResponse,
  FormTwinStage,
  HostVariant,
  HttpHop,
  HttpSection,
  HttpTwin,
  RedirectChain,
} from '../../../../src/core/snapshot/http.ts';
import type { Snapshot } from '../../../../src/core/snapshot/index.ts';
import {
  makeBrowser,
  makeChain,
  makeDocumentResponse,
  makeDom,
  makeHop,
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

const BIG = 20_000;

function chain(
  startUrl: string,
  hops: Partial<HttpHop>[],
  p: Partial<RedirectChain> & { hostVariant?: HostVariant } = {},
): RedirectChain {
  const built = hops.map((h, i) => makeHop({ url: startUrl, ...h, ...(i === 0 ? {} : {}) }));
  return makeChain({
    startUrl,
    hops: built,
    final: p.outcome && p.outcome !== 'ok' ? null : (built.at(-1) ?? null),
    ...p,
  });
}

const httpsOk = (host = 'www.example.de', hv: HostVariant = 'target') =>
  chain(`https://${host}/`, [{ status: 200, bodyBytes: BIG, tlsAuthorized: true }], { hostVariant: hv });

const redirect301 = (host = 'www.example.de', to = `https://${host}/`, hv: HostVariant = 'target') =>
  chain(
    `http://${host}/`,
    [
      { status: 301, location: to },
      { url: to, status: 200, bodyBytes: BIG },
    ],
    {
      hostVariant: hv,
    },
  );

const snap = (...chains: RedirectChain[]) => makeSnapshot({ http: makeHttp({ chains }) });

/** TLS-01 on the http entry of www.example.de with these hops, beside the https chain (working unless given). */
const entry = (hops: Partial<HttpHop>[], https: RedirectChain = httpsOk()) =>
  runCheck(tls01, snap(chain('http://www.example.de/', hops), https));

describe('TLS-01 http → https', () => {
  it('reports missing HTTP probe for a redirected final host', () => {
    const snapshot = makeSnapshot({
      target: makeTarget('https://www.example.de/', 'https://other.test/'),
      http: makeHttp({ chains: [redirect301(), httpsOk()] }),
    });
    const result = runCheck(tls01, snapshot);
    expect(result.status).toBe('partial');
    expect(result.outcome?.limitations).toContain('final-host-not-probed');
  });

  it('distinguishes an off-host HTTPS first hop from an HTTP first hop', () => {
    const offHost = runCheck(tls01, snap(redirect301('www.example.de', 'https://other.test/'), httpsOk()));
    expect(observationsOf(offHost)[0]?.params.reason).toBe('other-host');
    const detour = chain('http://www.example.de/', [
      { status: 301, location: 'http://www.example.de/next' },
      { url: 'http://www.example.de/next', status: 301, location: 'https://www.example.de/' },
      { url: 'https://www.example.de/', status: 200 },
    ]);
    expect(observationsOf(runCheck(tls01, snap(detour, httpsOk())))[0]?.params.reason).toBe('http-first-hop');
  });

  it('violation (warning): http serves content without redirect while https works', () => {
    const r = entry([{ status: 200, bodyBytes: BIG, bodyKind: 'html' }]);
    expect(variantsOf(r)).toEqual(['no-redirect']);
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'http-entry:final',
      phases: ['http'],
      pages: ['http://www.example.de/'],
      params: { host: 'www.example.de', url: 'http://www.example.de/' },
    });
    expect(observationsOf(r)[0]?.evidence[0]).toMatchObject({ type: 'redirect-chain', outcome: 'ok' });
  });

  it.each([
    ['connection-refused', 'unavailable'],
    ['dns-error', 'unavailable'],
    ['tls-error', 'invalid'],
  ] as const)('violation (critical): http content and https %s', (outcome, reason) => {
    const https = chain('https://www.example.de/', [], { outcome, error: { code: 'X', message: 'x' } });
    const r = entry([{ status: 200, bodyBytes: BIG }], https);
    expect(variantsOf(r)).toEqual(['https-unavailable']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason, downgrade: 'no' });
  });

  it('violation (critical): https answers with an invalid certificate (expired)', () => {
    const https = chain('https://www.example.de/', [
      { status: 200, tlsAuthorized: false, tlsAuthorizationError: 'CERT_HAS_EXPIRED' },
    ]);
    const r = entry([{ status: 200, bodyBytes: BIG }], https);
    expect(variantsOf(r)).toEqual(['https-unavailable']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'invalid' });
  });

  it('an incomplete chain on https counts as working https (browsers complete it)', () => {
    const https = chain('https://www.example.de/', [
      { status: 200, tlsAuthorized: false, tlsAuthorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    ]);
    expect(variantsOf(entry([{ status: 200, bodyBytes: BIG }], https))).toEqual(['no-redirect']);
  });

  it('violation (critical): form on an http page', () => {
    const r = entry([{ status: 200, bodyBytes: BIG, hasForm: true }]);
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
    expect(observationsOf(r).find((o) => o.variant === 'form-on-http-page')?.subject).toBe(
      'http-entry:final',
    );
  });

  it('violation (warning): redirect only via meta refresh / JS', () => {
    const r = entry([
      { status: 200, bodyBytes: 300, clientRedirect: { kind: 'meta', url: 'https://www.example.de/' } },
    ]);
    expect(variantsOf(r)).toEqual(['client-side-redirect-only']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ kind: 'meta' });
  });

  it.each([
    [
      'a client redirect to http is not an upgrade (content served over http)',
      { status: 200, bodyBytes: BIG, clientRedirect: { kind: 'js', url: 'http://www.example.de/home' } },
      ['no-redirect'],
    ],
    ['counterexample: a stub of ≤ 1 KiB on http gives no finding', { status: 200, bodyBytes: 512 }, []],
    [
      'a cut body with ≤ 1 KiB read is not a stub (its real size is unknown)',
      { status: 200, bodyBytes: 512, bodyTruncated: true },
      ['no-redirect'],
    ],
    ['http error status (404) is not content', { status: 404, bodyBytes: BIG }, []],
  ] as const)('%s', (_label, hop, variants) => {
    expect(variantsOf(entry([hop]))).toEqual(variants);
  });

  it('info: 301 to https on another host (first hop off-host)', () => {
    const r = runCheck(
      tls01,
      snap(redirect301('example.de', 'https://www.example.de/', 'apex'), redirect301(), httpsOk()),
    );
    expect(variantsOf(r)).toEqual(['redirect-chain-detail']);
    expect(observationsOf(r)[0]).toMatchObject({
      subject: 'http-entry:pair',
      params: { host: 'example.de', location: 'https://www.example.de/' },
    });
  });

  it('info: first hop stays on http, https is reached later', () => {
    const c = chain('http://www.example.de/', [
      { status: 301, location: 'http://www.example.de/de/' },
      { url: 'http://www.example.de/de/', status: 301, location: 'https://www.example.de/de/' },
      { url: 'https://www.example.de/de/', status: 200 },
    ]);
    expect(variantsOf(runCheck(tls01, snap(c, httpsOk())))).toEqual(['redirect-chain-detail']);
  });

  it('http → http redirect ending in content is evaluated like no redirect', () => {
    const r = entry([
      { status: 302, location: 'http://www.example.de/start' },
      { url: 'http://www.example.de/start', status: 200, bodyBytes: BIG },
    ]);
    expect(variantsOf(r)).toEqual(['no-redirect']);
    expect(observationsOf(r)[0]?.pages).toEqual(['http://www.example.de/start']);
  });

  describe('apex and www that end on the same http page', () => {
    const page = 'http://www.example.de/';
    const content = { url: page, status: 200, bodyBytes: BIG, bodyKind: 'html' as const };
    const apexToWww = (last: Partial<HttpHop> = {}) =>
      chain(
        'http://example.de/',
        [
          { status: 301, location: page },
          { ...content, ...last },
        ],
        {
          hostVariant: 'apex',
        },
      );
    const www = (last: Partial<HttpHop> = {}) =>
      chain(page, [{ ...content, ...last }], { hostVariant: 'target' });
    const httpsApex = chain(
      'https://example.de/',
      [
        { status: 301, location: 'https://www.example.de/' },
        { url: 'https://www.example.de/', status: 200, tlsAuthorized: true },
      ],
      { hostVariant: 'apex' },
    );

    it('no-redirect of each entry names the address typed and the page it ends on', () => {
      const r = runCheck(tls01, snap(www(), httpsOk(), apexToWww(), httpsApex));
      const params = observationsOf(r)
        .filter((o) => o.variant === 'no-redirect')
        .map((o) => o.params);
      expect(params).toEqual([
        { host: 'www.example.de', url: page, page, redirected: 'no', downgrade: 'no' },
        { host: 'example.de', url: 'http://example.de/', page, redirected: 'yes', downgrade: 'no' },
      ]);
    });

    it('a form on that page is one finding, reported for the first entry', () => {
      const r = runCheck(
        tls01,
        snap(www({ hasForm: true }), httpsOk(), apexToWww({ hasForm: true }), httpsApex),
      );
      const forms = observationsOf(r).filter((o) => o.variant === 'form-on-http-page');
      expect(forms).toHaveLength(1);
      expect(forms[0]).toMatchObject({ pages: [page], params: { host: 'www.example.de', url: page } });
    });
  });

  describe('a chain that reaches https and returns to http is evaluated on its final http page', () => {
    const downgrade = (last: Partial<HttpHop>) =>
      chain('http://www.example.de/', [
        { status: 301, location: 'https://www.example.de/' },
        {
          url: 'https://www.example.de/',
          status: 302,
          location: 'http://www.example.de/form',
          tlsAuthorized: true,
        },
        { url: 'http://www.example.de/form', status: 200, bodyBytes: BIG, ...last },
      ]);

    it('http → https (same host) → http 200 with a form → form-on-http-page and no-redirect', () => {
      const r = runCheck(tls01, snap(downgrade({ hasForm: true }), httpsOk()));
      expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
      const form = observationsOf(r).find((o) => o.variant === 'form-on-http-page');
      expect(form).toMatchObject({
        pages: ['http://www.example.de/form'],
        params: { url: 'http://www.example.de/form', downgrade: 'yes' },
      });
    });

    it('downgrade without a form → no-redirect on the final http page', () => {
      const r = runCheck(tls01, snap(downgrade({}), httpsOk()));
      expect(variantsOf(r)).toEqual(['no-redirect']);
      expect(observationsOf(r)[0]?.params).toMatchObject({ downgrade: 'yes' });
    });

    it('the https hop of the downgrade chain proves working https when the https chain is undecided', () => {
      const https = chain('https://www.example.de/', [], { outcome: 'timeout' });
      expect(variantsOf(runCheck(tls01, snap(downgrade({}), https)))).toEqual(['no-redirect']);
    });

    it('downgrade to a stub page ≤ 1 KiB → no finding', () => {
      expect(variantsOf(runCheck(tls01, snap(downgrade({ bodyBytes: 300 }), httpsOk())))).toEqual([]);
    });

    it('http → https → https 200 stays clean (the chain ends on https)', () => {
      const c = chain('http://www.example.de/', [
        { status: 301, location: 'https://www.example.de/' },
        { url: 'https://www.example.de/', status: 302, location: 'https://www.example.de/de/' },
        { url: 'https://www.example.de/de/', status: 200 },
      ]);
      expect(variantsOf(runCheck(tls01, snap(c, httpsOk())))).toEqual([]);
    });
  });

  it('www / apex without DNS are ignored', () => {
    const www = chain('http://www.example.de/', [], { hostVariant: 'www', outcome: 'dns-error' });
    const r = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('https://example.de/'),
        http: makeHttp({ chains: [redirect301('example.de'), httpsOk('example.de'), www] }),
      }),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('inconclusive: http content while https timed out (cannot tell critical from warning)', () => {
    const r = entry(
      [{ status: 200, bodyBytes: BIG }],
      chain('https://www.example.de/', [], { outcome: 'timeout' }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'timeout' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('partial: a non-target host variant timed out', () => {
    const apex = chain('http://example.de/', [], { hostVariant: 'apex', outcome: 'timeout' });
    const r = runCheck(tls01, snap(redirect301(), httpsOk(), apex));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['undecided:apex']);
  });

  it('error: the target http chain is missing (collector contract broken)', () => {
    expect(runCheck(tls01, snap(httpsOk()))).toMatchObject({ status: 'error', reason: 'exception' });
  });
});

describe('TLS-01 subject by host role, independent of how the target was typed (5.4)', () => {
  const noRedirect = (host: string, hv: 'target' | 'www' | 'apex') =>
    chain(`http://${host}/`, [{ status: 200, bodyBytes: BIG, bodyKind: 'html' }], { hostVariant: hv });

  it('the http entry of www.example.de is `http-entry:final` whether example.de or www.example.de was typed', () => {
    const viaApex = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('http://example.de/', 'https://www.example.de/'),
        http: makeHttp({
          chains: [
            redirect301('example.de', 'https://www.example.de/', 'target'),
            noRedirect('www.example.de', 'www'),
            httpsOk('www.example.de', 'www'),
          ],
        }),
      }),
    );
    const direct = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget('http://www.example.de/', 'https://www.example.de/'),
        http: makeHttp({ chains: [noRedirect('www.example.de', 'target'), httpsOk()] }),
      }),
    );
    const subjectOf = (r: ReturnType<typeof runCheck>, variant: string) =>
      observationsOf(r).find((o) => o.variant === variant)?.subject;
    expect(subjectOf(viaApex, 'no-redirect')).toBe('http-entry:final');
    expect(subjectOf(direct, 'no-redirect')).toBe('http-entry:final');
    expect(subjectOf(viaApex, 'redirect-chain-detail')).toBe('http-entry:pair');
  });
});

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
  function linkSnapshot(
    chains: RedirectChain[],
    phases: PhaseRecord[] | null,
    o: { collection?: Partial<Snapshot['collection']>; apex?: RedirectChain | null; site?: string } = {},
  ): Snapshot {
    const apex = o.apex === undefined ? apexClosed() : o.apex;
    return makeSnapshot({
      target: makeTarget(o.site ?? SITE),
      http: makeHttp({ chains: [...chains, ...(apex ? [apex] : [])] }),
      ...(phases ? { browser: makeBrowser({ phases }) } : {}),
      collection: o.collection ?? {},
    });
  }
  const phaseA = (...pages: PageVisit[]) => [makePhase('A', { pages })];
  const linkObservations = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r).filter((o) => o.variant.startsWith('internal-http-link'));

  it('a visible nav link to an http subdomain the scan did not probe → internal-http-link, medium', () => {
    const r = runCheck(
      tls01,
      linkSnapshot(wwwUpgraded([HSTS]), phaseA(visit(SITE, [link('http://work.example.test/')]))),
    );
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
    const r = runCheck(
      tls01,
      linkSnapshot(
        wwwServed(),
        phaseA(visit(SITE, legal), visit('https://www.example.test/kontakt', legal, { order: 1 })),
      ),
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
      const r = runCheck(
        tls01,
        linkSnapshot(
          [root, wwwServed()[1]!],
          phaseA(visit(SITE, [link('http://www.example.test/impressum')])),
        ),
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
    const r = runCheck(
      tls01,
      linkSnapshot(
        wwwUpgraded(),
        phaseA(visit(SITE, [link('http://www.example.test/produkte', { text: 'Produkte' })])),
      ),
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
      const r = runCheck(
        tls01,
        linkSnapshot(
          wwwUpgraded([{ name: 'strict-transport-security', value }]),
          phaseA(visit(SITE, [link('http://www.example.test/produkte')])),
        ),
      );
      expect(linkObservations(r).map((o) => o.variant)).toEqual(['internal-http-link-upgraded']);
    },
  );

  it('counterexample: HSTS repeating a directive the browser ignores (preload) is in force: no link finding', () => {
    const r = runCheck(
      tls01,
      linkSnapshot(
        wwwUpgraded([{ name: 'strict-transport-security', value: 'max-age=31536000; preload; preload' }]),
        phaseA(visit(SITE, [link('http://www.example.test/produkte')])),
      ),
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
    const r = runCheck(
      tls01,
      linkSnapshot([toApex, wwwHttps], phaseA(visit(SITE, [link('http://www.example.test/produkte')]))),
    );
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
    const r = runCheck(
      tls01,
      linkSnapshot(
        [backToHttp, ...wwwUpgraded([HSTS]).slice(1)],
        phaseA(visit(SITE, [link('http://www.example.test/produkte')])),
      ),
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
    const r = runCheck(
      tls01,
      linkSnapshot(chains, phaseA(visit(ip, [link('http://192.0.2.1/legal')])), { site: ip, apex: null }),
    );
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({ variant: 'internal-http-link-upgraded', subject: 'http-link:@' }),
    ]);
  });

  it('a link to a host whose http probe timed out → internal-http-link, medium (unknown)', () => {
    const apex = chain('http://example.test/', [], { hostVariant: 'apex', outcome: 'timeout' });
    const r = runCheck(
      tls01,
      linkSnapshot(wwwUpgraded([HSTS]), phaseA(visit(SITE, [link('http://example.test/')])), { apex }),
    );
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
    const r = runCheck(
      tls01,
      linkSnapshot(
        wwwUpgraded([HSTS]),
        phaseA(
          visit(SITE, [
            link('http://work.example.test/a', { text: 'Versteckt', region: 'banner', visible: false }),
            link('http://work.example.test/', { text: 'Startseite', region: 'nav' }),
            link('http://work.example.test/', { text: 'Startseite', region: 'nav' }),
          ]),
          visit('https://www.example.test/b', [link('http://work.example.test/')], { order: 1 }),
        ),
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
    const r = runCheck(
      tls01,
      linkSnapshot(
        wwwUpgraded([HSTS]),
        phaseA(
          visit(SITE, [link('http://work.example.test/', { frameUrl: 'https://www.example.test/frame' })]),
        ),
      ),
    );
    expect(linkObservations(r).map((o) => o.variant)).toEqual(['internal-http-link']);
  });

  it.each<[string, () => Snapshot]>([
    [
      'an external http link',
      () => linkSnapshot(wwwServed(), phaseA(visit(SITE, [link('http://other.test/', { sameSite: false })]))),
    ],
    [
      'a look-alike host that only starts with the site name',
      () =>
        linkSnapshot(
          wwwServed(),
          phaseA(visit(SITE, [link('http://example.test.other.test/', { sameSite: false })])),
        ),
    ],
    [
      'mailto, javascript and fragment links',
      () =>
        linkSnapshot(
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
        linkSnapshot(
          wwwServed(),
          phaseA(visit(SITE, [link('http://www.example.test/', { frameUrl: 'https://other.test/embed' })])),
        ),
    ],
    [
      'a link to a host that redirects to https with a valid HSTS header',
      () =>
        linkSnapshot(wwwUpgraded([HSTS]), phaseA(visit(SITE, [link('http://www.example.test/produkte')]))),
    ],
    [
      'a link to a host that redirects to https of another host with a valid HSTS header',
      () =>
        linkSnapshot(wwwUpgraded([HSTS]), phaseA(visit(SITE, [link('http://example.test/legal')])), {
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
      () => linkSnapshot(wwwUpgraded([HSTS]), phaseA(visit(SITE, [link('http://example.test/')]))),
    ],
    [
      'a link on a page that is itself served over http',
      () =>
        linkSnapshot(
          wwwUpgraded([HSTS]),
          phaseA(visit('http://www.example.test/alt', [link('http://work.example.test/')])),
        ),
    ],
    [
      'a link on a page that could not be evaluated (challenge)',
      () =>
        linkSnapshot(
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
        linkSnapshot(
          wwwServed(),
          phaseA(visit(SITE, [link('https://www.example.test/', { hrefKind: 'https' })])),
        ),
    ],
  ])('counterexample: %s gives no link finding', (_name, snapshot) => {
    const r = runCheck(tls01, snapshot());
    expect(linkObservations(r)).toEqual([]);
    expect(r.outcome?.limitations ?? []).not.toContain('page-links-not-observed');
  });

  it('repeats in phases B and C add nothing: one observation with the phase A pages', () => {
    const work = link('http://work.example.test/');
    const r = runCheck(
      tls01,
      linkSnapshot(wwwUpgraded([HSTS]), [
        makePhase('A', { pages: [visit(SITE, [work])] }),
        makePhase('B', {
          pages: [
            visit(SITE, [work], { phase: 'B' }),
            visit('https://www.example.test/b', [work], { phase: 'B' }),
          ],
        }),
        makePhase('C', { pages: [visit(SITE, [work], { phase: 'C' })] }),
      ]),
    );
    expect(linkObservations(r)).toHaveLength(1);
    expect(linkObservations(r)[0]).toMatchObject({ phases: ['A'], pages: [SITE] });
  });

  it.each<[string, Partial<Snapshot['collection']>]>([
    ['skipped as tls-blocked', { browser: { status: 'skipped', reason: 'tls-blocked', durationMs: 0 } }],
    ['failed', { browser: { status: 'error', durationMs: 0 } }],
  ])(
    'browser %s: partial with page-links-not-observed, the http entries still evaluated',
    (_n, collection) => {
      const r = runCheck(tls01, linkSnapshot(wwwServed(), null, { collection }));
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toContain('page-links-not-observed');
      expect(variantsOf(r)).toEqual(['no-redirect']);
    },
  );

  it('browser ran but phase A has no evaluable page: partial with page-links-not-observed', () => {
    const r = runCheck(
      tls01,
      linkSnapshot(
        wwwUpgraded([HSTS]),
        phaseA(visit(SITE, [link('http://work.example.test/')], { evaluable: false, dom: null })),
      ),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['page-links-not-observed']);
  });

  it('browser not selected (--checks TLS-01): no limitation, completed', () => {
    const r = runCheck(
      tls01,
      linkSnapshot(wwwUpgraded([HSTS]), null, {
        collection: { browser: { status: 'not-run', reason: 'not-required', durationMs: 0 } },
      }),
    );
    expect(r.status).toBe('completed');
    expect(r.outcome?.limitations ?? []).toEqual([]);
  });

  it('reads the browser section only when the scan has it: --checks TLS-01 does not start the browser', () => {
    expect(tls01.requires).toEqual(['http']);
    expect(tls01.optional).toEqual(['browser']);
  });

  it('levels: http link to unencrypted or unknown content is a warning (T1_UNENCRYPTED), an upgraded one info', () => {
    const variants = loadRuleset().checks['TLS-01']?.variants;
    expect(variants?.['internal-http-link']).toEqual({ severity: 'warning', crm: 'T1_UNENCRYPTED' });
    expect(variants?.['internal-http-link-upgraded']).toEqual({ severity: 'info', crm: null });
  });
});

describe('TLS-01 forms on pages served over http beyond the root', () => {
  const ROOT = 'http://www.example.test/';
  const POST = 'http://www.example.test/post-1/';
  const ACTION = 'http://www.example.test/wp-comments-post.php';
  const COMMENT_FORM = { action: ACTION, actionScheme: 'http' as const, method: 'post' as const };

  /** http:// of www serves the start page without a redirect; https works. */
  const root = (h: Partial<HttpHop> = {}) =>
    chain(
      ROOT,
      [
        {
          status: 200,
          bodyBytes: BIG,
          bodyKind: 'html',
          hasForm: false,
          forms: [],
          formInspection: 'complete',
          ...h,
        },
      ],
      {
        hostVariant: 'target',
      },
    );
  const https = () => httpsOk('www.example.test');

  function twin(hop: Partial<HttpHop> | null, p: Partial<HttpTwin> = {}): HttpTwin {
    return {
      page: 'https://www.example.test/post-1/',
      url: POST,
      hop:
        hop === null
          ? null
          : makeHop({
              url: POST,
              status: 200,
              bodyBytes: BIG,
              bodyKind: 'html',
              hasForm: false,
              forms: [],
              formInspection: 'complete',
              ...hop,
            }),
      outcome: 'ok',
      ...p,
    };
  }
  const STAGE: FormTwinStage = { budget: 3, candidates: 1, durationMs: 600 };

  const withTwins = (twins: HttpTwin[], p: Partial<HttpSection> = {}, chains = [root(), https()]) =>
    makeSnapshot({
      target: makeTarget('https://www.example.test/'),
      http: makeHttp({ chains, twins, formTwinStage: STAGE, ...p }),
    });
  const formOf = (r: ReturnType<typeof runCheck>) =>
    observationsOf(r).find((o) => o.variant === 'form-on-http-page');

  /**
   * The answers that decide the http:// address of a page alike, however the page was found: `build` makes its
   * twin, and `page` is the https page that a limitation names.
   */
  function answersDecideAlike(build: typeof twin, page: string) {
    it.each<[string, Partial<HttpHop>]>([
      [
        'the address redirects to https',
        { status: 301, location: 'https://www.example.test/post-1/', bodyBytes: 0, bodyKind: 'empty' },
      ],
      ['the address answers 404', { status: 404 }],
      ['the http page has no data form', { hasForm: false, forms: [], formInspection: 'complete' }],
    ])('clean: %s', (_name, hop) => {
      const answer = build({ hasForm: undefined, forms: undefined, formInspection: undefined, ...hop });
      const r = runCheck(tls01, withTwins([answer]));
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });

    it('no clean claim when the request timed out: limitation naming the page, no form finding', () => {
      const timedOut = build(null, { outcome: 'timeout', error: { code: 'timeout', message: 'x' } });
      const r = runCheck(tls01, withTwins([timedOut]));
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual([`http-form-twin-undecided:${page}`]);
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });
  }

  it('a comment form on the http:// address of an article → form-on-http-page naming where the form sends', () => {
    const r = runCheck(tls01, withTwins([twin({ hasForm: true, forms: [COMMENT_FORM] })]));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
    expect(formOf(r)).toMatchObject({
      subject: 'http-entry:final',
      phases: ['http'],
      pages: [POST],
      params: {
        host: 'www.example.test',
        url: POST,
        action: ACTION,
        hasAction: 'yes',
        count: 1,
        downgrade: 'no',
        permalinks: 0,
      },
    });
    expect(formOf(r)?.evidence).toContainEqual({
      type: 'page',
      phase: 'http',
      url: POST,
      status: 200,
      role: 'http-form',
      formAction: ACTION,
    });
  });

  it('forms on the root and on an article of one host are one finding over both pages, the root first', () => {
    const r = runCheck(
      tls01,
      withTwins([twin({ hasForm: true, forms: [COMMENT_FORM] })], {}, [
        root({
          hasForm: true,
          forms: [{ action: 'http://www.example.test/kontakt', actionScheme: 'http', method: 'post' }],
        }),
        https(),
      ]),
    );
    const forms = observationsOf(r).filter((o) => o.variant === 'form-on-http-page');
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({
      pages: [ROOT, POST],
      params: { url: ROOT, action: 'http://www.example.test/kontakt', count: 2 },
    });
  });

  answersDecideAlike(twin, 'https://www.example.test/post-1/');

  it.each<[string, HttpTwin]>([
    [
      'the host throttled the scan',
      twin(null, { outcome: 'throttled', error: { code: 'throttled', message: 'x' } }),
    ],
    [
      'a bot challenge answered',
      twin({ status: 403, hasForm: true, forms: [COMMENT_FORM] }, { challenge: 'cloudflare' }),
    ],
    ['a redirect to another http address', twin({ status: 301, location: 'http://www.example.test/post-1' })],
    ['a server error', twin({ status: 503 })],
  ])('no clean claim when %s: limitation, no form finding', (_name, t) => {
    const r = runCheck(tls01, withTwins([t]));
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toContain('http-form-twin-undecided:https://www.example.test/post-1/');
    expect(variantsOf(r)).toEqual(['no-redirect']);
  });

  it.each(['truncated', 'unavailable'] as const)(
    'an article read %s without a form seen: limitation http-form-not-inspected, no clean claim',
    (formInspection) => {
      const r = runCheck(tls01, withTwins([twin({ formInspection })]));
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual([`http-form-not-inspected:${POST}`]);
      expect(variantsOf(r)).toEqual(['no-redirect']);
    },
  );

  it('a form in the part of a cut body that was read is a finding without a limitation', () => {
    const r = runCheck(
      tls01,
      withTwins([twin({ hasForm: true, forms: [COMMENT_FORM], formInspection: 'truncated' })]),
    );
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
  });

  it('the http:// root read only in part without a form seen: limitation http-form-not-inspected', () => {
    const r = runCheck(
      tls01,
      withTwins([], {}, [root({ formInspection: 'truncated', bodyTruncated: true }), https()]),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual([`http-form-not-inspected:${ROOT}`]);
  });

  describe('linked legal documents that ended on plain http', () => {
    const legal = (p: Partial<DocumentResponse> = {}) =>
      makeDocumentResponse({
        role: 'impressum',
        url: 'http://www.example.test/impressum',
        foundVia: 'link',
        hasForm: true,
        forms: [{ action: 'http://www.example.test/impressum', actionScheme: 'http', method: 'post' }],
        formInspection: 'complete',
        ...p,
      });

    it('a contact form on the Impressum served over http → form-on-http-page on that page', () => {
      const r = runCheck(tls01, withTwins([], { documents: [legal()] }));
      expect(formOf(r)).toMatchObject({
        pages: ['http://www.example.test/impressum'],
        params: { url: 'http://www.example.test/impressum', action: 'http://www.example.test/impressum' },
      });
    });

    it.each<[string, Partial<DocumentResponse>]>([
      ['it ended on https', { finalUrl: 'https://www.example.test/impressum', formInspection: undefined }],
      ['it answered 404', { status: 404 }],
      [
        'a bot challenge answered on https',
        {
          finalUrl: 'https://www.example.test/impressum',
          formInspection: undefined,
          error: { code: 'blocked', message: 'cloudflare: cf-mitigated' },
        },
      ],
    ])('no finding and no limitation when %s', (_name, p) => {
      const r = runCheck(tls01, withTwins([], { documents: [legal(p)] }));
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });

    it('a bot challenge answered on http instead of the document: limitation, no clean claim', () => {
      const blocked = legal({
        status: 403,
        hasForm: undefined,
        forms: undefined,
        formInspection: undefined,
        error: { code: 'blocked', message: 'cloudflare: cf-mitigated' },
      });
      const r = runCheck(tls01, withTwins([], { documents: [blocked] }));
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toEqual(['http-form-not-inspected:http://www.example.test/impressum']);
      expect(variantsOf(r)).toEqual(['no-redirect']);
    });

    it('read only in part without a form: limitation http-form-not-inspected', () => {
      const r = runCheck(
        tls01,
        withTwins([], { documents: [legal({ hasForm: false, forms: [], formInspection: 'truncated' })] }),
      );
      expect(r.outcome?.limitations).toEqual(['http-form-not-inspected:http://www.example.test/impressum']);
    });
  });

  describe('the http:// address of a post that the visited pages link as its permalink', () => {
    const LINKED = 'https://www.example.test/post-1/';
    const permalinkTwin = (hop: Partial<HttpHop> | null, p: Partial<HttpTwin> = {}) =>
      twin(hop, { page: LINKED, source: 'permalink', linkedFrom: 'https://www.example.test/', ...p });
    const render = (lang: 'de' | 'en', params: Record<string, string | number>) =>
      formatMessage(loadTexts(lang).messages['TLS-01.form-on-http-page']!.body, params, lang);

    it('a comment form there counts like the other pages: one critical finding naming the action and the page', () => {
      const r = runCheck(tls01, withTwins([permalinkTwin({ hasForm: true, forms: [COMMENT_FORM] })]));
      expect(r.status).toBe('completed');
      expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
      expect(formOf(r)).toMatchObject({
        subject: 'http-entry:final',
        pages: [POST],
        params: { url: POST, action: ACTION, hasAction: 'yes', count: 1, permalinks: 1 },
      });
      expect(formOf(r)?.evidence).toContainEqual({
        type: 'page',
        phase: 'http',
        url: POST,
        status: 200,
        role: 'http-form-permalink',
        formAction: ACTION,
      });
    });

    it('the text says the page was requested as the http address of a post the visited pages link', () => {
      const r = runCheck(tls01, withTwins([permalinkTwin({ hasForm: true, forms: [COMMENT_FORM] })]));
      const params = formOf(r)?.params as Record<string, string | number>;
      expect(render('de', params)).toContain(
        'Die Seite wurde als http-Adresse eines Beitrags oder Artikels abgefragt, den die besuchten Seiten als Permalink (rel="bookmark") verlinken; der Browser hat sie nicht besucht.',
      );
      expect(render('en', params)).toContain(
        'The page was requested as the http address of a post or article that the visited pages link as its permalink (rel="bookmark"); the browser did not visit it.',
      );
      for (const lang of ['de', 'en'] as const) {
        expect(render(lang, { ...params, permalinks: 0 })).not.toContain('rel="bookmark"');
        expect(render(lang, { ...params, permalinks: undefined as unknown as number })).not.toMatch(
          /\{|rel=/,
        );
      }
    });

    it('forms on the root, a visited page and a post are one finding; the post is counted and named as such', () => {
      const r = runCheck(
        tls01,
        withTwins(
          [
            twin(
              { hasForm: true, forms: [COMMENT_FORM], url: 'http://www.example.test/kontakt/' },
              {
                page: 'https://www.example.test/kontakt/',
                url: 'http://www.example.test/kontakt/',
                source: 'input-form',
              },
            ),
            permalinkTwin({ hasForm: true, forms: [COMMENT_FORM] }),
          ],
          {},
          [root({ hasForm: true, forms: [COMMENT_FORM] }), https()],
        ),
      );
      const forms = observationsOf(r).filter((o) => o.variant === 'form-on-http-page');
      expect(forms).toHaveLength(1);
      expect(forms[0]).toMatchObject({
        pages: [ROOT, 'http://www.example.test/kontakt/', POST],
        params: { url: ROOT, count: 3, permalinks: 1 },
      });
      expect(forms[0]?.evidence.filter((e) => e.type === 'page').map((e) => [e.url, e.role])).toEqual([
        [ROOT, 'http-form'],
        ['http://www.example.test/kontakt/', 'http-form'],
        [POST, 'http-form-permalink'],
      ]);
      expect(render('de', forms[0]?.params as Record<string, string | number>)).toContain(
        'Eine dieser Seiten wurde als http-Adresse eines Beitrags oder Artikels abgefragt',
      );
    });

    answersDecideAlike(permalinkTwin, LINKED);

    it('more permalinks than the budget leave the result complete: they are not known to carry a form', () => {
      const r = runCheck(
        tls01,
        withTwins([permalinkTwin({})], {
          formTwinStage: { budget: 1, candidates: 0, permalinkCandidates: 7, durationMs: 1 },
        }),
      );
      expect(r.status).toBe('completed');
      expect(r.outcome?.limitations ?? []).toEqual([]);
    });

    it('an older twin without a source counts as a page with a form', () => {
      const r = runCheck(tls01, withTwins([twin({ hasForm: true, forms: [COMMENT_FORM] })]));
      expect(formOf(r)?.params).toMatchObject({ permalinks: 0 });
      expect(formOf(r)?.evidence.find((e) => e.type === 'page')).toMatchObject({ role: 'http-form' });
    });
  });

  it('the step failed: partial with http-form-twins-not-collected', () => {
    const r = runCheck(
      tls01,
      withTwins([], {
        formTwinStage: {
          budget: 3,
          candidates: null,
          durationMs: 1,
          error: { code: 'collector-exception', message: 'x' },
        },
      }),
    );
    expect(r.status).toBe('partial');
    expect(r.outcome?.limitations).toEqual(['http-form-twins-not-collected']);
  });

  it('more pages with a form than the budget: partial with http-form-twins-capped', () => {
    const r = runCheck(
      tls01,
      withTwins([twin({})], { formTwinStage: { budget: 1, candidates: 4, durationMs: 1 } }),
    );
    expect(r.outcome?.limitations).toEqual(['http-form-twins-capped']);
  });

  it('the step switched off (budget 0) or with nothing to request: no limitation', () => {
    for (const formTwinStage of [
      { budget: 0, candidates: 2, durationMs: 0 },
      { budget: 3, candidates: 0, durationMs: 0 },
    ]) {
      expect(runCheck(tls01, withTwins([], { formTwinStage })).status).toBe('completed');
    }
  });

  it('an older snapshot (hasForm without form facts) still gives the finding, without an action', () => {
    const old = chain(ROOT, [{ status: 200, bodyBytes: BIG, bodyKind: 'html', hasForm: true }]);
    const r = runCheck(tls01, snap(old, https()));
    expect(formOf(r)?.params).toMatchObject({ url: ROOT, action: '', hasAction: 'no', count: 1 });
  });

  it('counterexample: an https page whose form sends to http is no TLS-01 finding', () => {
    const form = {
      action: 'http://www.example.test/senden',
      actionScheme: 'http' as const,
      method: 'post',
      visible: true,
      fieldCount: 3,
      hasPasswordField: false,
      hasEmailField: true,
    };
    const snapshot = makeSnapshot({
      target: makeTarget('https://www.example.test/'),
      http: makeHttp({
        chains: [redirect301('www.example.test'), https()],
        twins: [],
        formTwinStage: { budget: 3, candidates: 0, durationMs: 0 },
      }),
      browser: makeBrowser({
        phases: [
          makePhase('A', {
            pages: [
              makePage({
                url: 'https://www.example.test/kontakt/',
                role: 'contact',
                dom: makeDom({ forms: [form] }),
              }),
            ],
          }),
        ],
      }),
    });
    const r = runCheck(tls01, snapshot);
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('level: a form on a page served over http is critical (T1_UNENCRYPTED)', () => {
    expect(loadRuleset().checks['TLS-01']?.variants['form-on-http-page']).toEqual({
      severity: 'critical',
      crm: 'T1_UNENCRYPTED',
    });
  });
});
