/**
 * Which http:// addresses the step after the browser requests: pages of phase A with a form that takes data, then the
 * permalinks (`rel="bookmark"`) those pages link, on a host whose http:// root served content without a redirect, each
 * address once and none the HTTP collector already fetched. The requests themselves are covered on the fixture server
 * (test/integration/http/form-twins.test.ts, test/integration/http/permalink-twins.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { selectFormTwins } from '../../../../src/collectors/http/form-twins.ts';
import type { FormFact, LinkFact, PageVisit } from '../../../../src/core/snapshot/browser.ts';
import type {
  DocumentResponse,
  HttpHop,
  HttpSection,
  RedirectChain,
} from '../../../../src/core/snapshot/http.ts';
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
} from '../../../utils/snapshot-builder.ts';

const SITE = 'https://www.example.test/';

const form = (p: Partial<FormFact> = {}): FormFact => ({
  action: 'https://www.example.test/senden',
  actionScheme: 'https',
  method: 'post',
  visible: true,
  fieldCount: 3,
  hasPasswordField: false,
  hasEmailField: false,
  takesInput: true,
  ...p,
});
/** The header search of a typical site: GET, a search field and a submit input. */
const SEARCH = form({ action: SITE, method: 'get', fieldCount: 2, takesInput: false });
const CONTACT = form({ hasEmailField: true });
const COMMENTS = form({
  action: 'https://www.example.test/wp-comments-post.php',
  fieldCount: 5,
  hasEmailField: true,
});

const visit = (path: string, forms: FormFact[], p: Partial<PageVisit> = {}): PageVisit =>
  makePage({ url: new URL(path, SITE).href, role: 'other', dom: makeDom({ forms }), ...p });

/** The plain-http probe of a host: content without a redirect unless hops are given. */
function httpChain(host: string, hops?: Partial<HttpHop>[], p: Partial<RedirectChain> = {}): RedirectChain {
  const startUrl = `http://${host}/`;
  const built = (hops ?? [{ status: 200, bodyBytes: 20_000, bodyKind: 'html' }]).map((h) =>
    makeHop({ url: startUrl, ...h }),
  );
  return makeChain({ startUrl, hops: built, final: built.at(-1) ?? null, ...p });
}

/** The plain-http probe of a host whose root redirects to its https root. */
const redirectedRoot = (host: string) =>
  httpChain(host, [
    { status: 301, location: `https://${host}/` },
    { url: `https://${host}/`, status: 200 },
  ]);

/** The pages in phase A, or in phase B only (phase A then saw none); `http` adds to the HTTP section. */
function snapshot(
  pages: PageVisit[],
  chains: RedirectChain[] = [httpChain('www.example.test')],
  o: { documents?: DocumentResponse[]; http?: Partial<HttpSection>; onlyInPhaseB?: boolean } = {},
) {
  const phases = o.onlyInPhaseB ? [makePhase('A'), makePhase('B', { pages })] : [makePhase('A', { pages })];
  return {
    http: makeHttp({ chains, documents: o.documents ?? [], ...o.http }),
    browser: makeBrowser({ phases }),
  };
}

/** The HTTP collector stopped probing www.example.test. */
const THROTTLED = { http: { throttled: true, throttledHosts: ['www.example.test'] } };

const urls = (s: ReturnType<typeof snapshot>) => selectFormTwins(s).map((c) => c.url);

describe('selectFormTwins', () => {
  it('takes the pages with a form that takes data, as their http:// address, the page kept as visited', () => {
    const s = snapshot([
      visit('/', [SEARCH, CONTACT], { role: 'start' }),
      visit('/impressum/', [SEARCH], { role: 'impressum' }),
      visit('/kontakt/', [SEARCH, CONTACT], { role: 'contact' }),
      visit('/blog/post-1/', [SEARCH, COMMENTS]),
    ]);
    expect(selectFormTwins(s)).toEqual([
      {
        page: 'https://www.example.test/kontakt/',
        url: 'http://www.example.test/kontakt/',
        source: 'input-form',
      },
      {
        page: 'https://www.example.test/blog/post-1/',
        url: 'http://www.example.test/blog/post-1/',
        source: 'input-form',
      },
    ]);
  });

  it('a form asking for an e-mail address or a password comes first, otherwise the visit order', () => {
    const s = snapshot([
      visit('/shop/', [form()]),
      visit('/blog/post-1/', [COMMENTS]),
      visit('/konto/', [form({ hasPasswordField: true, fieldCount: 2 })]),
      visit('/gutschein/', [form({ fieldCount: 1 })]),
    ]);
    expect(urls(s)).toEqual([
      'http://www.example.test/blog/post-1/',
      'http://www.example.test/konto/',
      'http://www.example.test/shop/',
      'http://www.example.test/gutschein/',
    ]);
  });

  it('a contact form sent with GET takes input like one sent with POST', () => {
    const s = snapshot([visit('/kontakt/', [SEARCH, form({ method: 'get', fieldCount: 2 })])]);
    expect(urls(s)).toEqual(['http://www.example.test/kontakt/']);
  });

  it('a page the browser saw over http is its own http:// address', () => {
    const s = snapshot([
      makePage({
        url: 'http://www.example.test/kontakt/',
        role: 'contact',
        dom: makeDom({ forms: [CONTACT] }),
      }),
    ]);
    expect(urls(s)).toEqual(['http://www.example.test/kontakt/']);
  });

  it('each address once, also when two pages end on it', () => {
    const s = snapshot([
      visit('/kontakt/', [CONTACT]),
      visit('/kontakt-alt/', [CONTACT], { finalUrl: 'https://www.example.test/kontakt/' }),
    ]);
    expect(urls(s)).toEqual(['http://www.example.test/kontakt/']);
  });

  it('the www and the apex host each count by their own http:// root', () => {
    const s = snapshot(
      [
        visit('https://www.example.test/kontakt/', [CONTACT]),
        visit('https://example.test/kontakt/', [CONTACT]),
      ],
      [httpChain('www.example.test'), redirectedRoot('example.test')],
    );
    expect(urls(s)).toEqual(['http://www.example.test/kontakt/']);
  });

  it.each<[string, () => Parameters<typeof selectFormTwins>[0]]>([
    [
      'the http:// root redirects to https',
      () => snapshot([visit('/kontakt/', [CONTACT])], [redirectedRoot('www.example.test')]),
    ],
    [
      'the http:// root timed out',
      () =>
        snapshot(
          [visit('/kontakt/', [CONTACT])],
          [httpChain('www.example.test', [], { outcome: 'timeout' })],
        ),
    ],
    [
      'the http:// root answered 404',
      () => snapshot([visit('/kontakt/', [CONTACT])], [httpChain('www.example.test', [{ status: 404 }])]),
    ],
    [
      'the http:// root was probed only on an explicit port',
      () =>
        snapshot([visit('/kontakt/', [CONTACT])], [httpChain('www.example.test', undefined, { port: 8080 })]),
    ],
    ['the host was not probed', () => snapshot([visit('https://shop.example.test/kasse/', [CONTACT])])],
    [
      'the host throttled the HTTP collector',
      () => snapshot([visit('/kontakt/', [CONTACT])], undefined, THROTTLED),
    ],
    ['only a site search', () => snapshot([visit('/suche/', [SEARCH])])],
    [
      'a form with nothing to type in (hidden fields and a button)',
      () => snapshot([visit('/logout/', [form({ fieldCount: 1, takesInput: false })])]),
    ],
    [
      'browser facts of an older version (no takesInput)',
      () => snapshot([visit('/kontakt/', [form({ hasEmailField: true, takesInput: undefined })])]),
    ],
    [
      "the target's http:// probe keeps the scanned path: it does not speak for the host's root",
      () =>
        snapshot(
          [visit('/blog/post-1/', [COMMENTS])],
          [
            makeChain({
              startUrl: 'http://www.example.test/landing',
              hops: [makeHop({ url: 'http://www.example.test/landing', status: 200, bodyBytes: 20_000 })],
              outcome: 'ok',
            }),
          ],
        ),
    ],
    ['the page has a query', () => snapshot([visit('/?p=12', [COMMENTS])])],
    ['the page names a port', () => snapshot([visit('https://www.example.test:8443/kontakt/', [CONTACT])])],
    ['part of the address was redacted', () => snapshot([visit('/abo;token=[redacted]/', [CONTACT])])],
    ['the page was not evaluable', () => snapshot([visit('/kontakt/', [CONTACT], { evaluable: false })])],
    ['the page has no DOM facts', () => snapshot([visit('/kontakt/', [], { dom: null })])],
    [
      'the page was a bot challenge',
      () =>
        snapshot([
          visit('/kontakt/', [CONTACT], { challenge: { detected: true, kind: 'captcha', signals: [] } }),
        ]),
    ],
    [
      'the page was seen in phase B only',
      () => snapshot([visit('/kontakt/', [CONTACT], { phase: 'B' })], undefined, { onlyInPhaseB: true }),
    ],
    [
      'the start page: its http:// address is the probed root',
      () => snapshot([visit('/', [CONTACT], { role: 'start' })]),
    ],
    [
      'the address was already fetched as a linked document',
      () =>
        snapshot([visit('/kontakt/', [CONTACT])], undefined, {
          documents: [
            makeDocumentResponse({
              url: 'http://www.example.test/kontakt/',
              role: 'impressum',
              foundVia: 'link',
            }),
          ],
        }),
    ],
  ])('nothing to request: %s', (_name, build) => {
    expect(selectFormTwins(build())).toEqual([]);
  });

  it('nothing without a browser section', () => {
    expect(selectFormTwins({ http: makeHttp({ chains: [httpChain('www.example.test')] }) })).toEqual([]);
  });
});

describe('selectFormTwins: permalinks of the visited pages', () => {
  const POST = 'https://www.example.test/2025/02/beitrag/';
  const POST_TWIN = 'http://www.example.test/2025/02/beitrag/';

  /** A WordPress post date: `<a href="…" rel="bookmark"><time datetime="…">…</time></a>`. */
  const permalink = (href: string, p: Partial<LinkFact> = {}): LinkFact =>
    makeLink({
      href,
      hrefKind: href.startsWith('http:') ? 'http' : 'https',
      text: '14. März 2025',
      region: 'main',
      sameSite: true,
      rel: 'bookmark',
      permalink: true,
      ...p,
    });
  const linking = (
    path: string,
    links: LinkFact[],
    p: Partial<PageVisit> = {},
    forms: FormFact[] = [SEARCH],
  ) => makePage({ url: new URL(path, SITE).href, role: 'other', dom: makeDom({ forms, links }), ...p });
  const start = (links: LinkFact[], p: Partial<PageVisit> = {}) =>
    linking('/', links, { role: 'start', ...p });

  it('the http:// address of a post the start page links as its permalink, with the page that links it', () => {
    const s = snapshot([start([permalink(POST)]), visit('/impressum/', [SEARCH], { role: 'impressum' })]);
    expect(selectFormTwins(s)).toEqual([
      { page: POST, url: POST_TWIN, source: 'permalink', linkedFrom: SITE },
    ]);
  });

  it('pages with a form that takes data come first; then the start page links, then the other pages, each in document order', () => {
    const s = snapshot([
      linking('/news/', [permalink('https://www.example.test/news/drei/')], { order: 1 }),
      start([
        permalink('https://www.example.test/zwei/'),
        makeLink({ href: 'https://www.example.test/kontakt/', text: 'Kontakt', sameSite: true }),
        permalink('https://www.example.test/eins/'),
      ]),
      visit('/kontakt/', [CONTACT], { role: 'contact', order: 2 }),
    ]);
    expect(selectFormTwins(s).map((c) => [c.source, c.url])).toEqual([
      ['input-form', 'http://www.example.test/kontakt/'],
      ['permalink', 'http://www.example.test/zwei/'],
      ['permalink', 'http://www.example.test/eins/'],
      ['permalink', 'http://www.example.test/news/drei/'],
    ]);
  });

  it('each address once: linked twice, over http and https, with a fragment, or from two pages', () => {
    const s = snapshot([
      start([
        permalink(POST),
        permalink(`${POST}#comments`),
        permalink(POST_TWIN),
        permalink('https://www.example.test/zwei/'),
      ]),
      linking('/blog/', [permalink(POST), permalink('https://www.example.test/zwei/')], { order: 1 }),
    ]);
    expect(selectFormTwins(s).map((c) => [c.url, c.linkedFrom])).toEqual([
      [POST_TWIN, SITE],
      ['http://www.example.test/zwei/', SITE],
    ]);
  });

  it('a permalink to a page with a form that phase A visited is requested once, as that page', () => {
    const s = snapshot([
      start([permalink('https://www.example.test/blog/post-1/')]),
      visit('/blog/post-1/', [COMMENTS]),
    ]);
    expect(selectFormTwins(s)).toEqual([
      {
        page: 'https://www.example.test/blog/post-1/',
        url: 'http://www.example.test/blog/post-1/',
        source: 'input-form',
      },
    ]);
  });

  it('the www and the apex host each count by their own http:// root', () => {
    const s = snapshot(
      [start([permalink('https://example.test/apex-beitrag/'), permalink(POST)])],
      [httpChain('www.example.test'), redirectedRoot('example.test')],
    );
    expect(urls(s)).toEqual([POST_TWIN]);
  });

  it.each<[string, () => Parameters<typeof selectFormTwins>[0]]>([
    [
      'the permalink names another host',
      () => snapshot([start([permalink('https://blog.other.test/beitrag/')])]),
    ],
    [
      'the permalink names a host of the site whose http:// root was not probed',
      () => snapshot([start([permalink('https://blog.example.test/beitrag/')])]),
    ],
    ['the permalink has a query', () => snapshot([start([permalink('https://www.example.test/?p=12')])])],
    [
      'the permalink names a port',
      () => snapshot([start([permalink('https://www.example.test:8443/beitrag/')])]),
    ],
    [
      'part of the permalink was redacted',
      () => snapshot([start([permalink('https://www.example.test/beitrag;sid=[redacted]/')])]),
    ],
    [
      'the http:// root redirects to https',
      () => snapshot([start([permalink(POST)])], [redirectedRoot('www.example.test')]),
    ],
    [
      'the http:// root timed out',
      () => snapshot([start([permalink(POST)])], [httpChain('www.example.test', [], { outcome: 'timeout' })]),
    ],
    [
      'the host throttled the HTTP collector',
      () => snapshot([start([permalink(POST)])], undefined, THROTTLED),
    ],
    [
      'the post is a page of phase A (without a form that takes data)',
      () => snapshot([start([permalink(POST)]), linking(POST, [], { order: 1 })]),
    ],
    [
      'the post is a page of phase A that redirected to its final address',
      () =>
        snapshot([
          start([permalink(POST)]),
          linking('https://www.example.test/?p=12', [], { order: 1, finalUrl: POST }),
        ]),
    ],
    [
      'the post is the address of a page of phase A that redirected elsewhere',
      () =>
        snapshot([
          start([permalink(POST)]),
          linking(POST, [], { order: 1, finalUrl: 'https://www.example.test/2025/02/beitrag-neu/' }),
        ]),
    ],
    [
      'the permalink names the root, which the HTTP collector already requested',
      () => snapshot([start([permalink(SITE)])]),
    ],
    [
      'the address was already fetched as a linked document',
      () =>
        snapshot([start([permalink('https://www.example.test/impressum/')])], undefined, {
          documents: [
            makeDocumentResponse({
              url: 'http://www.example.test/impressum/',
              role: 'impressum',
              foundVia: 'link',
            }),
          ],
        }),
    ],
    [
      'browser facts of an older version: rel="bookmark" stored, no permalink flag',
      () => snapshot([start([permalink(POST, { permalink: undefined })])]),
    ],
    [
      'a link that is no permalink',
      () => snapshot([start([permalink(POST, { rel: 'nofollow', permalink: undefined })])]),
    ],
    [
      'a permalink that is not an http(s) address',
      () => snapshot([start([permalink(POST, { href: null, hrefKind: 'javascript' })])]),
    ],
    [
      'the linking page was a bot challenge',
      () =>
        snapshot([start([permalink(POST)], { challenge: { detected: true, kind: 'captcha', signals: [] } })]),
    ],
    ['the linking page was not evaluable', () => snapshot([start([permalink(POST)], { evaluable: false })])],
    [
      'the permalink was seen in phase B only',
      () => snapshot([start([permalink(POST)], { phase: 'B' })], undefined, { onlyInPhaseB: true }),
    ],
  ])('nothing to request: %s', (_name, build) => {
    expect(selectFormTwins(build())).toEqual([]);
  });
});
