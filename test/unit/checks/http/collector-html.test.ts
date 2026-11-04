/** Pure HTML heuristics used by the HTTP collector; integration tests cover the collector itself. */
import { describe, expect, it } from 'vitest';
import {
  detectClientRedirect,
  detectForm,
  extractMeta,
  findLegalLinks,
  parseAttributes,
} from '../../../../src/collectors/http/html.ts';
import { htmlSection } from '../../../../src/collectors/http/rules.ts';

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

  it.each([
    [
      'a link named Datenschutz is not the Impressum by its path',
      '<a href="/impressum-und-mehr">Datenschutz</a>',
      {
        privacy: 'http://www.example.test/impressum-und-mehr',
      },
    ],
    [
      'a link named Impressum is not the privacy policy by its path',
      '<a href="/datenschutz-info">Impressum</a>',
      {
        impressum: 'http://www.example.test/datenschutz-info',
      },
    ],
    [
      'a page linked for both documents is the Impressum only',
      '<a href="/rechtliches">Impressum &amp; Datenschutz</a>',
      {
        impressum: 'http://www.example.test/rechtliches',
      },
    ],
    [
      'a page linked for both documents gives way to a later link named for the privacy policy alone',
      '<a href="/impressum-datenschutz">Impressum &amp; Datenschutz</a><a href="/datenschutz">Datenschutzerklärung</a>',
      {
        impressum: 'http://www.example.test/impressum-datenschutz',
        privacy: 'http://www.example.test/datenschutz',
      },
    ],
    [
      'a page linked for both documents gives way to a later privacy path match',
      '<a href="/rechtliches">Impressum &amp; Datenschutz</a><a href="/datenschutz"><svg></svg></a>',
      {
        impressum: 'http://www.example.test/rechtliches',
        privacy: 'http://www.example.test/datenschutz',
      },
    ],
    [
      'a page linked for both documents after the Impressum link is the privacy policy',
      '<a href="/impressum">Impressum</a><a href="/rechtliches">Impressum &amp; Datenschutz</a>',
      {
        impressum: 'http://www.example.test/impressum',
        privacy: 'http://www.example.test/rechtliches',
      },
    ],
    [
      'a page linked for both documents comes before a privacy link found only by its path',
      '<a href="/impressum">Impressum</a><a href="/datenschutz"><svg></svg></a><a href="/rechtliches">Impressum &amp; Datenschutz</a>',
      {
        impressum: 'http://www.example.test/impressum',
        privacy: 'http://www.example.test/rechtliches',
      },
    ],
    [
      'an anchor on the Impressum page is the Impressum only',
      '<a href="/impressum">Impressum</a><a href="/impressum#datenschutz">Datenschutz</a>',
      {
        impressum: 'http://www.example.test/impressum',
      },
    ],
    [
      'a link is kept without the anchor it jumps to',
      '<a href="/impressum#top">Impressum</a><a href="/datenschutz#cookies">Datenschutz</a>',
      {
        impressum: 'http://www.example.test/impressum',
        privacy: 'http://www.example.test/datenschutz',
      },
    ],
    [
      'a path match still counts when no text names the document',
      '<a href="/impressum"><svg></svg></a><a href="/datenschutz"><img alt=""></a>',
      {
        impressum: 'http://www.example.test/impressum',
        privacy: 'http://www.example.test/datenschutz',
      },
    ],
  ])('%s', (_, html, expected) => {
    expect(findLegalLinks(html, BASE)).toEqual(expected);
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
