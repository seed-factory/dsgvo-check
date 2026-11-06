import { describe, expect, it } from 'vitest';
import { tls01 } from '../../../../src/checks/http/tls-01.ts';
import { loadRuleset } from '../../../../src/core/data/load.ts';
import type { LinkFact, PageVisit, PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import type { HostVariant, HttpHop, RedirectChain } from '../../../../src/core/snapshot/http.ts';
import type { Snapshot } from '../../../../src/core/snapshot/index.ts';
import {
  makeBrowser,
  makeChain,
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

  it('clean: 301 to https on the same host', () => {
    const r = runCheck(tls01, snap(redirect301(), httpsOk()));
    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([]);
  });

  it('violation (warning): http serves content without redirect while https works', () => {
    const r = runCheck(
      tls01,
      snap(chain('http://www.example.de/', [{ status: 200, bodyBytes: BIG, bodyKind: 'html' }]), httpsOk()),
    );
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
    const r = runCheck(
      tls01,
      snap(chain('http://www.example.de/', [{ status: 200, bodyBytes: BIG }]), https),
    );
    expect(variantsOf(r)).toEqual(['https-unavailable']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason, downgrade: 'no' });
  });

  it('violation (critical): https answers with an invalid certificate (expired)', () => {
    const https = chain('https://www.example.de/', [
      { status: 200, tlsAuthorized: false, tlsAuthorizationError: 'CERT_HAS_EXPIRED' },
    ]);
    const r = runCheck(
      tls01,
      snap(chain('http://www.example.de/', [{ status: 200, bodyBytes: BIG }]), https),
    );
    expect(variantsOf(r)).toEqual(['https-unavailable']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ reason: 'invalid' });
  });

  it('an incomplete chain on https counts as working https (browsers complete it)', () => {
    const https = chain('https://www.example.de/', [
      { status: 200, tlsAuthorized: false, tlsAuthorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    ]);
    const r = runCheck(
      tls01,
      snap(chain('http://www.example.de/', [{ status: 200, bodyBytes: BIG }]), https),
    );
    expect(variantsOf(r)).toEqual(['no-redirect']);
  });

  it('violation (critical): form on an http page', () => {
    const r = runCheck(
      tls01,
      snap(chain('http://www.example.de/', [{ status: 200, bodyBytes: BIG, hasForm: true }]), httpsOk()),
    );
    expect(variantsOf(r)).toEqual(['form-on-http-page', 'no-redirect']);
    expect(observationsOf(r).find((o) => o.variant === 'form-on-http-page')?.subject).toBe(
      'http-entry:final',
    );
  });

  it('violation (warning): redirect only via meta refresh / JS', () => {
    const r = runCheck(
      tls01,
      snap(
        chain('http://www.example.de/', [
          {
            status: 200,
            bodyBytes: 300,
            clientRedirect: { kind: 'meta', url: 'https://www.example.de/' },
          },
        ]),
        httpsOk(),
      ),
    );
    expect(variantsOf(r)).toEqual(['client-side-redirect-only']);
    expect(observationsOf(r)[0]?.params).toMatchObject({ kind: 'meta' });
  });

  it('a client redirect to http is not an upgrade (content served over http)', () => {
    const r = runCheck(
      tls01,
      snap(
        chain('http://www.example.de/', [
          { status: 200, bodyBytes: BIG, clientRedirect: { kind: 'js', url: 'http://www.example.de/home' } },
        ]),
        httpsOk(),
      ),
    );
    expect(variantsOf(r)).toEqual(['no-redirect']);
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
    const c = chain('http://www.example.de/', [
      { status: 302, location: 'http://www.example.de/start' },
      { url: 'http://www.example.de/start', status: 200, bodyBytes: BIG },
    ]);
    const r = runCheck(tls01, snap(c, httpsOk()));
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

  it('counterexample: closed port 80 is not "serving content"', () => {
    const http = chain('http://www.example.de/', [], { outcome: 'connection-refused' });
    expect(variantsOf(runCheck(tls01, snap(http, httpsOk())))).toEqual([]);
  });

  it('counterexample: a stub of ≤ 1 KiB on http gives no finding', () => {
    const http = chain('http://www.example.de/', [{ status: 200, bodyBytes: 512 }]);
    expect(variantsOf(runCheck(tls01, snap(http, httpsOk())))).toEqual([]);
  });

  it('a cut body with ≤ 1 KiB read is not a stub (its real size is unknown)', () => {
    const http = chain('http://www.example.de/', [{ status: 200, bodyBytes: 512, bodyTruncated: true }]);
    expect(variantsOf(runCheck(tls01, snap(http, httpsOk())))).toEqual(['no-redirect']);
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

  it('http error status (404) is not content', () => {
    const http = chain('http://www.example.de/', [{ status: 404, bodyBytes: BIG }]);
    expect(variantsOf(runCheck(tls01, snap(http, httpsOk())))).toEqual([]);
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

  it('inconclusive: http of the target timed out', () => {
    const http = chain('http://www.example.de/', [], { outcome: 'timeout' });
    const r = runCheck(tls01, snap(http, httpsOk()));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'timeout' });
  });

  it('inconclusive: http content while https timed out (cannot tell critical from warning)', () => {
    const https = chain('https://www.example.de/', [], { outcome: 'timeout' });
    const r = runCheck(
      tls01,
      snap(chain('http://www.example.de/', [{ status: 200, bodyBytes: BIG }]), https),
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

  function linkSnapshot(
    chains: RedirectChain[],
    phases: PhaseRecord[] | null,
    collection: Partial<Snapshot['collection']> = {},
  ): Snapshot {
    return makeSnapshot({
      target: makeTarget(SITE),
      http: makeHttp({ chains: [...chains, apexClosed()] }),
      ...(phases ? { browser: makeBrowser({ phases }) } : {}),
      collection,
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
        params: expect.objectContaining({ host: 'www.example.test', location: 'https://www.example.test/' }),
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
      makeSnapshot({
        target: makeTarget(SITE),
        http: makeHttp({ chains: [toApex, wwwHttps, apexClosed()] }),
        browser: makeBrowser({ phases: phaseA(visit(SITE, [link('http://www.example.test/produkte')])) }),
      }),
    );
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({
        variant: 'internal-http-link-upgraded',
        params: expect.objectContaining({ location: 'https://example.test/' }),
      }),
    ]);
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
      makeSnapshot({
        target: makeTarget(SITE),
        http: makeHttp({ chains: [backToHttp, ...wwwUpgraded([HSTS]).slice(1), apexClosed()] }),
        browser: makeBrowser({ phases: phaseA(visit(SITE, [link('http://www.example.test/produkte')])) }),
      }),
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
      makeSnapshot({
        target: makeTarget(ip),
        http: makeHttp({ chains }),
        browser: makeBrowser({ phases: phaseA(visit(ip, [link('http://192.0.2.1/legal')])) }),
      }),
    );
    expect(linkObservations(r)).toEqual([
      expect.objectContaining({ variant: 'internal-http-link-upgraded', subject: 'http-link:@' }),
    ]);
  });

  it('a link to a host whose http probe timed out → internal-http-link, medium (unknown)', () => {
    const r = runCheck(
      tls01,
      makeSnapshot({
        target: makeTarget(SITE),
        http: makeHttp({
          chains: [
            ...wwwUpgraded([HSTS]),
            chain('http://example.test/', [], { hostVariant: 'apex', outcome: 'timeout' }),
          ],
        }),
        browser: makeBrowser({ phases: phaseA(visit(SITE, [link('http://example.test/')])) }),
      }),
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
        makeSnapshot({
          target: makeTarget(SITE),
          http: makeHttp({
            chains: [
              ...wwwUpgraded([HSTS]),
              chain(
                'http://example.test/',
                [
                  { status: 301, location: SITE },
                  { url: SITE, status: 200, bodyBytes: BIG, tlsAuthorized: true, headers: [HSTS] },
                ],
                { hostVariant: 'apex' },
              ),
            ],
          }),
          browser: makeBrowser({ phases: phaseA(visit(SITE, [link('http://example.test/legal')])) }),
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
      const r = runCheck(tls01, linkSnapshot(wwwServed(), null, collection));
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
        browser: { status: 'not-run', reason: 'not-required', durationMs: 0 },
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
