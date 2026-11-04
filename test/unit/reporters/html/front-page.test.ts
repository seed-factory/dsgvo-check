import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../../src/core/data/load.ts';
import type { ReportDetail, ReporterContext } from '../../../../src/core/report/reporter.ts';
import type { Evidence, Finding, FullReport } from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';

const ctx = (detail: ReportDetail = 'full', lang: 'de' | 'en' = 'de'): ReporterContext => {
  const texts = loadTexts(lang);
  // A message that names a single entry in its title, shared by several findings.
  texts.messages['TEST-01.entry'] = { title: 'Eintrag {name} gefunden', body: '{name}', draft: true };
  texts.actions['TEST-01.entry'] = 'Prüfen Sie den Eintrag.';
  return { texts, lang, outDir: '/nonexistent-out', color: false, detail };
};

const fp = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

const finding = (n: number, over: Partial<Finding>): Finding => ({
  ...sampleFullReport().findings[1]!,
  fingerprint: fp(n),
  evidenceIds: [],
  related: [],
  legalNoteId: null,
  ...over,
});

const entry = (n: number, name: string, page = 'https://www.example.de/'): Finding =>
  finding(100 + n, {
    checkId: 'TEST-01',
    variant: 'entry',
    messageId: 'TEST-01.entry',
    severity: 'info',
    params: { name },
    pages: [page],
    text: undefined,
  });

const inventory = (n: number, service: string, stages: [string, string, string]): Finding =>
  finding(200 + n, {
    checkId: 'TRACK-01',
    variant: 'service-inventory',
    messageId: 'TRACK-01.service-inventory',
    severity: 'info',
    serviceId: service.toLowerCase(),
    params: {
      service,
      stageBeforeInteraction: stages[0],
      stageAfterReject: stages[1],
      stageAfterAccept: stages[2],
    },
    text: undefined,
  });

function reportWith(findings: Finding[]): FullReport {
  const r = sampleFullReport();
  r.findings = findings;
  const count = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
  r.summary.counts = {
    ...r.summary.counts!,
    critical: count('critical'),
    warning: count('warning'),
    info: count('info'),
  };
  return r;
}

const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('the first page', () => {
  it.each(['full', 'brief'] as const)('opens the %s report with overview, actions and services', (detail) => {
    const r = reportWith([entry(1, 'a'), inventory(1, 'Matomo', ['loaded', 'not-checked', 'not-checked'])]);
    const html = renderHtml(r, ctx(detail));

    expect(headings(html).slice(0, 3)).toEqual(['Auf einen Blick', 'Was zu tun ist', 'Beobachtete Dienste']);
    expect(html.indexOf('Auf einen Blick')).toBeLessThan(html.indexOf('Hinweis</h2>'));
  });

  it('puts the front page before the summary of the full report', () => {
    const html = renderHtml(sampleFullReport(), ctx('full'));
    expect(html.indexOf('>Was zu tun ist<')).toBeLessThan(html.indexOf('>Zusammenfassung<'));
    expect(html.indexOf('>Zusammenfassung<')).toBeLessThan(html.indexOf('>Befunde<'));
  });

  it('describes the counts, the scan and the banner in plain sentences', () => {
    const r = reportWith([
      finding(1, {
        checkId: 'CONSENT-01',
        variant: 'tracking-completed',
        severity: 'critical',
        messageId: 'CONSENT-01.tracking-completed',
        text: undefined,
      }),
      entry(2, 'a'),
      entry(3, 'b'),
    ]);
    r.checks.find((c) => c.id === 'CONSENT-04')!.status = 'completed';
    r.scan.status = 'partial';
    const sentences = buildReportView(r, ctx()).overview;

    expect(sentences).toEqual([
      'Es wurde ein kritischer Punkt beobachtet. Dazu kommen 2 Hinweise zur Information.',
      'Der Scan wurde nur teilweise durchgeführt; nicht alle Seiten oder Prüfungen konnten ausgewertet werden.',
      'Das Einwilligungsbanner wurde erkannt.',
    ]);
  });

  it('says so when there is nothing critical and when the banner was not recognized', () => {
    const r = reportWith([
      finding(1, {
        checkId: 'CONSENT-04',
        variant: 'banner-not-recognized',
        messageId: 'CONSENT-04.banner-not-recognized',
        severity: 'info',
        text: undefined,
      }),
    ]);
    const sentences = buildReportView(r, ctx()).overview;

    expect(sentences[0]).toBe(
      'Es wurden keine kritischen Punkte beobachtet. Dazu kommt ein Hinweis zur Information.',
    );
    expect(sentences[1]).toBe('Der Scan wurde vollständig durchgeführt.');
    expect(sentences[2]).toMatch(/nicht erkannt.*manuell/);
  });

  it('says that a scan which did not run has no observations', () => {
    const view = buildReportView(sampleFailedReport(), ctx());
    expect(view.overview).toEqual([
      'Der Scan wurde nicht durchgeführt, daher liegen keine Beobachtungen vor.',
    ]);
    expect(view.actions).toEqual([]);
  });

  it('speaks English with --lang en', () => {
    const html = renderHtml(reportWith([entry(1, 'a')]), ctx('brief', 'en'));
    expect(headings(html).slice(0, 2)).toEqual(['At a glance', 'What to do']);
  });
});

describe('the action list', () => {
  const view = (findings: Finding[]) => buildReportView(reportWith(findings), ctx());

  it('has one entry per message, counting the findings and pages it covers', () => {
    const { actions } = view([
      entry(1, 'a', 'https://www.example.de/'),
      entry(2, 'b', 'https://www.example.de/'),
      entry(3, 'c', 'https://www.example.de/kontakt'),
    ]);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      severity: 'info',
      action: 'Prüfen Sie den Eintrag.',
      covers: '3 Befunde, 2 Seiten',
    });
  });

  it('leaves the names of single entries out of the title when findings share a message', () => {
    const [shared] = view([entry(1, 'alpha'), entry(2, 'beta')]).actions;
    expect(shared!.title).toBe('Eintrag … gefunden');

    const [single] = view([entry(1, 'alpha')]).actions;
    expect(single!.title).toBe('Eintrag alpha gefunden');
  });

  it('lists critical before warning before info, and the most severe finding sets the level of an entry', () => {
    const { actions } = view([
      entry(1, 'a'),
      finding(2, { severity: 'warning', messageId: 'HDR-01.header-missing', text: undefined }),
      finding(3, { severity: 'critical', messageId: 'CONSENT-01.tracking-completed', text: undefined }),
      { ...entry(4, 'b'), severity: 'warning' },
    ]);

    expect(actions.map((a) => a.severity)).toEqual(
      ['critical', 'warning', 'warning', 'info'].slice(0, actions.length),
    );
    expect(actions.map((a) => a.severity)).toEqual(['critical', 'warning', 'warning']);
    expect(actions.at(0)!.severityLabel).toBe('kritisch');
  });

  it('shows the action texts of the data files and leaves the line out when a message has none', () => {
    const { actions } = view([
      finding(1, { severity: 'critical', messageId: 'CONSENT-01.tracking-completed', text: undefined }),
      finding(2, {
        severity: 'info',
        messageId: 'UNKNOWN-01.nothing',
        text: { lang: 'de', title: 'T', body: 'B', draft: true },
      }),
    ]);

    expect(actions[0]!.action).toMatch(/Einwilligung/);
    expect(actions[1]).toMatchObject({ title: 'T', action: '' });
  });

  it('renders badge, title, action and coverage in the HTML', () => {
    const html = renderHtml(reportWith([entry(1, 'a'), entry(2, 'b')]), ctx('brief'));
    expect(html).toMatch(
      /<li class="action sev-info">\s*<p class="action-title"><span class="badge sev-info">Hinweis<\/span> <strong>Eintrag … gefunden<\/strong>/,
    );
    expect(html).toContain('Prüfen Sie den Eintrag.');
    expect(html).toContain('2 Befunde, 1 Seite');
  });
});

describe('the table of observed services', () => {
  it('is built from the TRACK-01 findings with the timings of the TRACK-01 text', () => {
    const r = reportWith([
      inventory(1, 'Matomo', ['loaded', 'not-checked', 'not-checked']),
      inventory(2, 'Google Analytics', ['event-sent', 'none', 'initialised']),
    ]);
    const { services } = buildReportView(r, ctx());

    expect(services).toEqual([
      {
        name: 'Google Analytics',
        beforeInteraction: 'Ereignis gesendet',
        afterReject: 'nicht gefunden',
        afterAccept: 'initialisiert',
      },
      {
        name: 'Matomo',
        beforeInteraction: 'geladen',
        afterReject: 'nicht geprüft',
        afterAccept: 'nicht geprüft',
      },
    ]);
  });

  it('is not shown without such findings', () => {
    const html = renderHtml(reportWith([entry(1, 'a')]), ctx('brief'));
    expect(html).not.toContain('Beobachtete Dienste');
    expect(html).not.toContain('<table');
  });

  it('has the same stage words as the TRACK-01 text', () => {
    const r = reportWith([inventory(1, 'Matomo', ['loaded', 'not-checked', 'event-sent'])]);
    const html = renderHtml(r, ctx('brief'));
    const body = buildReportView(r, ctx()).actions[0]!.title;

    expect(body).toBe('… beobachtet (Inventar)'.replace('…', 'Matomo'));
    for (const word of ['geladen', 'nicht geprüft', 'Ereignis gesendet']) expect(html).toContain(word);
  });
});

describe('the brief report', () => {
  const brief = () => renderHtml(sampleFullReport(), ctx('brief'));

  it('keeps the first page and the notice, and nothing of the technical detail', () => {
    const html = brief();

    expect(headings(html)).toEqual(['Auf einen Blick', 'Was zu tun ist', 'Hinweis']);
    expect(html).toContain('Keine Rechtsberatung');
    for (const absent of [
      '<details',
      'class="finding',
      'Fingerabdruck',
      'Belege (',
      '>Messumgebung<',
      '>Abdeckung<',
      'class="ev-type"',
    ]) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('is shorter than the full report and still self-contained', () => {
    const full = renderHtml(sampleFullReport(), ctx('full'));
    expect(brief().length).toBeLessThan(full.length / 2);
    expect(brief()).not.toMatch(/<script|https?:\/\/[^"<]*"/);
  });

  it('shows the warnings of the run on the first page: sandbox off', () => {
    const r = sampleFullReport();
    r.scan.environment.sandbox = { mode: 'off', active: false };
    expect(renderHtml(r, ctx('brief'))).toContain('--sandbox off');
  });

  it('never shows crmCode', () => {
    expect(brief()).not.toMatch(/T[0-9]_|crmCode/);
  });

  it('is the full report when no level is given', () => {
    const { detail: _unused, ...withoutDetail } = ctx('full');
    expect(renderHtml(sampleFullReport(), withoutDetail)).toBe(renderHtml(sampleFullReport(), ctx('full')));
  });
});

describe('repeated requests in the evidence', () => {
  const request = (n: number, over: Record<string, unknown> = {}): Evidence =>
    ({
      ...(sampleFullReport().evidence.find((e) => e.id === 'ev-request') as object),
      id: `ev-rep-${n}`,
      page: `https://www.example.de/seite-${n}`,
      tMs: 1000 + n,
      navigationId: `A-n${n}`,
      ...over,
    }) as Evidence;

  function withRequests(items: Evidence[]): FullReport {
    const r = sampleFullReport();
    r.evidence = items;
    r.findings = [{ ...r.findings[0]!, evidenceIds: items.map((e) => e.id) }];
    return r;
  }

  const items = (html: string) => html.match(/<li class="ev">/g)?.length ?? 0;

  it('collapses identical requests into one item with the pages and the count', () => {
    const r = withRequests([1, 2, 3, 4, 5].map((n) => request(n)));
    const html = renderHtml(r, ctx());

    expect(items(html)).toBe(1);
    expect(html).toContain('<span class="ev-count">5×</span>');
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`https://www.example.de/seite-${n}`);
    expect(html).toContain('Belege (1)');
  });

  it('keeps requests apart that differ in method, resource type, delivery, result, service, provenance or features', () => {
    const r = withRequests([
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
    const r = withRequests([request(1), cookie, request(2), request(3, { method: 'GET' })]);
    const html = renderHtml(r, ctx());

    expect(items(html)).toBe(3);
    expect(html.indexOf('5×')).toBe(-1);
    expect(html.indexOf('2×')).toBeGreaterThan(0);
    expect(html.indexOf('2×')).toBeLessThan(html.indexOf('>cookie<'));
  });

  it('changes the view only: the report keeps every evidence item', () => {
    const r = withRequests([1, 2, 3].map((n) => request(n)));
    const before = JSON.stringify(r);
    renderHtml(r, ctx());

    expect(JSON.stringify(r)).toBe(before);
    expect(r.findings[0]!.evidenceIds).toHaveLength(3);
  });
});

describe('the legal background', () => {
  it('names the check it belongs to', () => {
    const r = reportWith([
      finding(1, {
        checkId: 'LEGAL-01',
        variant: 'footer-covered-by-banner',
        messageId: 'LEGAL-01.footer-covered-by-banner',
        severity: 'warning',
        legalNoteId: 'LEGAL-01',
        text: undefined,
      }),
      finding(2, {
        checkId: 'CONSENT-01',
        variant: 'tracking-completed',
        messageId: 'CONSENT-01.tracking-completed',
        severity: 'critical',
        legalNoteId: 'CONSENT-01',
        text: undefined,
      }),
    ]);
    const html = renderHtml(r, ctx());

    expect(html).toContain('<summary>Rechtlicher Hintergrund zu LEGAL-01</summary>');
    expect(html).toContain('<summary>Rechtlicher Hintergrund zu CONSENT-01</summary>');
    expect(renderHtml(r, ctx('full', 'en'))).toContain('<summary>Legal background for LEGAL-01</summary>');
  });

  it('shows the note of LEGAL-01 under LEGAL-01 and the one of CONSENT-01 under CONSENT-01', () => {
    const c = ctx();
    const r = reportWith([
      finding(1, {
        checkId: 'LEGAL-01',
        variant: 'footer-covered-by-banner',
        messageId: 'LEGAL-01.footer-covered-by-banner',
        severity: 'warning',
        legalNoteId: 'LEGAL-01',
        text: undefined,
      }),
    ]);
    const html = renderHtml(r, c);
    const note = c.texts.legalNotes['LEGAL-01']!.text;

    expect(html).toContain(note.slice(0, 40));
    expect(html).toMatch(/§ 5 DDG/);
    expect(html).not.toContain('Planet49');
  });

  it('does not break away from its finding in print and keeps the open disclosure in print', () => {
    const source = renderHtml(sampleFullReport(), ctx());
    expect(source).toMatch(/\.finding,details\.legal,li\.action\{break-inside:avoid\}/);
    expect(source).toContain('details>summary{display:block');
  });
});
