/**
 * A legal document that prints a value of the visitor's cookies or storage (the consent ID of a cookie declaration, a
 * script writing `document.cookie` into the page) is stored and hashed without it. Words, VAT numbers and other text
 * stay. Markers start with `zq8`.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { extractDocument, storedText } from '../../../../../src/collectors/browser/legal/documents.ts';
import { valueScrubber } from '../../../../../src/collectors/browser/legal/scrub.ts';
import { sha256Hex } from '../../../../../src/collectors/browser/util.ts';

/** Cookiebot's consent cookie as the browser holds it: URL-encoded, the stamp inside a JS object literal. */
const COOKIEBOT =
  '%7Bstamp%3A%27zq8Bc12dEf34%2B%2FGhIjKlMnOpQ%3D%3D%27%2Cnecessary%3Atrue%2Cstatistics%3Afalse%2Cmethod%3A%27explicit%27%2Cver%3A1%2Cutc%3A1700000000000%2Cregion%3A%27de%27%7D';

describe('values of cookies and storage in page text', () => {
  const scrub = valueScrubber([
    COOKIEBOT,
    'GA1.1.1234567890.1700000001',
    '4f3a9c1d-2e7b-4a9f-8c1d-2e3f4a5b6c7d',
    '{"uid":"zq8uid0042a1b2","consents":{"statistics":["google-analytics"]}}',
    'true',
  ]);

  it.each([
    ['Ihre Einwilligungs-ID: zq8Bc12dEf34+/GhIjKlMnOpQ==', 'Ihre Einwilligungs-ID: [redacted]'],
    ['Einwilligungsdatum: 1700000000000.', 'Einwilligungsdatum: [redacted].'],
    ['Client-ID 1234567890 (Google Analytics)', 'Client-ID [redacted] (Google Analytics)'],
    ['UUID: 4f3a9c1d-2e7b-4a9f-8c1d-2e3f4a5b6c7d', 'UUID: [redacted]'],
    ['Ihre ID: zq8uid0042a1b2', 'Ihre ID: [redacted]'],
  ])('%j → %j', (text, stored) => {
    expect(scrub(text)).toBe(stored);
  });

  it.each([
    'Wir nutzen google-analytics für Statistiken (statistics, necessary, explicit).',
    'USt-IdNr. DE1234567890',
    'Stand: 01.01.2024, Version 1.2.3',
  ])('counterexample: %j stays', (text) => {
    expect(scrub(text)).toBe(text);
  });

  it('without values the text is unchanged', () => {
    expect(valueScrubber([])('Ihre ID: zq8uid0042a1b2')).toBe('Ihre ID: zq8uid0042a1b2');
  });
});

/**
 * Consent tools keep the site's own addresses beside the visitor's ID: Borlabs its host in `domainPath`, OneTrust the
 * landing page. The page prints those addresses anyway, so the labels of the site's registrable domain stay; IDs in the
 * labels of its subdomains and in its paths go, and so do the labels of every other host that read as an id.
 */
const BORLABS = encodeURIComponent(
  JSON.stringify({
    consents: { essential: ['borlabs-cookie'] },
    domainPath: 'www.autohaus24online.de/',
    expires: 'Mon, 07 Nov 2027 10:00:00 GMT',
    uid: 'zq8a1b2c-3d4e5f6g-7h8i9j0k-1l2m3n4o',
    version: '3',
  }),
);
const ONETRUST =
  'isGpcEnabled=0&consentId=zq8c9d0e-4f3a9c1d2e7b&interactionCount=1&landingPath=https%3A%2F%2Fwww.autoscout24.de%2Fde%2Fimpressum%2F&groups=C0001%3A1';

describe('addresses of the site in the values', () => {
  // One scrubber for two sites, each with the consent tool it runs.
  const scrub = valueScrubber(
    [
      BORLABS,
      ONETRUST,
      'https://u-4f3a9c1d2e7b.tracker.test/p/',
      'https://x9k2m4q7w8e1r5t3.www.autoscout24.de/',
    ],
    ['www.autohaus24online.de', 'www.autoscout24.de'],
  );

  it.each([
    'E-Mail: [redacted]@autohaus24online.de',
    'Website: https://www.autoscout24.de/de/impressum/',
    'www.autohaus24online.de/',
    'autohaus24online',
  ])('%j stays', (text) => {
    expect(scrub(text)).toBe(text);
  });

  it.each([
    ['Ihre ID: zq8a1b2c-3d4e5f6g-7h8i9j0k-1l2m3n4o', 'Ihre ID: [redacted]'],
    ['Consent-ID zq8c9d0e-4f3a9c1d2e7b', 'Consent-ID [redacted]'],
    // A label with an id-like run is an id, also in a host name; under the site only its domain's labels stay.
    ['Pixel: u-4f3a9c1d2e7b.tracker.test', 'Pixel: [redacted].tracker.test'],
    ['Server: x9k2m4q7w8e1r5t3.www.autoscout24.de', 'Server: [redacted].www.autoscout24.de'],
  ])('%j → %j', (text, stored) => {
    expect(scrub(text)).toBe(stored);
  });

  it('counterexample: on a document of another site the labels of these hosts count like any value', () => {
    const elsewhere = valueScrubber([BORLABS], ['www.example.test']);
    expect(elsewhere('Händler: www.autohaus24online.de')).toBe('Händler: www.[redacted].de');
  });
});

/**
 * Values with a host name that is not the site's, IDs in the paths of the site's addresses, and values in the forms
 * the URL parser gives them when the free-text redaction rewrites a link (a lower-case host, percent escapes). The
 * stored text is the one `extractDocument` keeps. Markers start with `zq8`, the IDs are base64-like runs.
 */
describe('values the text of a document holds in other forms', () => {
  const stored = (values: readonly string[], text: string) =>
    storedText(text, valueScrubber(values, ['www.example.test']));

  it.each([
    [
      ['sess=Xk2mQ9pLw8eR1tZ3.prod'],
      'Ihre Sitzungskennung: Xk2mQ9pLw8eR1tZ3.',
      'Ihre Sitzungskennung: [redacted].',
    ],
    [
      ['s:Xk2mQ9pLw8eR1tZ3.Abcdef'],
      'Ihre Sitzungskennung: Xk2mQ9pLw8eR1tZ3.',
      'Ihre Sitzungskennung: [redacted].',
    ],
    [
      ['ref=xk2mq9plw8er1tz3.tracker.test'],
      'Pixel: xk2mq9plw8er1tz3.tracker.test',
      'Pixel: [redacted].tracker.test',
    ],
    [
      [JSON.stringify({ domainPath: 'www.example.test/r/Xk2mQ9pLw8eR1tZ3' })],
      'Empfehlung: www.example.test/r/Xk2mQ9pLw8eR1tZ3 .',
      'Empfehlung: www.example.test/r/[redacted] .',
    ],
    [
      [JSON.stringify({ landing: 'https://www.example.test/p/Qz8mQ9pLw8eR1tZ3' })],
      'Kennung Qz8mQ9pLw8eR1tZ3',
      'Kennung [redacted]',
    ],
  ])('%j: %j → %j', (values, text, kept) => {
    expect(stored(values, text)).toBe(kept);
  });

  it('an id in the path of a link of another site goes, also where the text prints it alone', () => {
    const values = [JSON.stringify({ src: 'https://tracker.test/c/Zq8k2m9plw8er1tz3' })];
    expect(stored(values, 'Ihre ID: Zq8k2m9plw8er1tz3')).toBe('Ihre ID: [redacted]');
  });

  it('a value that is a whole link leaves the link to the redaction: its query does not stay behind as text', () => {
    const kept = stored(
      ['https://u-4f3a9c1d2e7b.tracker.test/p/'],
      'Pixel: https://u-4f3a9c1d2e7b.tracker.test/p/?sid=zq8abc',
    );
    expect(kept).not.toMatch(/zq8|4f3a9c1d/);
    expect(kept).toMatch(/^Pixel: https:\/\//);
  });

  it.each([
    'Link https://Xk2m9q4w8e1r5t3zAB.tracker.test/?a=1',
    'Link https://shop.test/p/{Xk2m9q4w8e1r5t3zAB}?a=1',
    'Link https://shop.test/p/äXk2m9q4w8e1r5t3zAB?a=1',
    'Link https://äXk2m9q4w8e1r5t3zAB.tracker.test/?a=1',
    'Link https://Xk2m%39q4w8e1r5t3zAB.tracker.test/?a=1',
  ])('%j keeps the value in no form', (text) => {
    expect(stored(['Xk2m9q4w8e1r5t3zAB'], text)).not.toMatch(/xk2m9q4w8e1r5t3zab/i);
  });

  it.each([
    'E-Mail: max.mustermann@partner24online.de.',
    'E-Mail: max.mustermann(at)partner24online.de.',
    'E-Mail: max.mustermann [at] partner24online.de.',
    'Kontakt: mailto:max.mustermann%40partner24online.de',
    'Kontakt: https://partner24online.de/kontakt/max.mustermann%40partner24online.de',
  ])('a value that is the domain of an address leaves the address to its mask: %j', (text) => {
    const kept = stored(['ref=partner24online.de'], text);
    expect(kept).not.toContain('max.mustermann');
    expect(kept).not.toContain('partner24online');
  });

  it('counterexample: words, the site and other addresses stay', () => {
    const text =
      'Wir nutzen google-analytics. E-Mail: [redacted]@example.test, Website: https://www.example.test/de/';
    expect(stored(['sess=Xk2mQ9pLw8eR1tZ3.prod', 'https://www.example.test/'], text)).toBe(text);
  });
});

describe('values and text chosen to make the scrub slow', () => {
  it('is linear in the text: a thousand runs of ones against 400 000 digits', () => {
    const values = Array.from({ length: 20 }, (_, v) =>
      Array.from({ length: 50 }, (_, k) => '1'.repeat(8 + ((v * 50 + k) % 505))).join(' '),
    );
    const text = '1'.repeat(400_000);
    const started = performance.now();
    const scrub = valueScrubber(values);
    expect(scrub(text)).toBe(text);
    expect(scrub(`${text} ${'1'.repeat(300)}.`)).toBe(`${text} [redacted].`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('a legal document read with the values of the visitor', () => {
  const POLICY = 'Wir verarbeiten personenbezogene Daten nach der DSGVO. '.repeat(20);
  const DECLARATION = 'Ihre Einwilligungs-ID: zq8Bc12dEf34+/GhIjKlMnOpQ== Ihre Einwilligung gilt ab sofort.';
  const page = {
    url: () => 'https://www.example.test/datenschutz/',
    evaluate: async () => ({
      lang: 'de',
      title: 'Datenschutzerklärung',
      h1: 'Datenschutzerklärung',
      headingPlaces: { chrome: [], content: ['Datenschutzerklärung', 'Cookie-ID zq8uid0042a1b2'] },
      parts: [
        { section: 'Datenschutzerklärung', text: POLICY, origin: 'visible', place: 'content' },
        { section: 'Cookie-ID zq8uid0042a1b2', text: DECLARATION, origin: 'visible', place: 'content' },
      ],
      expandablesFound: 0,
      expandablesWithContent: 0,
      textLength: POLICY.length + DECLARATION.length,
      truncated: false,
    }),
    frames: () => [],
    mainFrame: () => null,
  } as unknown as Page;
  const ctx = {
    id: 'doc-privacy-1',
    kind: 'privacy' as const,
    phase: 'A' as const,
    url: 'https://www.example.test/datenschutz/',
    foundVia: 'link' as const,
    status: 200,
    contentType: 'text/html',
  };

  it('parts, headings and the hash hold no value of the visitor', async () => {
    const doc = await extractDocument(page, ctx, [COOKIEBOT, 'zq8uid0042a1b2']);

    expect(JSON.stringify(doc)).not.toContain('zq8');
    expect(doc.parts[1]).toMatchObject({
      section: 'Cookie-ID [redacted]',
      text: 'Ihre Einwilligungs-ID: [redacted] Ihre Einwilligung gilt ab sofort.',
    });
    expect(doc.contentHeadings).toEqual(['Datenschutzerklärung', 'Cookie-ID [redacted]']);
    expect(doc.sha256).toBe(sha256Hex(doc.parts.map((p) => p.text).join('\n')));
  });

  it('an address of the site in a value keeps the address mask: the local part goes, the domain stays', async () => {
    const IMPRESSUM =
      'E-Mail: max.mustermann@autohaus24online.de, Website: https://www.autohaus24online.de/de/impressum/ Ende.';
    const impressum = {
      ...page,
      url: () => 'https://www.autohaus24online.de/impressum/',
      evaluate: async () => ({
        lang: 'de',
        title: 'Impressum',
        h1: 'Impressum',
        headingPlaces: { chrome: [], content: ['Impressum'] },
        parts: [
          { section: 'Impressum', text: POLICY, origin: 'visible', place: 'content' },
          { section: 'Kontakt', text: IMPRESSUM, origin: 'visible', place: 'content' },
        ],
        expandablesFound: 0,
        expandablesWithContent: 0,
        textLength: POLICY.length + IMPRESSUM.length,
        truncated: false,
      }),
    } as unknown as Page;

    const doc = await extractDocument(impressum, { ...ctx, kind: 'impressum' }, [BORLABS]);

    expect(JSON.stringify(doc)).not.toContain('max.mustermann');
    expect(doc.parts[1]?.text).toBe(
      'E-Mail: [redacted]@autohaus24online.de, Website: https://www.autohaus24online.de/de/impressum/ Ende.',
    );
    expect(doc.sha256).toBe(sha256Hex(doc.parts.map((p) => p.text).join('\n')));
  });

  it('the registrable domain of the scan counts as the site too, for a document on another host', async () => {
    const IMPRESSUM = 'E-Mail: max.mustermann@autohaus24online.de, mehr unter www.autohaus24online.de Ende.';
    const elsewhere = {
      ...page,
      url: () => 'https://rechtliches.example.test/impressum/',
      evaluate: async () => ({
        lang: 'de',
        title: 'Impressum',
        h1: 'Impressum',
        headingPlaces: { chrome: [], content: ['Impressum'] },
        parts: [
          { section: 'Impressum', text: POLICY, origin: 'visible', place: 'content' },
          { section: 'Kontakt', text: IMPRESSUM, origin: 'visible', place: 'content' },
        ],
        expandablesFound: 0,
        expandablesWithContent: 0,
        textLength: POLICY.length + IMPRESSUM.length,
        truncated: false,
      }),
    } as unknown as Page;

    const doc = await extractDocument(
      elsewhere,
      { ...ctx, kind: 'impressum', siteDomain: 'autohaus24online.de' },
      [BORLABS],
    );
    expect(doc.parts[1]?.text).toBe(
      'E-Mail: [redacted]@autohaus24online.de, mehr unter www.autohaus24online.de Ende.',
    );
  });

  it('counterexample: without values the document is read as before', async () => {
    const doc = await extractDocument(page, ctx);
    expect(doc.parts[1]?.text).toBe(DECLARATION);
  });
});
