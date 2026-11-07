import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../../src/core/data/load.ts';
import {
  formatMessage,
  MessageSyntaxError,
  renderMessage,
  templateParams,
  validateTemplate,
} from '../../../../src/core/data/messages.ts';

describe('ICU-like message format', () => {
  it('substitutes params', () => {
    expect(formatMessage('Host {host} auf {page}', { host: 'fonts.gstatic.com', page: '/' }, 'de')).toBe(
      'Host fonts.gstatic.com auf /',
    );
    expect(formatMessage('Wert {x}', {}, 'de')).toBe('Wert {x}');
    expect(formatMessage('Wert {x}', { x: null }, 'de')).toBe('Wert –');
  });

  it('plural with exact match and #', () => {
    const t = '{n, plural, =0 {keine Seite} one {# Seite} other {# Seiten}}';
    expect(formatMessage(t, { n: 0 }, 'de')).toBe('keine Seite');
    expect(formatMessage(t, { n: 1 }, 'de')).toBe('1 Seite');
    expect(formatMessage(t, { n: 1200 }, 'de')).toBe('1.200 Seiten');
    expect(formatMessage('{n, plural, one {# page} other {# pages}}', { n: 2 }, 'en')).toBe('2 pages');
    expect(formatMessage('{n, plural, one {# page} other {# pages}}', { n: 1200 }, 'en')).toBe('1,200 pages');
  });

  it('select and number', () => {
    const t = '{kind, select, impressum {Impressum} privacy {Datenschutzerklärung} other {Dokument}}';
    expect(formatMessage(t, { kind: 'privacy' }, 'de')).toBe('Datenschutzerklärung');
    expect(formatMessage(t, { kind: 'x' }, 'de')).toBe('Dokument');
    expect(formatMessage('{n, number}', { n: 12345 }, 'de')).toBe('12.345');
    expect(formatMessage('{n}', { n: 2026 }, 'de')).toBe('2026');
  });

  it("quotes: '' and '{…}'", () => {
    expect(formatMessage("it''s '{literal}'", {}, 'en')).toBe("it's {literal}");
  });

  it('reports params and syntax errors', () => {
    expect(templateParams('{a} {n, plural, one {{b}} other {#}}').sort()).toEqual(['a', 'b', 'n']);
    expect(() => validateTemplate('{a')).toThrow(MessageSyntaxError);
    expect(() => validateTemplate('{n, plural, one {x}}')).toThrow(MessageSyntaxError);
  });
});

describe('diagnostic texts use the params the collectors send (browser-collector cross-zone)', () => {
  it.each(['de', 'en'] as const)(
    '%s: SCAN-PRIVATE-REQUEST-BLOCKED names the address classes and the count',
    (lang) => {
      const texts = loadTexts(lang);
      const m = renderMessage(texts, 'diagnostic.SCAN-PRIVATE-REQUEST-BLOCKED', {
        count: 3,
        addressClass: 'metadata, private',
      });
      expect(m.body).toContain('metadata, private');
      expect(m.body).toContain('3');
      // `unresolved` / `nonPublic` / `lookupCodes` tell a name that did not resolve from a private address ;
      // `recovered` counts the refused navigations that a retry loaded afterwards (absent: none).
      expect(
        templateParams(texts.messages['diagnostic.SCAN-PRIVATE-REQUEST-BLOCKED']?.body ?? '').sort(),
      ).toEqual([
        'addressClass',
        'count',
        'hasLookupCodes',
        'lookupCodes',
        'nonPublic',
        'recovered',
        'unresolved',
      ]);
    },
  );

  it.each(['de', 'en'] as const)(
    '%s: SCAN-TLS-BLOCKED adds one sentence of its own for each reason the browser did not continue elsewhere',
    (lang) => {
      const texts = loadTexts(lang);
      const params = {
        host: 'broken.example.test',
        via: 'http://broken.example.test/',
        url: 'https://site.example.test/',
        signals: 'header:x-vercel-mitigated',
      };
      const body = (fallback?: string) =>
        renderMessage(texts, 'diagnostic.SCAN-TLS-BLOCKED', fallback ? { ...params, fallback } : params).body;
      // Older snapshots carry no reason: the text stays as it was.
      const base = body();
      const reasons = ['none', 'same-host', 'invalid', 'blocked', 'bot-protection', 'off'];
      const bodies = reasons.map(body);

      for (const b of bodies) {
        expect(b.startsWith(base)).toBe(true);
        expect(b.length).toBeGreaterThan(base.length);
        expect(b).not.toMatch(/\{[a-z]+\}/);
      }
      expect(new Set(bodies).size).toBe(reasons.length);
      expect(bodies[reasons.indexOf('blocked')]).toContain('https://site.example.test/');
      // The signal of the protection is named only where the target answered with one.
      expect(bodies[reasons.indexOf('bot-protection')]).toContain('header:x-vercel-mitigated');
      expect(bodies.filter((b) => b.includes('header:x-vercel-mitigated'))).toHaveLength(1);
      expect(templateParams(texts.messages['diagnostic.SCAN-TLS-BLOCKED']?.body ?? '').sort()).toEqual([
        'fallback',
        'host',
        'signals',
        'url',
        'via',
      ]);
    },
  );

  it.each(['de', 'en'] as const)(
    '%s: SCAN-BOTMODE names the crawler test of the CMP only for that cause, else the signal as before',
    (lang) => {
      const texts = loadTexts(lang);
      const render = (params: Record<string, string>) => {
        const m = renderMessage(texts, 'diagnostic.SCAN-BOTMODE', params);
        return `${m.title} ${m.body}`;
      };
      const crawler = render({
        signal: 'bot-user-agent',
        cause: 'user-agent',
        test: 'CCM19 isBotBrowser (app.js)',
      });
      const generic = render({ signal: 'cookiebot:isSpider' });

      expect(crawler).toContain('CCM19 isBotBrowser (app.js)');
      expect(crawler).toMatch(/User-Agent/);
      expect(crawler).not.toContain('bot-user-agent');
      expect(generic).toContain('cookiebot:isSpider');
      expect(generic).not.toMatch(/User-Agent|Crawler|crawler/);
      for (const text of [crawler, generic]) expect(text).not.toMatch(/\{[a-z]+\}/);
      const t = texts.messages['diagnostic.SCAN-BOTMODE'];
      expect(templateParams(`${t?.title} ${t?.body}`).sort()).toEqual(['cause', 'signal', 'test']);
    },
  );

  it.each(['de', 'en'] as const)(
    '%s: SCAN-TLS-FALLBACK names the refused host, its plain-http address and where the browser checks ran',
    (lang) => {
      const m = renderMessage(loadTexts(lang), 'diagnostic.SCAN-TLS-FALLBACK', {
        host: 'broken.example.test',
        via: 'http://broken.example.test/',
        url: 'https://site.example.test/start',
      });
      expect(m.body).toContain('broken.example.test');
      expect(m.body).toContain('http://broken.example.test/');
      expect(m.body).toContain('https://site.example.test/start');
      expect(`${m.title} ${m.body}`).not.toMatch(/\{[a-z]+\}/);
    },
  );

  it.each(['de', 'en'] as const)(
    '%s: SCAN-THROTTLED needs no params (raised by HTTP without any)',
    (lang) => {
      const t = loadTexts(lang).messages['diagnostic.SCAN-THROTTLED'];
      expect(templateParams(`${t?.title} ${t?.body}`)).toEqual([]);
      expect(t?.body).toMatch(/429/);
    },
  );
});

describe('action texts are message templates', () => {
  it('every action text parses and uses the same params in de and en', () => {
    const de = loadTexts('de').actions;
    const en = loadTexts('en').actions;
    const params = (t: string) => templateParams(t).sort();

    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
    for (const [messageId, text] of Object.entries(de)) {
      expect(() => validateTemplate(text), `de ${messageId}`).not.toThrow();
      expect(() => validateTemplate(en[messageId]!), `en ${messageId}`).not.toThrow();
      expect(params(en[messageId]!), messageId).toEqual(params(text));
    }
  });

  it('formats with the params of the finding, like the finding texts', () => {
    expect(formatMessage('Ergänzen Sie {header}.', { header: 'Content-Security-Policy' }, 'de')).toBe(
      'Ergänzen Sie Content-Security-Policy.',
    );
    expect(
      formatMessage('{count, plural, one {Den Eintrag} other {Die # Einträge}} prüfen.', { count: 3 }, 'de'),
    ).toBe('Die 3 Einträge prüfen.');
  });
});
