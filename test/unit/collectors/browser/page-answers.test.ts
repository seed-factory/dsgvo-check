/**
 * What the page code returns is checked in Node: it runs in the page's main world, whose script can replace the globals
 * it calls, so every field of an answer can be any value the page chooses. Strings, flags, counts, regions, kinds,
 * boxes and attribute tokens of a hostile answer never reach the stored facts; a normal page keeps its facts. Markers
 * start with `zq8`.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { RawDomFacts } from '../../../../src/collectors/browser/in-page/dom.ts';
import {
  checkedRawDocument,
  documentLang,
  extractDocument,
} from '../../../../src/collectors/browser/legal/documents.ts';
import {
  checkedRawDom,
  collectDom,
  mapLinks,
  parseLinkHeader,
} from '../../../../src/collectors/browser/pages/dom-facts.ts';
import { revealBelowFold } from '../../../../src/collectors/browser/pages/reveal.ts';
import type { NetworkRecorder } from '../../../../src/collectors/browser/recording/recorder.ts';
import { legalPage, POLICY, privacyContext, rawPolicy } from './legal/fakes.ts';

const target = { etld1: 'example.test', host: 'www.example.test' };
const START = 'https://www.example.test/';

/** The DOM answer of a normal page: the values that must be kept as they are. */
const normalDom = (): RawDomFacts => ({
  title: 'Beispiel GmbH',
  lang: 'de-DE',
  h1: 'Willkommen',
  links: [
    {
      href: 'https://www.example.test/impressum/',
      attr: '/impressum/',
      text: 'Impressum',
      name: '',
      region: 'footer',
      visible: true,
      inShadowDom: false,
      rel: 'noopener noreferrer',
      hreflang: '',
    },
  ],
  forms: [
    {
      action: 'https://www.example.test/kontakt/',
      method: 'post',
      visible: true,
      fieldCount: 3,
      hasPasswordField: false,
      hasEmailField: true,
      takesInput: true,
    },
  ],
  iframes: [
    {
      src: 'https://maps.example.net/embed',
      srcdoc: false,
      title: 'Karte',
      visible: true,
      box: { x: 0, y: 100, width: 600, height: 400 },
      loading: 'lazy',
    },
  ],
  linkRels: [{ rel: 'preconnect stylesheet', href: 'https://fonts.example.net/css', as: 'style' }],
  scripts: [
    { src: '', inline: true, type: 'text/plain', async: false, defer: false },
    { src: 'https://www.example.test/app.js', inline: false, type: 'module', async: true, defer: false },
  ],
  metaRefresh: null,
  visibleTextLength: 1234,
  textSample: 'Willkommen',
  placeholders: [{ kind: 'maps', text: 'Karte laden' }],
  linksTotal: 1,
  linksTruncated: false,
});

/** The same page after its script replaced the globals the page code calls: every field is the page's choice. */
const hostileDom = (): Record<string, unknown> => ({
  ...normalDom(),
  title: { toString: () => 'zq8title' },
  lang: 'de https://example.test/?sid=zq8lang alice@example.com',
  links: [
    {
      ...normalDom().links[0],
      region: 'alice@example.com',
      visible: '?sid=zq8visible',
      inShadowDom: 'zq8shadow',
      rel: 'nofollow sid=zq8rel alice@example.com',
    },
  ],
  forms: [
    {
      ...normalDom().forms[0],
      method: 'post?token=zq8method&mail=alice@example.com',
      visible: 'zq8',
      fieldCount: 'zq8count',
      hasPasswordField: 1,
    },
  ],
  iframes: [{ ...normalDom().iframes[0], srcdoc: 'zq8', box: { x: 'zq8x', y: 0, width: 1, height: 1 } }],
  linkRels: [
    {
      rel: 'stylesheet alice@example.com ?sid=zq8linkrel',
      href: 'https://cdn.example.net/a.css',
      as: 'style zq8as',
    },
  ],
  scripts: [{ src: '', inline: 'zq8', type: 'text/plain; sid=zq8type alice@example.com', async: 'zq8' }],
  visibleTextLength: '4f3a9c1d-zq8',
  placeholders: [{ kind: 'zq8kind', text: 'Karte laden' }],
  linksTruncated: 'zq8',
});

/** A page whose only in-page read is the DOM walk, answered with `raw`. */
function domPage(raw: unknown): Page {
  return {
    evaluate: async () => raw,
    url: () => START,
    frames: () => [],
  } as unknown as Page;
}

describe('DOM facts of a page whose script answers for the page code', () => {
  it('nothing of the hostile answer is stored, and the planner sees the closed regions only', async () => {
    const { dom, candidates } = await collectDom(domPage(hostileDom()), target, []);

    expect(JSON.stringify(dom)).not.toContain('zq8');
    expect(JSON.stringify(dom)).not.toContain('alice@');
    expect(dom.lang).toBeUndefined();
    expect(dom.links[0]).toMatchObject({
      region: 'other',
      visible: false,
      inShadowDom: false,
      rel: 'nofollow',
    });
    expect(candidates[0]).toMatchObject({ region: 'other', visible: false });
    expect(dom.forms[0]).toMatchObject({
      method: 'get',
      visible: false,
      fieldCount: 0,
      hasPasswordField: false,
    });
    expect(dom.iframes[0]).toMatchObject({ srcdoc: false, box: null });
    expect(dom.linkRels).toEqual([
      { rel: 'stylesheet', href: 'https://cdn.example.net/a.css', source: 'dom' },
    ]);
    expect(dom.scripts[0]).toEqual({ src: null, inline: false, type: 'text/plain' });
    expect(dom.visibleTextLength).toBe(0);
    expect(dom.embedPlaceholders).toEqual([{ kind: 'other', text: 'Karte laden' }]);
    expect(dom.linksTruncated).toBeUndefined();
  });

  it('counterexample: a normal page keeps its language tag as written and its tokens', async () => {
    const { dom } = await collectDom(domPage(normalDom()), target, []);

    expect(dom).toMatchObject({
      title: 'Beispiel GmbH',
      lang: 'de-DE',
      h1: 'Willkommen',
      visibleTextLength: 1234,
    });
    expect(dom.links[0]).toMatchObject({ region: 'footer', visible: true, rel: 'noopener noreferrer' });
    expect(dom.forms[0]).toMatchObject({
      method: 'post',
      fieldCount: 3,
      hasEmailField: true,
      takesInput: true,
    });
    expect(dom.iframes[0]).toMatchObject({ box: { x: 0, y: 100, width: 600, height: 400 }, loading: 'lazy' });
    expect(dom.linkRels).toEqual([
      { rel: 'preconnect stylesheet', href: 'https://fonts.example.net/css', as: 'style', source: 'dom' },
    ]);
    expect(dom.scripts.map((s) => s.type)).toEqual(['text/plain', 'module']);
    expect(dom.embedPlaceholders).toEqual([{ kind: 'maps', text: 'Karte laden' }]);
  });

  it('an answer that is no object at all gives empty facts', () => {
    expect(checkedRawDom('zq8')).toMatchObject({
      title: '',
      lang: '',
      links: [],
      forms: [],
      linksTruncated: false,
    });
    expect(checkedRawDom(null).links).toEqual([]);
  });

  it('the permalink flag still reads the whole rel, the stored rel keeps only link types', () => {
    const link = { ...normalDom().links[0], rel: 'Bookmark zq8 sid=zq8' };
    const { links } = mapLinks({ links: [link] } as unknown as Pick<RawDomFacts, 'links'>, target);
    expect(links[0]).toMatchObject({ rel: 'bookmark', permalink: true });
  });
});

describe('URLs of a page that are no http(s) URL', () => {
  const link = (attr: string) => ({ ...normalDom().links[0], href: attr, attr, text: 'Kontakt' });

  it.each([
    ['skype:zq8skype.alice.mueller?call', 'skype:[redacted]'],
    ['whatsapp:zq8whats.alice', 'whatsapp:[redacted]'],
    ['intent:zq8intent.alice#Intent;end', 'intent:[redacted]'],
    // The page chose the scheme too: one that reads as an id is no scheme to keep.
    ['zq8k2m9q4w8e1r5t3ab:open', null],
  ])('a link to %j keeps only its scheme: %j', (attr, href) => {
    const { links } = mapLinks({ links: [link(attr)] } as unknown as Pick<RawDomFacts, 'links'>, target);
    expect(links[0]).toMatchObject({ hrefKind: 'other', href });
  });

  it.each([
    ['3600; url=javascript:void(zq8metarefreshAlice)', null],
    ['0; url=data:text/html,zq8refresh', null],
    ['5; url=/neu/', 'https://www.example.test/neu/'],
  ])('<meta http-equiv="refresh" content=%j> keeps the URL %j', async (content, url) => {
    const { dom } = await collectDom(domPage({ ...normalDom(), metaRefresh: content }), target, []);
    expect(dom.metaRefresh).toEqual({ url, delaySec: Number(content.split(';')[0]) });
  });
});

describe('lists of a page answer longer than the page code makes them', () => {
  it('are cut to the caps of the page code, and a cut link list is marked truncated', async () => {
    const raw = normalDom();
    const many = {
      ...raw,
      links: Array.from({ length: 3_100 }, () => raw.links[0]),
      scripts: Array.from({ length: 400 }, () => raw.scripts[1]),
      placeholders: Array.from({ length: 50 }, (_, i) => ({ kind: 'maps', text: `Karte ${i}` })),
    };
    const { dom, candidates } = await collectDom(domPage(many), target, []);
    expect(dom.links).toHaveLength(3_000);
    expect(candidates).toHaveLength(3_000);
    expect(dom.linksTruncated).toBe(true);
    expect(dom.scripts).toHaveLength(300);
    expect(dom.embedPlaceholders).toHaveLength(20);
  });

  it('counterexample: lists within the caps stay whole and unmarked', async () => {
    const { dom } = await collectDom(domPage(normalDom()), target, []);
    expect(dom.links).toHaveLength(1);
    expect(dom.linksTruncated).toBeUndefined();
  });
});

describe('the Link response header', () => {
  it('keeps the hint type and the destination only', () => {
    expect(
      parseLinkHeader(
        '<https://cdn.example.net/a.css>; rel="stylesheet sid=zq8SECRET"; as="style?x=alice@example.com"',
        START,
      ),
    ).toEqual([{ rel: 'stylesheet', href: 'https://cdn.example.net/a.css', source: 'header' }]);
  });

  it('counterexample: a preload with its destination stays', () => {
    expect(parseLinkHeader('</app.js>; rel=modulepreload; as=script', START)).toEqual([
      { rel: 'modulepreload', href: 'https://www.example.test/app.js', as: 'script', source: 'header' },
    ]);
  });
});

const docCtx = privacyContext('https://www.example.test/datenschutz/');

describe('the language of a legal document', () => {
  it.each([
    ['de https://example.test/?sid=zq8SECRET', ['de'], 'de'],
    ['x alice@example.com', [], null],
    ['de?sid=zq8', [], null],
    ['de-DE', ['de'], 'de-de'],
    ['de-DE', [], 'de-de'],
    ['pt-BR', ['de'], 'de'],
    ['en-GB', ['en'], 'en-gb'],
    ['pt', [], 'pt'],
  ])('lang=%j with marker languages %j → %j', (attr, languages, lang) => {
    expect(documentLang(attr, languages)).toBe(lang);
  });
});

describe('legal documents read from a page whose script answers for the page code', () => {
  const hostile = {
    lang: 'de https://example.test/?sid=zq8doclang',
    title: 'Datenschutzerklärung',
    h1: 'Datenschutzerklärung',
    headingPlaces: { chrome: [{ zq8: true }], content: ['Datenschutzerklärung'] },
    parts: [
      { section: 'Datenschutzerklärung', text: POLICY, origin: 'visible', place: 'alice@example.com' },
      { section: 'Teil', text: 'Ein Teil der Seite.', origin: '?sid=zq8origin' },
    ],
    expandablesFound: 'zq8',
    expandablesWithContent: -1,
    textLength: 0,
    truncated: 'zq8',
  };

  it('nothing of the hostile answer is stored; a part of an unknown origin counts as hidden', async () => {
    const doc = await extractDocument(legalPage(docCtx.url, hostile), docCtx);

    expect(JSON.stringify(doc)).not.toContain('zq8');
    expect(JSON.stringify(doc)).not.toContain('alice@');
    expect(doc.lang).toBe('de');
    expect(doc.parts.map((p) => [p.origin, p.place])).toEqual([
      ['visible', undefined],
      ['hidden-irrelevant', undefined],
    ]);
    expect(doc.manifest).toMatchObject({ expandablesFound: 0, expandablesOpened: 0 });
    expect(doc.errors).not.toContain('truncated');
  });

  it('counterexample: a normal answer keeps its places, origins and counts', () => {
    const normal = rawPolicy({
      headingPlaces: { chrome: ['Menü'], content: ['Datenschutzerklärung'] },
      parts: [{ section: 'Datenschutzerklärung', text: POLICY, origin: 'expandable', place: 'content' }],
      expandablesFound: 2,
      expandablesWithContent: 1,
      expandablesIgnored: 0,
      textLength: POLICY.length,
      truncated: true,
    });
    expect(checkedRawDocument(normal)).toEqual(normal);
  });
});

describe('the document height measured in the page', () => {
  it('a height that is no number is no measurement: the reveal step fails in its own words', async () => {
    const page = {
      evaluate: async () => ({ heightPx: 'zq8 alice@example.com', scrollY: 0, locked: false }),
    } as unknown as Page;
    const out = await revealBelowFold({
      page,
      recorder: {} as NetworkRecorder,
      viewport: { width: 1366, height: 768 },
      dwellMs: 100,
      maxHeightPx: 4_000,
      quietWindowMs: 10,
      maxInflight: 1,
      callTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(out).toEqual({
      facts: { outcome: 'failed', documentHeightPx: null },
      error: 'document height failed',
      restored: true,
    });
  });
});
