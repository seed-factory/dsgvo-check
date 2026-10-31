import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data.ts';
import {
  formatMessage,
  MessageSyntaxError,
  renderMessage,
  templateParams,
  validateTemplate,
} from '../../../src/core/messages.ts';

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
      // `unresolved` / `nonPublic` / `lookupCodes` tell a name that did not resolve from a private address (G52);
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
    '%s: SCAN-THROTTLED needs no params (raised by HTTP without any)',
    (lang) => {
      const t = loadTexts(lang).messages['diagnostic.SCAN-THROTTLED'];
      expect(templateParams(`${t?.title} ${t?.body}`)).toEqual([]);
      expect(t?.body).toMatch(/429/);
    },
  );
});
