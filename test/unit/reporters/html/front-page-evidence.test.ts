import { describe, expect, it } from 'vitest';
import type { Evidence, Finding, FullReport } from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { sampleFullReport } from '../../../utils/report/fixtures.ts';
import { ctx, findingOf, reportWith } from './front-page-fixtures.ts';

const sampleEvidence = (id: string): Evidence => sampleFullReport().evidence.find((e) => e.id === id)!;

function evidenceReport(items: Evidence[], finding: Partial<Finding> = {}): FullReport {
  const r = sampleFullReport();
  r.evidence = items;
  r.findings = [{ ...r.findings[0]!, ...finding, evidenceIds: items.map((e) => e.id) }];
  return r;
}

describe('repeated requests in the evidence', () => {
  const request = (n: number, over: Record<string, unknown> = {}): Evidence =>
    ({
      ...sampleEvidence('ev-request'),
      id: `ev-rep-${n}`,
      page: `https://www.example.de/seite-${n}`,
      tMs: 1000 + n,
      navigationId: `A-n${n}`,
      ...over,
    }) as Evidence;

  const items = (html: string) => html.match(/<li class="ev[ "]/g)?.length ?? 0;

  it('collapses identical requests into one item with the pages and the count', () => {
    const r = evidenceReport([1, 2, 3, 4, 5].map((n) => request(n)));
    const html = renderHtml(r, ctx());

    expect(items(html)).toBe(1);
    // the count is one of the evidence shown, which is an excerpt of what was observed
    expect(html).toContain('<span class="ev-count">5× im Auszug</span>');
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`https://<wbr>www.example.de/<wbr>seite-${n}`);
    // the heading counts the evidence items, the list shows them once
    expect(html).toContain('Belege (5)');
  });

  it('keeps requests apart that differ in method, resource type, delivery, result, service, provenance or features', () => {
    const r = evidenceReport([
      request(1),
      request(2, { method: 'GET' }),
      request(3, { resourceType: 'script' }),
      request(4, { delivery: 'attempted' }),
      request(5, { result: { kind: 'response', status: 500 } }),
      request(6, { serviceId: 'matomo' }),
      request(7, { url: 'https://www.google-analytics.com/other' }),
      request(8, { provenance: 'cache' }),
      request(9, { features: { eventType: 'scroll' } }),
      request(10, { features: { eventType: 'page_view' } }),
    ]);
    const html = renderHtml(r, ctx());

    expect(items(html)).toBe(10);
    expect(html).not.toContain('class="ev-count"');
  });

  it('keeps the position of the first occurrence and other evidence types unchanged', () => {
    const base = sampleFullReport();
    const cookie = base.evidence.find((e) => e.id === 'ev-cookie')!;
    const r = evidenceReport([request(1), cookie, request(2), request(3, { method: 'GET' })]);
    const html = renderHtml(r, ctx());

    expect(items(html)).toBe(3);
    expect(html.indexOf('5× ')).toBe(-1);
    expect(html.indexOf('2×')).toBeGreaterThan(0);
    expect(html.indexOf('2×')).toBeLessThan(html.indexOf('>Cookie<'));
  });

  it('changes the view only: the report keeps every evidence item', () => {
    const r = evidenceReport([1, 2, 3].map((n) => request(n)));
    const before = JSON.stringify(r);
    renderHtml(r, ctx());

    expect(JSON.stringify(r)).toBe(before);
    expect(r.findings[0]!.evidenceIds).toHaveLength(3);
  });
});

describe('the legal background', () => {
  it('names the check it belongs to', () => {
    const r = reportWith([
      findingOf(1, 'LEGAL-01.footer-covered-by-banner', 'warning', { legalNoteId: 'LEGAL-01' }),
      findingOf(2, 'CONSENT-01.tracking-completed', 'critical', { legalNoteId: 'CONSENT-01' }),
    ]);
    const html = renderHtml(r, ctx());

    expect(html).toContain('<summary>Rechtlicher Hintergrund zu LEGAL-01</summary>');
    expect(html).toContain('<summary>Rechtlicher Hintergrund zu CONSENT-01</summary>');
    expect(renderHtml(r, ctx('full', 'en'))).toContain('<summary>Legal background for LEGAL-01</summary>');
  });

  it('shows the note of LEGAL-01 under LEGAL-01 and the one of CONSENT-01 under CONSENT-01', () => {
    const c = ctx();
    const r = reportWith([
      findingOf(1, 'LEGAL-01.footer-covered-by-banner', 'warning', { legalNoteId: 'LEGAL-01' }),
    ]);
    const html = renderHtml(r, c);
    const note = c.texts.legalNotes['LEGAL-01']!.text;

    expect(html).toContain(note.slice(0, 40));
    expect(html).toMatch(/§ 5 DDG/);
    expect(html).not.toContain('Planet49');
  });

  it('is shown once per note, under the first finding that cites it', () => {
    const note = (n: number) =>
      findingOf(n, 'CONSENT-01.tracking-completed', 'critical', {
        legalNoteId: 'CONSENT-01',
        serviceId: `service-${n}`,
      });
    const html = renderHtml(reportWith([note(1), note(2), note(3)]), ctx());

    expect(html.match(/Rechtlicher Hintergrund zu CONSENT-01/g)).toHaveLength(1);
  });

  it('labels the status of the note as its classification, not as a source', () => {
    const r = reportWith([
      findingOf(1, 'CONSENT-01.tracking-completed', 'critical', { legalNoteId: 'CONSENT-01' }),
    ]);

    expect(renderHtml(r, ctx())).toMatch(/<p class="muted">Einordnung: /);
    expect(renderHtml(r, ctx('full', 'en'))).toMatch(/<p class="muted">Classification: /);
    expect(renderHtml(r, ctx())).not.toContain('Quelle:');
  });
});

describe('the evidence of a finding', () => {
  const renderEvidence = (items: Evidence[], params: Finding['params'] = {}, lang: 'de' | 'en' = 'de') =>
    renderHtml(evidenceReport(items, { params }), ctx('full', lang));

  it('merges cookies and storage entries seen again in another phase, listing the phases', () => {
    const cookie = sampleEvidence('ev-cookie');
    const html = renderEvidence([
      { ...cookie, id: 'ev-c1', phase: 'B', page: 'https://www.example.de/', tMs: 10 } as Evidence,
      { ...cookie, id: 'ev-c2', phase: 'A', page: 'https://www.example.de/', tMs: 20 } as Evidence,
    ]);

    expect(html.match(/<li class="ev[ "]/g)).toHaveLength(1);
    expect(html).toContain('<span class="ev-count">2× im Auszug</span>');
    expect(html).toContain('A (vor einer Interaktion), B (nach Ablehnung)');
  });

  it('keeps the frame of an embedded service visible: its URL is compared and shown, its ids stay in JSON', () => {
    const request = sampleEvidence('ev-request');
    const frameUrl = 'https://www.video.example/embed/1';
    const html = renderEvidence([
      { ...request, id: 'ev-r1', frameId: 'A-f2', frameUrl, page: 'https://www.example.de/a' } as Evidence,
      { ...request, id: 'ev-r2', frameId: 'A-f3', frameUrl, page: 'https://www.example.de/b' } as Evidence,
      { ...request, id: 'ev-r3', frameId: 'A-f1', page: 'https://www.example.de/a' } as Evidence,
    ]);

    expect(html.match(/<li class="ev[ "]/g)).toHaveLength(2);
    expect(html).toContain(
      '<dt>Rahmen (Frame)</dt><dd><div><code class="url">https://<wbr>www.video.example/<wbr>embed/<wbr>1</code></div></dd>',
    );
    expect(html).not.toContain('A-f2');
  });

  it('says how many requests the finding counted when the evidence shows fewer', () => {
    const request = sampleEvidence('ev-request');
    const sampled = renderEvidence([request], { requestCount: 14 });
    const whole = renderEvidence([request], { requestCount: 1 });

    expect(sampled).toContain('Auszug: 1 von 14 beobachteten Anfragen.');
    expect(whole).not.toContain('beobachteten Anfragen');
  });

  it('shows a request in words: fetch, phase, page and identifier, without parser details or JSON', () => {
    const html = renderEvidence([sampleEvidence('ev-request')]);

    expect(html).toContain('<dt>Abruf</dt><dd><div>POST · Ping · Antwort 204</div></dd>');
    expect(html).toContain(
      '<dt>Kennung</dt><dd><div>dauerhaft (Abgleich mit gespeichertem Cookie oder Speichereintrag) – cid</div></dd>',
    );
    expect(html).not.toContain('parserVersion');
    expect(html).not.toContain('identifier.kind');
    expect(html).not.toMatch(/<code>\{&quot;/);
  });

  it('lists the pages and headers of a finding as one item, one line each', () => {
    const page = sampleEvidence('ev-page');
    const header = sampleEvidence('ev-header');
    const html = renderEvidence([
      { ...page, id: 'ev-p1', url: 'https://www.example.de/' } as Evidence,
      { ...page, id: 'ev-p2', url: 'https://www.example.de/impressum', role: 'impressum' } as Evidence,
      { ...header, id: 'ev-h1' } as Evidence,
      { ...header, id: 'ev-h2', url: 'https://www.example.de/impressum' } as Evidence,
    ]);

    expect(html.match(/<li class="ev[ "]/g)).toHaveLength(2);
    expect(html).toContain('<span class="ev-type">Seiten</span>');
    expect(html).toMatch(
      /<dt>Impressum<\/dt><dd><div><code class="url">https:\/\/<wbr>www\.example\.de\/<wbr>impressum/,
    );
    expect(html).toContain('Belege (4)');
  });

  it('names where on the page each listed link sits and whether it was visible', () => {
    const link = sampleEvidence('ev-link');
    const links = [
      {
        ...link,
        id: 'ev-l1',
        href: 'http://work.example.de/',
        text: 'Startseite',
        region: 'nav',
        visible: true,
      },
      { ...link, id: 'ev-l2', text: 'Impressum', region: 'banner', visible: false },
    ] as Evidence[];
    const html = renderEvidence(links);

    expect(html).toContain('<span class="ev-type">Links</span>');
    expect(html).toContain('HTTP 200 · Navigation · sichtbar');
    expect(html).toContain('HTTP 200 · Bereich des Einwilligungsbanners · nicht sichtbar');
    // a link without these facts keeps its line as before
    const plain = renderEvidence([
      { ...link, id: 'ev-l3' },
      { ...link, id: 'ev-l4' },
    ] as Evidence[]);
    expect(plain).toContain('<div>HTTP 200</div>');
    expect(renderEvidence(links, {}, 'en')).toContain('consent banner area · not visible');
  });
});
