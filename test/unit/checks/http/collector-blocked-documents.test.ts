/**
 * Documents that a bot or WAF challenge answered to the HTTP probe. Only HDR-01 loses them, so they get a diagnostic of
 * their own: it stays apart from the browser's SCAN-BLOCKED, whose pages were not evaluated for content.
 */
import { describe, expect, it } from 'vitest';
import { blockedDocumentsDiagnostic } from '../../../../src/collectors/http/index.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { renderMessage, templateParams } from '../../../../src/core/data/messages.ts';
import { mergeDiagnostics } from '../../../../src/core/evaluation/assess.ts';
import type { DiagnosticInput } from '../../../../src/core/snapshot/index.ts';
import { makeDocumentResponse } from '../../../utils/snapshot-builder.ts';

const challenged = (role: 'start' | 'impressum' | 'privacy', url: string) =>
  makeDocumentResponse({
    role,
    url,
    status: 403,
    error: { code: 'blocked', message: 'cloudflare: header:cf-mitigated', phase: 'http', url },
  });

const documents = [
  challenged('start', 'https://www.example.test/'),
  challenged('impressum', 'https://www.example.test/impressum'),
  makeDocumentResponse({ role: 'privacy', url: 'https://www.example.test/datenschutz' }),
];

/** What the browser raises for a subpage it could not evaluate (`blockedDiagnostic`). */
const browserBlocked: DiagnosticInput = {
  code: 'SCAN-BLOCKED',
  affects: ['LEGAL-01'],
  params: {
    scope: 'subpage',
    count: 1,
    page: 'https://www.example.test/kontakt',
    pages: 'https://www.example.test/kontakt',
  },
};

describe('documents a challenge answered to the HTTP probe', () => {
  it('name the challenged pages and affect HDR-01 only', () => {
    expect(blockedDocumentsDiagnostic(documents)).toEqual({
      code: 'SCAN-HTTP-BLOCKED',
      affects: ['HDR-01'],
      params: {
        count: 2,
        page: 'https://www.example.test/',
        pages: 'https://www.example.test/, https://www.example.test/impressum',
        signals: 'cloudflare: header:cf-mitigated',
      },
    });
  });

  it('counterexample: no challenged document, no diagnostic', () => {
    expect(
      blockedDocumentsDiagnostic([makeDocumentResponse({ url: 'https://www.example.test/' })]),
    ).toBeNull();
  });

  it("stay apart from the browser's blocked pages in the report", () => {
    const http = blockedDocumentsDiagnostic(documents) as DiagnosticInput;
    const merged = mergeDiagnostics([http, browserBlocked]);

    expect(merged.map((d) => [d.code, d.affects, d.params?.count, d.params?.page])).toEqual([
      ['SCAN-BLOCKED', ['LEGAL-01'], 1, 'https://www.example.test/kontakt'],
      ['SCAN-HTTP-BLOCKED', ['HDR-01'], 2, 'https://www.example.test/'],
    ]);
  });

  it.each([
    ['de', 'Sicherheits-Header', 'inhaltlich'],
    ['en', 'security headers', 'for content'],
  ] as const)('%s: the text names the security headers, not the content of the page', (lang, says, not) => {
    const texts = loadTexts(lang);
    const http = blockedDocumentsDiagnostic(documents) as DiagnosticInput;
    const m = renderMessage(texts, `diagnostic.${http.code}`, http.params ?? {});

    expect(m.body).toContain(says);
    expect(m.body).toContain('https://www.example.test/, https://www.example.test/impressum');
    expect(m.body).not.toContain(not);
    const one = renderMessage(texts, `diagnostic.${http.code}`, { ...http.params, count: 1 });
    expect(one.body).toContain('https://www.example.test/');
    expect(one.body).not.toMatch(/\{|\}/);
  });

  it('de and en use the params the collector sends', () => {
    const params = (lang: 'de' | 'en') => {
      const t = loadTexts(lang).messages['diagnostic.SCAN-HTTP-BLOCKED'];
      return templateParams(`${t?.title} ${t?.body}`).sort();
    };
    expect(params('de')).toEqual(['count', 'page', 'pages']);
    expect(params('en')).toEqual(params('de'));
  });
});
