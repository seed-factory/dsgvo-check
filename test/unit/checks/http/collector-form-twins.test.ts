/**
 * Which http:// addresses the step after the browser requests: pages of phase A with a form that takes data, on a host
 * whose http:// root served content without a redirect, each address once and none the HTTP collector already fetched.
 * The requests themselves are covered on the fixture server (test/integration/http/form-twins.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { selectFormTwins } from '../../../../src/collectors/http/form-twins.ts';
import type { FormFact, PageVisit } from '../../../../src/core/snapshot/browser.ts';
import type { DocumentResponse, HttpHop, RedirectChain } from '../../../../src/core/snapshot/http.ts';
import {
  makeBrowser,
  makeChain,
  makeDocumentResponse,
  makeDom,
  makeHop,
  makeHttp,
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

function snapshot(
  pages: PageVisit[],
  chains: RedirectChain[] = [httpChain('www.example.test')],
  documents: DocumentResponse[] = [],
) {
  return {
    http: makeHttp({ chains, documents }),
    browser: makeBrowser({ phases: [makePhase('A', { pages })] }),
  };
}

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
      { page: 'https://www.example.test/kontakt/', url: 'http://www.example.test/kontakt/' },
      { page: 'https://www.example.test/blog/post-1/', url: 'http://www.example.test/blog/post-1/' },
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
      [
        httpChain('www.example.test'),
        httpChain('example.test', [
          { status: 301, location: 'https://example.test/' },
          { url: 'https://example.test/', status: 200 },
        ]),
      ],
    );
    expect(urls(s)).toEqual(['http://www.example.test/kontakt/']);
  });

  it.each<[string, () => Parameters<typeof selectFormTwins>[0]]>([
    [
      'the http:// root redirects to https',
      () =>
        snapshot(
          [visit('/kontakt/', [CONTACT])],
          [
            httpChain('www.example.test', [
              { status: 301, location: SITE },
              { url: SITE, status: 200 },
            ]),
          ],
        ),
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
      () => ({
        http: makeHttp({
          chains: [httpChain('www.example.test')],
          throttled: true,
          throttledHosts: ['www.example.test'],
        }),
        browser: makeBrowser({ phases: [makePhase('A', { pages: [visit('/kontakt/', [CONTACT])] })] }),
      }),
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
      () => ({
        http: makeHttp({ chains: [httpChain('www.example.test')] }),
        browser: makeBrowser({
          phases: [
            makePhase('A'),
            makePhase('B', { pages: [visit('/kontakt/', [CONTACT], { phase: 'B' })] }),
          ],
        }),
      }),
    ],
    [
      'the start page: its http:// address is the probed root',
      () => snapshot([visit('/', [CONTACT], { role: 'start' })]),
    ],
    [
      'the address was already fetched as a linked document',
      () =>
        snapshot([visit('/kontakt/', [CONTACT])], undefined, [
          makeDocumentResponse({
            url: 'http://www.example.test/kontakt/',
            role: 'impressum',
            foundVia: 'link',
          }),
        ]),
    ],
  ])('nothing to request: %s', (_name, build) => {
    expect(selectFormTwins(build())).toEqual([]);
  });

  it('nothing without a browser section', () => {
    expect(selectFormTwins({ http: makeHttp({ chains: [httpChain('www.example.test')] }) })).toEqual([]);
  });
});
