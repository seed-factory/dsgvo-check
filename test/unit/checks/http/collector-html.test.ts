/** Pure HTML heuristics used by the HTTP collector; integration tests cover the collector itself. */
import { describe, expect, it, vi } from 'vitest';
import { redirectChainEvidence } from '../../../../src/checks/http/shared.ts';
import { type FetchResult, HttpClient } from '../../../../src/collectors/http/client.ts';
import { ProbeError } from '../../../../src/collectors/http/errors.ts';
import {
  detectClientRedirect,
  detectForm,
  extractMeta,
  findLegalLinks,
  parseAttributes,
} from '../../../../src/collectors/http/html.ts';
import { createHttpCollector, toHop } from '../../../../src/collectors/http/index.ts';
import { readResponseHead } from '../../../../src/collectors/http/response-head.ts';
import { htmlSection } from '../../../../src/collectors/http/rules.ts';
import { defaultConfig } from '../../../../src/core/config/schema.ts';
import { silentLogger } from '../../../../src/core/runtime/logger.ts';
import { makeSnapshot, makeTarget } from '../../../utils/snapshot-builder.ts';
import { chain } from './tls-01-fixtures.ts';

const BASE = 'http://www.example.test/start';

describe('parseAttributes', () => {
  it('reads quoted, unquoted and entity-encoded values', () => {
    const a = parseAttributes(
      `<meta http-equiv=refresh content="0; url=https://a.test/?x=1&amp;y=2" data-x='q'>`,
    );
    expect(a.get('http-equiv')).toBe('refresh');
    expect(a.get('content')).toBe('0; url=https://a.test/?x=1&y=2');
    expect(a.get('data-x')).toBe('q');
  });
});

describe('detectClientRedirect', () => {
  it('ignores refresh inside inert elements', () => {
    for (const element of ['noscript', 'template']) {
      expect(
        detectClientRedirect(
          `<${element}><meta http-equiv="refresh" content="0;url=/next"></${element}>`,
          BASE,
        ),
      ).toBeNull();
    }
  });

  it.each([
    [
      `<meta http-equiv="refresh" content="0;URL='https://www.example.test/'">`,
      'meta',
      'https://www.example.test/',
    ],
    [`<META HTTP-EQUIV="Refresh" CONTENT="5; url=/neu">`, 'meta', 'http://www.example.test/neu'],
    [
      `<script>window.location.href = "https://www.example.test/";</script>`,
      'js',
      'https://www.example.test/',
    ],
    [`<script>location.replace('https://www.example.test/x')</script>`, 'js', 'https://www.example.test/x'],
    [
      `<script>if (location.protocol !== 'https:') location.href = 'https://' + location.host + location.pathname;</script>`,
      'js',
      'https://www.example.test/start',
    ],
    [`<script>location.protocol = "https:";</script>`, 'js', 'https://www.example.test/start'],
  ])('%s → %s %s', (html, kind, url) => {
    expect(detectClientRedirect(html, BASE)).toEqual({ kind, url });
  });

  it.each([
    `<p>Wir haben die location = "https://x.test/" geändert</p>`,
    `<!-- <meta http-equiv="refresh" content="0;url=https://x.test/"> -->`,
    `<script>var geolocation = "https://x.test/";</script>`,
    `<script>if (location.href == "https://x.test/") {}</script>`,
  ])('no redirect: %s', (html) => {
    expect(detectClientRedirect(html, BASE)).toBeNull();
  });
});

describe('detectForm', () => {
  it.each([
    `<form action="/kontakt" method="post"><input name="email" type="email"><textarea name="msg"></textarea></form>`,
    `<form><input name="name"></form>`,
    `<form><select name="anrede"></select></form>`,
    `<form><textarea name="nachricht">Ihre <b>Nachricht</b></textarea></form>`,
    `<form><input type="password" name="pw">`,
  ])('data form: %s', (html) => {
    expect(detectForm(html)).toBe(true);
  });

  it.each([
    `<form role="search"><input name="q"></form>`,
    `<form class="search-form"><input type="text" name="term"></form>`,
    `<form><input type="search" name="x"><input type="submit"></form>`,
    `<form><input type="text" name="s"><input type="hidden" name="lang" value="de"></form>`,
    `<p>no form</p>`,
  ])('not a data form: %s', (html) => {
    expect(detectForm(html)).toBe(false);
  });

  // markup inside raw-text / inert elements is not a form in the document.
  it.each([
    `<script>const html = "<form><input name=email></form>";</script>`,
    `<script type="text/template"><form><input name="email"></form></script>`,
    `<template><form><input name="email"></form></template>`,
    `<noscript><form><input name="email"></form></noscript>`,
    `<textarea readonly>&lt;form&gt;<form><input name="email"></form></textarea>`,
    `<style>/* <form><input name=email></form> */</style>`,
    `<SCRIPT>document.write('<form><input name="e"></form>')</SCRIPT >`,
  ])('markup in script/template/noscript/textarea/style is not a form: %s', (html) => {
    expect(detectForm(html)).toBe(false);
  });

  it('a real form after an inline script is still found', () => {
    const html = `<script>var t = "<form>";</script><form method="post"><input name="email"></form>`;
    expect(detectForm(html)).toBe(true);
  });
});

describe('extractMeta', () => {
  it('collects http-equiv pairs and meta referrer', () => {
    const html = `<head><meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'">
      <meta name="referrer" content="no-referrer"><meta charset="utf-8"></head>`;
    expect(extractMeta(html)).toEqual({
      httpEquiv: [{ name: 'content-security-policy', value: "frame-ancestors 'none'" }],
      referrer: 'no-referrer',
    });
  });
});

describe('findLegalLinks', () => {
  it('finds Impressum and Datenschutz links, skips cookie settings', () => {
    const html = `
      <a href="#" onclick="openCmp()">Datenschutzeinstellungen</a>
      <a href="/privacy-settings">Cookie-Einstellungen</a>
      <footer><a href="/impressum/">Impressum</a> | <a href="https://www.example.test/datenschutzerklaerung">Datenschutz</a></footer>`;
    expect(findLegalLinks(html, BASE)).toEqual({
      impressum: 'http://www.example.test/impressum/',
      privacy: 'https://www.example.test/datenschutzerklaerung',
    });
  });

  it('matches by path when the link text is an icon', () => {
    expect(findLegalLinks(`<a href="/de/imprint"><svg></svg></a>`, BASE)).toEqual({
      impressum: 'http://www.example.test/de/imprint',
    });
  });

  // Site builders keep the slug of a copied page: the privacy policy may live at /impressum-2.
  it('the link text decides before the path', () => {
    const html = `
      <nav><a href="/impressum-2">Datenschutz</a></nav>
      <footer><a href="/seite-3">Impressum</a> | <a href="/impressum-2">Datenschutz</a></footer>`;
    expect(findLegalLinks(html, BASE)).toEqual({
      impressum: 'http://www.example.test/seite-3',
      privacy: 'http://www.example.test/impressum-2',
    });
  });

  const a = (href: string, text: string) => `<a href="${href}">${text}</a>`;

  it.each([
    [
      'a link named Datenschutz is not the Impressum by its path',
      a('/impressum-und-mehr', 'Datenschutz'),
      {
        privacy: '/impressum-und-mehr',
      },
    ],
    [
      'a link named Impressum is not the privacy policy by its path',
      a('/datenschutz-info', 'Impressum'),
      {
        impressum: '/datenschutz-info',
      },
    ],
    [
      'a page linked for both documents is the Impressum only',
      a('/rechtliches', 'Impressum &amp; Datenschutz'),
      {
        impressum: '/rechtliches',
      },
    ],
    [
      'a page linked for both documents gives way to a later link named for the privacy policy alone',
      '<a href="/impressum-datenschutz">Impressum &amp; Datenschutz</a><a href="/datenschutz">Datenschutzerklärung</a>',
      {
        impressum: '/impressum-datenschutz',
        privacy: '/datenschutz',
      },
    ],
    [
      'a page linked for both documents gives way to a later privacy path match',
      '<a href="/rechtliches">Impressum &amp; Datenschutz</a><a href="/datenschutz"><svg></svg></a>',
      {
        impressum: '/rechtliches',
        privacy: '/datenschutz',
      },
    ],
    [
      'a page linked for both documents after the Impressum link is the privacy policy',
      '<a href="/impressum">Impressum</a><a href="/rechtliches">Impressum &amp; Datenschutz</a>',
      {
        impressum: '/impressum',
        privacy: '/rechtliches',
      },
    ],
    [
      'a page linked for both documents comes before a privacy link found only by its path',
      '<a href="/impressum">Impressum</a><a href="/datenschutz"><svg></svg></a><a href="/rechtliches">Impressum &amp; Datenschutz</a>',
      {
        impressum: '/impressum',
        privacy: '/rechtliches',
      },
    ],
    [
      'an anchor on the Impressum page is the Impressum only',
      '<a href="/impressum">Impressum</a><a href="/impressum#datenschutz">Datenschutz</a>',
      {
        impressum: '/impressum',
      },
    ],
    [
      'a link is kept without the anchor it jumps to',
      '<a href="/impressum#top">Impressum</a><a href="/datenschutz#cookies">Datenschutz</a>',
      {
        impressum: '/impressum',
        privacy: '/datenschutz',
      },
    ],
    [
      'a path match still counts when no text names the document',
      '<a href="/impressum"><svg></svg></a><a href="/datenschutz"><img alt=""></a>',
      {
        impressum: '/impressum',
        privacy: '/datenschutz',
      },
    ],
  ])('%s', (_, html, expected) => {
    expect(findLegalLinks(html, BASE)).toEqual(
      Object.fromEntries(
        Object.entries(expected).map(([kind, path]) => [kind, `http://www.example.test${path}`]),
      ),
    );
  });

  it('ignores mailto and javascript links', () => {
    expect(findLegalLinks(`<a href="mailto:datenschutz@example.test">Datenschutz</a>`, BASE)).toEqual({});
  });
});

describe('HTML wording is data (test/data/http/html.yaml)', () => {
  const own = htmlSection.parse({
    html: {
      form: { searchFieldNames: ['find'], searchFormMarkers: ['lookup'] },
      legalLinks: {
        impressumText: ['mentions légales'],
        impressumPath: ['mentions'],
        privacyText: ['confidentialité'],
        privacyPath: ['confidentialite'],
        settingsText: ['préférences'],
      },
    },
  });

  it('a field named like a site search, and a form marked as one, take no user input', () => {
    const field = '<form><input name="find"></form>';
    expect(detectForm(field)).toBe(true);
    expect(detectForm(field, own)).toBe(false);
    const marked = '<form class="lookup-box"><input name="x"></form>';
    expect(detectForm(marked)).toBe(true);
    expect(detectForm(marked, own)).toBe(false);
  });

  it('link wording and paths of the Impressum and the privacy policy', () => {
    const html =
      '<a href="/mentions-legales">Mentions légales</a>' +
      '<a href="/prefs">Préférences de confidentialité</a>' +
      '<a href="/politique">Politique de confidentialité</a>';
    expect(findLegalLinks(html, BASE)).toEqual({});
    expect(findLegalLinks(html, BASE, own)).toEqual({
      impressum: 'http://www.example.test/mentions-legales',
      privacy: 'http://www.example.test/politique',
    });
  });
});

describe('form facts of a plain-http page: the whole body that was read', () => {
  const KIB = 1024;
  const PAGE_URL = 'http://www.example.test/post-1/';
  const filler = (bytes: number): string => {
    const unit = '<p>Ein Absatz Text auf der Seite, damit sie lang wird.</p>\n';
    return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  };
  const page = (body: string) =>
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
  // Field names and values the snapshot must never hold.
  const COMMENT_FORM =
    '<form action="http://www.example.test/wp-comments-post.php" method="post" id="commentform">' +
    '<textarea name="comment">fixture-comment-text</textarea>' +
    '<input name="author" value="fixture-author-value"><input type="submit" value="Senden"></form>';

  function response(html: string, p: Partial<FetchResult> = {}): FetchResult {
    const body = Buffer.from(html);
    return {
      url: PAGE_URL,
      status: 200,
      headers: [],
      setCookieNames: [],
      blankHeaderNames: [],
      location: null,
      contentType: 'text/html; charset=utf-8',
      body,
      bodyBytes: body.length,
      bodyTruncated: false,
      conn: null,
      durationMs: 5,
      requestedAt: '2026-10-30T12:00:00.000Z',
      ...p,
    };
  }

  const pageHop = (body: string, overrides?: Partial<FetchResult>) => toHop(response(page(body), overrides));
  const form = (attributes: string) => `<form ${attributes}><textarea></textarea></form>`;

  describe('redirect targets in snapshots and evidence', () => {
    it.each([
      ['javascript:alert(visitorSecret)', 'javascript:[redacted]'],
      ['/u/alice@intranet', '[redacted]', 'http://www.example.test/[redacted]'],
      ['/next?session=visitorSecret', 'http://www.example.test/next?session=[redacted]'],
      ['https://www.example.test/next?id=G-123', 'https://www.example.test/next?id=G-123'],
    ])('keeps only the redacted Location for %s', (location, header, expected = header) => {
      const fetched = response('', { status: 302, ...readResponseHead({ location }, PAGE_URL) });
      expect(fetched.location).toBe(new URL(location, PAGE_URL).href);

      const hop = toHop(fetched);
      expect(hop.headers).toEqual([{ name: 'location', value: header }]);
      expect(hop.location).toBe(expected);
      expect(redirectChainEvidence(chain(PAGE_URL, [hop]))).toMatchObject({ hops: [{ location: expected }] });
    });

    it.each(['ok', 'connection-refused'] as const)(
      'keeps the raw redirect path only for navigation when the next request is %s',
      async (outcome) => {
        const raw = new URL('/u/alice@intranet/start', PAGE_URL).href;
        const legal = new URL('legal', raw).href;
        const notice = new URL('notice', legal).href;
        const privacy = new URL('/datenschutz', raw).href;
        const stored = 'http://www.example.test/[redacted]';
        const formBody = '<form method="post"><input name="email"></form>';
        const get = vi.spyOn(HttpClient.prototype, 'get').mockImplementation(async (url) => {
          if (url === PAGE_URL) {
            return response('', { url, status: 302, ...readResponseHead({ location: raw }, url) });
          }
          if (url === raw) {
            if (outcome === 'connection-refused') {
              throw new ProbeError('ECONNREFUSED', `connection refused at ${url}`);
            }
            const links = '<a href="legal">Impressum</a><a href="/datenschutz">Datenschutz</a>';
            return response(page(formBody + links), { url });
          }
          if (url === legal) {
            return response('', { url, status: 302, ...readResponseHead({ location: 'notice' }, url) });
          }
          return response(page(formBody), { url });
        });
        const target = makeTarget(PAGE_URL);
        const lookup = vi.fn(async () => []);

        try {
          const result = await createHttpCollector()({
            target,
            snapshot: makeSnapshot({ target }),
            network: { lookup, proxy: null, allowPrivateAddresses: false, dnsServers: [] },
            config: defaultConfig(),
            userAgent: { http: 'scanner test', token: 'scanner test' },
            signal: new AbortController().signal,
            deadline: Date.now() + 10_000,
            options: { maxPages: 1, screenshots: false, sandbox: 'off', lang: 'de', assumeRegion: null },
            artifactsDir: '/unused-artifacts',
            artifactsRelDir: 'artifacts',
            now: () => new Date('2026-10-30T12:00:00.000Z'),
            log: silentLogger,
          });
          expect(lookup).not.toHaveBeenCalled();
          expect(get).toHaveBeenCalledWith(raw, expect.any(Number));

          const http = result.sections.http!;
          const redirect = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http')!;
          expect(redirect.outcome).toBe(outcome);
          if (outcome === 'ok') {
            expect(redirect.final).toMatchObject({ url: stored, forms: [{ action: stored }] });
            expect(result.handover?.chainUrls?.[redirect.id]?.final).toBe(raw);
            expect(http.documents.find((d) => d.role === 'start')?.finalUrl).toBe(stored);
            for (const target of [legal, notice, privacy]) {
              expect(get).toHaveBeenCalledWith(target, expect.any(Number));
            }
            expect(result.probes).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ purpose: 'security-headers:impressum', target: stored }),
                expect.objectContaining({ purpose: 'security-headers:privacy', target: privacy }),
              ]),
            );
            expect(http.documents.find((d) => d.role === 'impressum')).toMatchObject({
              url: stored,
              finalUrl: stored,
              forms: [{ action: stored }],
            });
          } else {
            expect(redirect.error?.url).toBe(stored);
          }
          expect(redirect.hops[0]?.location).toBe(stored);
          const persisted = { http, probes: result.probes, evidence: redirectChainEvidence(redirect) };
          expect(JSON.stringify(persisted)).not.toContain('alice');
        } finally {
          get.mockRestore();
        }
      },
    );

    it.each([
      [
        '<meta http-equiv="refresh" content="0;url=/u/alice@intranet">',
        'meta',
        'http://www.example.test/[redacted]',
      ],
      [
        '<script>location.href = "https://www.example.test/u/alice@intranet"</script>',
        'js',
        'https://www.example.test/[redacted]',
      ],
      [
        '<meta http-equiv="refresh" content="0;url=/next?session=visitorSecret">',
        'meta',
        'http://www.example.test/next?session=[redacted]',
      ],
      [
        '<script>location.href = "https://www.example.test/next"</script>',
        'js',
        'https://www.example.test/next',
      ],
      ['<meta http-equiv="refresh" content="0;url=javascript:alert(visitorSecret)">', 'meta', null],
    ])('redacts the URL of a client redirect in %s', (markup, kind, url) => {
      expect(pageHop(markup).clientRedirect).toEqual({ kind, url });
    });
  });

  it('a comment form after 70 KiB of a 90 KiB page is found, with where it sends its input', () => {
    const html = page(`${filler(70 * KIB)}${COMMENT_FORM}${filler(20 * KIB)}`);
    expect(Buffer.byteLength(html)).toBeGreaterThan(90 * KIB);
    expect(toHop(response(html))).toMatchObject({
      hasForm: true,
      formInspection: 'complete',
      forms: [
        { action: 'http://www.example.test/wp-comments-post.php', actionScheme: 'http', method: 'post' },
      ],
    });
  });

  it('a form that starts before 64 KiB and has its field after it is found', () => {
    const open = '<form method="post" action="/kontakt/senden">';
    const html = page(
      `${filler(64 * KIB - open.length - 60)}${open}${filler(2 * KIB)}<textarea name="m"></textarea></form>`,
    );
    expect(html.indexOf('<textarea')).toBeGreaterThan(64 * KIB);
    expect(toHop(response(html))).toMatchObject({
      hasForm: true,
      forms: [{ action: 'http://www.example.test/kontakt/senden', actionScheme: 'http', method: 'post' }],
    });
  });

  it('a body cut before the form says so: no form seen, inspection truncated', () => {
    const hop = pageHop(filler(80 * KIB), { bodyTruncated: true });
    expect(hop).toMatchObject({ hasForm: false, forms: [], formInspection: 'truncated' });
  });

  it('a form in the part of a cut body that was read still counts', () => {
    const hop = pageHop(`${filler(10 * KIB)}${COMMENT_FORM}`, { bodyTruncated: true });
    expect(hop).toMatchObject({ hasForm: true, formInspection: 'truncated' });
  });

  it.each<[string, Partial<FetchResult>]>([
    ['an encoding without a decoder', { undecodedEncoding: 'zstd' }],
    ['a corrupt gzip stream', { undecodedEncoding: 'gzip' }],
    ['an encoding without a decoder and no Content-Type', { undecodedEncoding: 'zstd', contentType: null }],
  ])('a body the collector could not decode (%s) is unavailable, not form-free', (_name, p) => {
    const hop = toHop(response('(µ/ý binary <meta http-equiv="refresh" content="0;url=https://x.test/">', p));
    expect(hop).toMatchObject({ hasForm: false, forms: [], formInspection: 'unavailable' });
    expect(hop.clientRedirect).toBeUndefined();
  });

  it('a decoded body that is no HTML and names no type is not inspected', () => {
    const hop = toHop(response('%PDF-1.7 binary', { contentType: null }));
    expect(hop.formInspection).toBeUndefined();
  });

  // Counterexamples after the first 64 KiB: what takes no input, or is no form of the document.
  it.each([
    ['a site search (role=search)', '<form role="search" action="/"><input name="x"></form>'],
    ['a site search (field s)', '<form action="/"><input type="text" name="s"><input type="submit"></form>'],
    [
      'hidden fields only',
      '<form method="post"><input type="hidden" name="a" value="1"><button>OK</button></form>',
    ],
    ['markup in a script', '<script>var f = "<form method=post><textarea></textarea></form>";</script>'],
    ['markup in a template', '<template><form method="post"><textarea></textarea></form></template>'],
    ['markup in noscript', '<noscript><form method="post"><input name="email"></form></noscript>'],
    [
      'markup in a textarea',
      '<textarea>&lt;form&gt;<form method="post"><input name="email"></form></textarea>',
    ],
  ])('%s after 64 KiB is no data form', (_name, markup) => {
    const hop = pageHop(`${filler(70 * KIB)}${markup}`);
    expect(hop).toMatchObject({ hasForm: false, forms: [], formInspection: 'complete' });
  });

  it.each([
    ['no action: the page itself', form('method="post"'), PAGE_URL, 'http'],
    ['an empty action: the page itself', form('action="" method="post"'), PAGE_URL, 'http'],
    ['a relative action', form('action="../senden" method="post"'), 'http://www.example.test/senden', 'http'],
    [
      'an https action',
      form('action="https://www.example.test/senden" method="post"'),
      'https://www.example.test/senden',
      'https',
    ],
    [
      'a query in the action is redacted',
      form('action="/senden?token=abc123&amp;v=2" method="post"'),
      'http://www.example.test/senden?token=[redacted]&v=2',
      'http',
    ],
    ['a javascript: action is no address', form('action="javascript:void(0)"'), null, 'other'],
    [
      'a mailto: action is no address',
      form('action="mailto:info@example.test" method="post"'),
      null,
      'other',
    ],
  ])('action: %s', (_name, markup, action, actionScheme) => {
    expect(pageHop(markup).forms).toEqual([{ action, actionScheme, method: expect.any(String) }]);
  });

  it('markup inside an attribute value is no form, and nothing of the value is kept', () => {
    const hidden =
      '<input type="hidden" name="payload" value=\'<form action="/private-field-value"><textarea></textarea></form>\'>';
    const hop = pageHop(hidden);
    expect(hop).toMatchObject({ hasForm: false, forms: [], formInspection: 'complete' });
    expect(JSON.stringify(hop)).not.toContain('private-field-value');
  });

  it('a ">" in a quoted attribute of the form tag does not end it: action and method are read', () => {
    const markup = form('aria-label="a > b" action="https://forms.example.test/send" method="post"');
    expect(pageHop(markup).forms).toEqual([
      { action: 'https://forms.example.test/send', actionScheme: 'https', method: 'post' },
    ]);
  });

  it('a field after a quoted ">" in an earlier field still counts', () => {
    const markup = '<form method="post"><input type="submit" value="Weiter >"><input name="email"></form>';
    expect(pageHop(markup).hasForm).toBe(true);
  });

  it.each([
    [
      'a relative action resolves against <base href>',
      '<base href="https://forms.example.test/api/"><form method="post" action="send"><textarea></textarea></form>',
      'https://forms.example.test/api/send',
      'https',
    ],
    [
      'an empty action is the page itself, not the base',
      '<base href="https://forms.example.test/api/"><form method="post" action=""><textarea></textarea></form>',
      PAGE_URL,
      'http',
    ],
    [
      'a relative <base href> resolves against the page',
      '<base href="/de/"><form method="post" action="senden"><textarea></textarea></form>',
      'http://www.example.test/de/senden',
      'http',
    ],
    [
      'only the first <base> with an href counts',
      '<base target="_blank"><base href="https://a.example.test/"><base href="https://b.example.test/"><form method="post" action="x"><textarea></textarea></form>',
      'https://a.example.test/x',
      'https',
    ],
    [
      'a <base> in a template is no base',
      '<template><base href="https://forms.example.test/"></template><form method="post" action="x"><textarea></textarea></form>',
      'http://www.example.test/post-1/x',
      'http',
    ],
    [
      'a <base> that is no http(s) address leaves the page as base',
      '<base href="javascript:alert(1)"><form method="post" action="x"><textarea></textarea></form>',
      'http://www.example.test/post-1/x',
      'http',
    ],
  ])('base URL: %s', (_name, markup, action, actionScheme) => {
    expect(pageHop(markup).forms).toEqual([{ action, actionScheme, method: 'post' }]);
  });

  it.each([
    ['POST', 'post'],
    ['dialog', 'dialog'],
    ['put', 'get'],
    ['', 'get'],
  ])('method %j is read as %s', (method, expected) => {
    const hop = pageHop(form(`method="${method}"`));
    expect(hop.forms?.[0]?.method).toBe(expected);
  });

  it('keeps at most five forms and no field name or value', () => {
    const hop = pageHop(COMMENT_FORM.repeat(8));
    expect(hop.hasForm).toBe(true);
    expect(hop.forms).toHaveLength(5);
    const stored = JSON.stringify(hop);
    for (const secret of ['fixture-comment-text', 'fixture-author-value', 'author', 'commentform']) {
      expect(stored).not.toContain(secret);
    }
  });

  it.each([
    ['an https page', { url: 'https://www.example.test/post-1/' }],
    ['a redirect', { status: 301, location: 'http://www.example.test/next' }],
    ['an error page', { status: 404 }],
    ['a page that is no HTML', { contentType: 'application/pdf' }],
  ])('%s is not inspected for forms', (_name, p) => {
    const hop = pageHop(COMMENT_FORM, p);
    expect(hop.hasForm).toBeUndefined();
    expect(hop.forms).toBeUndefined();
    expect(hop.formInspection).toBeUndefined();
  });
});
