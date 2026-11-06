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
  // A message and an action that use every kind of param a grouped item aggregates.
  texts.messages['TEST-02.counted'] = {
    title: '{kind, select, cookie {Cookie} request {Anfrage} other {Eintrag}} {name} auf {pageCount} Seiten',
    body: '{name}',
    draft: true,
  };
  texts.actions['TEST-02.counted'] =
    'Prüfen Sie {name} ({count} Stück, {host}){mode, select, true { sofort} other {}}.';
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
    expect(html.indexOf('Auf einen Blick')).toBeLessThan(html.indexOf('Hinweise zum Bericht</h2>'));
  });

  it('puts the front page before the summary of the full report', () => {
    const html = renderHtml(sampleFullReport(), ctx('full'));
    expect(html.indexOf('>Was zu tun ist<')).toBeLessThan(html.indexOf('>Zusammenfassung<'));
    expect(html.indexOf('>Zusammenfassung<')).toBeLessThan(html.indexOf('>Befunde<'));
  });

  it('describes the counts, the scan, the checks without a result, the banner and the region in plain sentences', () => {
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
      'Es wurde ein kritischer Befund beobachtet. Dazu kommen 2 Hinweise zur Information. Gleichartige Befunde sind unten zu 2 Punkten zusammengefasst.',
      'Der Scan wurde nur teilweise durchgeführt; nicht alle Seiten oder Prüfungen konnten ausgewertet werden.',
      'Eine Prüfung (MAIL-01) wurde wegen eines Fehlers nicht abgeschlossen.',
      'Das Einwilligungsbanner wurde erkannt.',
      expect.stringMatching(/^Die Region, aus der der Scan lief, ist nicht bekannt\..*EWR abweichen\.$/),
    ]);
  });

  it('counts findings, not points, and names the points only when findings share one', () => {
    const one = buildReportView(reportWith([entry(1, 'a')]), ctx()).overview[0];
    const two = buildReportView(reportWith([entry(1, 'a'), entry(2, 'b')]), ctx()).overview[0];

    expect(one).toBe(
      'Es wurden keine kritischen Befunde beobachtet. Dazu kommt ein Hinweis zur Information.',
    );
    expect(two).toBe(
      'Es wurden keine kritischen Befunde beobachtet. Dazu kommen 2 Hinweise zur Information. Gleichartige Befunde sind unten zu einem Punkt zusammengefasst.',
    );
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
      'Es wurden keine kritischen Befunde beobachtet. Dazu kommt ein Hinweis zur Information.',
    );
    // CONSENT-04 is inconclusive and MAIL-01 failed: the scan ran, but not every check has a result
    expect(sentences[1]).toBe(
      'Der Scan ist durchgelaufen, aber nicht jede Prüfung hat ein abschließendes Ergebnis.',
    );
    expect(sentences[2]).toBe('Eine Prüfung (MAIL-01) wurde wegen eines Fehlers nicht abgeschlossen.');
    expect(sentences[3]).toMatch(/nicht erkannt.*manuell/);
    expect(sentences.join(' ')).not.toContain('CONSENT-04');
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

  it('names the differing entries of findings that share a message in the title', () => {
    const [shared] = view([entry(1, 'beta'), entry(2, 'alpha'), entry(3, 'alpha')]).actions;
    expect(shared!.title).toBe('Eintrag alpha, beta gefunden');

    const [single] = view([entry(1, 'alpha')]).actions;
    expect(single!.title).toBe('Eintrag alpha gefunden');
  });

  it('names five entries and counts the rest', () => {
    const [de] = view(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, n) => entry(n, name))).actions;
    const [en] = buildReportView(
      reportWith(['a', 'b', 'c', 'd', 'e', 'f'].map((name, n) => entry(n, name))),
      ctx('full', 'en'),
    ).actions;

    expect(de!.title).toBe('Eintrag a, b, c, d, e und 2 weitere gefunden');
    expect(en!.title).toBe('Eintrag a, b, c, d, e and 1 more gefunden');
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
    expect(actions.at(0)!.severityLabel).toBe('Kritisch');
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
      /<li class="action sev-info">\s*<p class="action-title"><span class="badge sev-info">Hinweis<\/span> <strong>Eintrag a, b gefunden<\/strong>/,
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

    for (const word of ['geladen', 'nicht geprüft', 'Ereignis gesendet']) expect(html).toContain(word);
  });

  it('is not repeated as a to-do: inventory findings stay out of the action list', () => {
    const { actions, services } = buildReportView(
      reportWith([inventory(1, 'Matomo', ['loaded', 'none', 'none']), entry(1, 'a')]),
      ctx(),
    );

    expect(services).toHaveLength(1);
    expect(actions.map((a) => a.title)).toEqual(['Eintrag a gefunden']);
  });

  it.each(['full', 'brief'] as const)(
    'is counted on its own in the overview of the %s report, which counts the findings of the action list',
    (detail) => {
      const rows = [
        inventory(1, 'Matomo', ['loaded', 'none', 'none']),
        inventory(2, 'Hotjar', ['loaded', 'none', 'none']),
        inventory(3, 'Google Analytics', ['loaded', 'none', 'none']),
      ];
      const counts = (findings: Finding[]) =>
        buildReportView(reportWith(findings), ctx(detail)).overview.slice(0, 2);

      expect(counts([...rows, entry(1, 'a'), entry(2, 'b')])).toEqual([
        'Es wurden keine kritischen Befunde beobachtet. Dazu kommen 2 Hinweise zur Information. Gleichartige Befunde sind unten zu einem Punkt zusammengefasst.',
        '3 beobachtete Dienste stehen in der Tabelle „Beobachtete Dienste“.',
      ]);
      expect(counts(rows.slice(0, 1))).toEqual([
        'Es wurden keine kritischen Befunde beobachtet.',
        'Ein beobachteter Dienst steht in der Tabelle „Beobachtete Dienste“.',
      ]);
    },
  );

  it('is counted on its own at the severity the ruleset gives it, in English too', () => {
    const raised: Finding = { ...inventory(1, 'Matomo', ['loaded', 'none', 'none']), severity: 'warning' };
    const { overview } = buildReportView(reportWith([raised, entry(1, 'a')]), ctx('brief', 'en'));

    expect(overview.slice(0, 2)).toEqual([
      'No critical findings were observed. There is also one note for information.',
      'One observed service is listed in the table "Observed services".',
    ]);
  });

  it('explains "not checked" only when a cell says so', () => {
    const checked = buildReportView(reportWith([inventory(1, 'Matomo', ['loaded', 'none', 'none'])]), ctx());
    const unchecked = buildReportView(
      reportWith([inventory(1, 'Matomo', ['loaded', 'not-checked', 'none'])]),
      ctx(),
    );
    const note = loadTexts('de').ui['report.services.note']!.text;

    expect(checked.serviceNotes).not.toContain(note);
    expect(unchecked.serviceNotes).toContain(note);
  });

  it('repeats under the table why consent checks have no result, and an accept the banner did not confirm', () => {
    const r = reportWith([inventory(1, 'Matomo', ['loaded', 'none', 'event-sent'])]);
    r.checks = [
      { ...r.checks[0]!, id: 'CONSENT-01', status: 'inconclusive', reason: 'geo' },
      { ...r.checks[0]!, id: 'CONSENT-04', status: 'completed', reason: null },
      { ...r.checks[0]!, id: 'HDR-01', module: 'http', status: 'inconclusive', reason: 'start-page-status' },
    ];
    r.scan.coverage.consentActions = [
      { action: 'reject', clicked: true, verified: true },
      { action: 'accept', clicked: true, verified: false },
    ];
    const { serviceNotes } = buildReportView(r, ctx());

    expect(serviceNotes).toEqual([
      expect.stringMatching(/^Eine Prüfung \(CONSENT-01\) ist nicht eindeutig: .*außerhalb des EWR/),
      expect.stringMatching(/Annahme nicht bestätigt/),
    ]);
  });
});

describe('the brief report', () => {
  const brief = () => renderHtml(sampleFullReport(), ctx('brief'));

  it('keeps the first page and the notice, and nothing of the technical detail', () => {
    const html = brief();

    expect(headings(html)).toEqual(['Auf einen Blick', 'Was zu tun ist', 'Hinweise zum Bericht']);
    expect(html).toContain('keine Rechtsberatung');
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

  const items = (html: string) => html.match(/<li class="ev[ "]/g)?.length ?? 0;

  it('collapses identical requests into one item with the pages and the count', () => {
    const r = withRequests([1, 2, 3, 4, 5].map((n) => request(n)));
    const html = renderHtml(r, ctx());

    expect(items(html)).toBe(1);
    // the count is one of the evidence shown, which is an excerpt of what was observed
    expect(html).toContain('<span class="ev-count">5× im Auszug</span>');
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`https://<wbr>www.example.de/<wbr>seite-${n}`);
    // the heading counts the evidence items, the list shows them once
    expect(html).toContain('Belege (5)');
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
    expect(html.indexOf('5× ')).toBe(-1);
    expect(html.indexOf('2×')).toBeGreaterThan(0);
    expect(html.indexOf('2×')).toBeLessThan(html.indexOf('>Cookie<'));
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
    // headings stay with what follows them; notes, actions and single values are not split; findings and evidence may be
    expect(source).toContain('h2,h3,h4,details>summary,.ev-head,.ev-sample{break-after:avoid}');
    expect(source).toContain(
      'h2,h3,h4,details.legal,li.action,li.ev.compact,.ev-start,tr,figure.shot,dl.kv>dd,#dienste table{break-inside:avoid}',
    );
    expect(source).not.toMatch(/\.finding[^{]*\{break-inside:avoid/);
    expect(source).toContain('code.id,span.id{white-space:nowrap}');
    expect(source).toContain('details>summary{display:block');
  });

  it('is shown once per note, under the first finding that cites it', () => {
    const note = (n: number) =>
      finding(n, {
        checkId: 'CONSENT-01',
        variant: 'tracking-completed',
        messageId: 'CONSENT-01.tracking-completed',
        severity: 'critical',
        legalNoteId: 'CONSENT-01',
        serviceId: `service-${n}`,
        text: undefined,
      });
    const html = renderHtml(reportWith([note(1), note(2), note(3)]), ctx());

    expect(html.match(/Rechtlicher Hintergrund zu CONSENT-01/g)).toHaveLength(1);
  });

  it('labels the status of the note as its classification, not as a source', () => {
    const r = reportWith([
      finding(1, {
        checkId: 'CONSENT-01',
        variant: 'tracking-completed',
        messageId: 'CONSENT-01.tracking-completed',
        severity: 'critical',
        legalNoteId: 'CONSENT-01',
        text: undefined,
      }),
    ]);

    expect(renderHtml(r, ctx())).toMatch(/<p class="muted">Einordnung: /);
    expect(renderHtml(r, ctx('full', 'en'))).toMatch(/<p class="muted">Classification: /);
    expect(renderHtml(r, ctx())).not.toContain('Quelle:');
  });
});

describe('the overview: checks without a result', () => {
  type Check = FullReport['checks'][number];
  const check = (id: string, status: Check['status'], reason: string | null, module = 'browser'): Check => ({
    id,
    module,
    status,
    reason,
    limitations: [],
    coverage: null,
    durationMs: 1,
  });
  const overview = (checks: Check[], findings: Finding[] = [], lang: 'de' | 'en' = 'de') => {
    const r = reportWith(findings);
    r.checks = checks;
    return buildReportView(r, ctx('brief', lang)).overview;
  };

  it('says the scan was complete only when every check has a result', () => {
    expect(
      overview([check('CONSENT-01', 'completed', null), check('HDR-01', 'not_applicable', 'no-https')]),
    ).toContain('Der Scan wurde vollständig durchgeführt.');
    // checks left out with --checks were not asked for
    expect(
      overview([check('CONSENT-01', 'completed', null), check('HDR-01', 'skipped', 'not-selected')]),
    ).toContain('Der Scan wurde vollständig durchgeführt.');
  });

  it('names the browser checks an invalid certificate kept from running', () => {
    const sentences = overview([
      check('CONSENT-01', 'skipped', 'tls-blocked'),
      check('PRIV-01', 'skipped', 'tls-blocked'),
      check('HDR-01', 'inconclusive', 'start-page-status', 'http'),
      check('TLS-02', 'completed', null, 'http'),
    ]);

    expect(sentences).not.toContain('Der Scan wurde vollständig durchgeführt.');
    expect(sentences).toContain(
      'Der Scan ist durchgelaufen, aber nicht jede Prüfung hat ein abschließendes Ergebnis.',
    );
    expect(sentences).toContain(
      '2 Prüfungen (CONSENT-01, PRIV-01) wurden nicht ausgeführt: Das Zertifikat der Website wurde nicht als gültig angenommen, deshalb hat der Browser die Website nicht aufgerufen.',
    );
    expect(sentences).toContain(
      'Eine Prüfung (HDR-01) hat kein abschließendes Ergebnis: Startseite antwortete mit einem Fehlerstatus.',
    );
  });

  it.each([
    ['geo', /sind nicht eindeutig: Das Einwilligungsbanner hat einen Standort außerhalb des EWR gemeldet/],
    [
      'bot-mode',
      /sind nicht eindeutig: Das Einwilligungsbanner hat den Scan als automatisierten Zugriff behandelt/,
    ],
  ])('names the checks a %s signal of the banner left open', (reason, sentence) => {
    const sentences = overview([
      check('CONSENT-01', 'inconclusive', reason),
      check('EMBED-01', 'inconclusive', reason),
    ]);
    expect(sentences.join(' ')).toMatch(sentence);
    expect(sentences.join(' ')).toContain('(CONSENT-01, EMBED-01)');
  });

  it.each([
    ['notFound', check('CONSENT-04', 'not_applicable', 'no-banner'), /kein Einwilligungsbanner gefunden/],
    [
      'notVisible',
      check('CONSENT-04', 'inconclusive', 'first-layer-not-visible'),
      /nicht sichtbar angezeigt/,
    ],
    ['recognized', check('CONSENT-04', 'completed', null), /^Das Einwilligungsbanner wurde erkannt\.$/],
  ])('describes the banner state %s', (_state, consent04, sentence) => {
    const sentences = overview([consent04, check('CONSENT-05', 'inconclusive', 'no-reject-click')]);
    expect(sentences.some((s) => sentence.test(s))).toBe(true);
    expect(sentences).toContain(
      'Der Scan ist durchgelaufen, aber nicht jede Prüfung hat ein abschließendes Ergebnis.',
    );
  });

  describe('a banner observed but not recognised', () => {
    const notRecognized = finding(1, {
      checkId: 'CONSENT-04',
      variant: 'banner-not-recognized',
      messageId: 'CONSENT-04.banner-not-recognized',
      severity: 'info',
      text: undefined,
    });
    const candidateChecks = () => [
      check('CONSENT-03', 'inconclusive', 'banner-candidate-unrecognized'),
      check('CONSENT-04', 'inconclusive', 'banner-not-recognized'),
      check('CONSENT-05', 'inconclusive', 'banner-not-recognized'),
    ];

    it('the reject and the accept stay open: the scan is not called complete, the banner sentence says why', () => {
      const sentences = overview(candidateChecks(), [notRecognized]);

      expect(sentences).not.toContain('Der Scan wurde vollständig durchgeführt.');
      expect(sentences).toContain(
        'Der Scan ist durchgelaufen, aber nicht jede Prüfung hat ein abschließendes Ergebnis.',
      );
      expect(sentences.join(' ')).toMatch(/Das Einwilligungsbanner wurde nicht erkannt; .* manuell geprüft/);
      expect(sentences.join(' ')).not.toMatch(/CONSENT-0[345]|kein Einwilligungsbanner gefunden/);
    });

    it('without CONSENT-04 in the report, CONSENT-03 alone still says the banner was not recognised', () => {
      const sentences = overview([check('CONSENT-03', 'inconclusive', 'banner-candidate-unrecognized')]);

      expect(sentences).not.toContain('Der Scan wurde vollständig durchgeführt.');
      expect(sentences.join(' ')).toMatch(/Das Einwilligungsbanner wurde nicht erkannt/);
    });

    it('a banner that an older snapshot leaves undetermined keeps the checks open and is neither named nor missing', () => {
      const sentences = overview([
        check('CONSENT-03', 'inconclusive', 'banner-undetermined'),
        check('CONSENT-04', 'inconclusive', 'banner-undetermined'),
        check('CONSENT-05', 'inconclusive', 'banner-undetermined'),
      ]);

      expect(sentences).not.toContain('Der Scan wurde vollständig durchgeführt.');
      expect(sentences.join(' ')).not.toMatch(/nicht erkannt|kein Einwilligungsbanner gefunden/);
    });

    it('a not recognised banner is never "complete", even when every check reported a result', () => {
      const sentences = overview([check('CONSENT-04', 'completed', null)], [notRecognized]);

      expect(sentences).not.toContain('Der Scan wurde vollständig durchgeführt.');
    });
  });

  it('a banner an adapter recognised whose first layer could not be read is named recognised, its checks stay open', () => {
    const ambiguous = finding(1, {
      checkId: 'CONSENT-04',
      variant: 'banner-not-recognized',
      messageId: 'CONSENT-04.banner-not-recognized',
      severity: 'info',
      params: {
        cmp: 'cookieman',
        reasons: 'ambiguous-first-layer:blocking-no-reject',
        bannerRecognized: true,
      },
      text: undefined,
    });
    const sentences = overview([check('CONSENT-04', 'inconclusive', 'banner-not-recognized')], [ambiguous]);

    expect(sentences).not.toContain('Der Scan wurde vollständig durchgeführt.');
    expect(sentences.join(' ')).toMatch(
      /Das Einwilligungsbanner wurde erkannt, seine erste Ebene aber nicht eindeutig eingeordnet; .* manuell geprüft/,
    );
    expect(sentences.join(' ')).not.toMatch(/wurde nicht erkannt/);
  });

  it('lets the banner sentence explain the reject that could not be clicked; with a recognised banner it is named', () => {
    const missing = overview([
      check('CONSENT-04', 'not_applicable', 'no-banner'),
      check('CONSENT-05', 'inconclusive', 'no-reject-click'),
    ]);
    const recognized = overview([
      check('CONSENT-04', 'completed', null),
      check('CONSENT-05', 'inconclusive', 'no-reject-click'),
    ]);

    expect(missing.join(' ')).not.toContain('CONSENT-05');
    expect(recognized).toContain(
      'Eine Prüfung (CONSENT-05) ist nicht eindeutig: Die Ablehnung im Einwilligungsbanner konnte nicht ausgelöst oder nicht bestätigt werden.',
    );
  });

  it('a check that left a part open but reported findings: evaluated in part, why, and the findings still hold', () => {
    const partly = {
      ...check('CONSENT-05', 'inconclusive', 'pagehide-capture-unavailable'),
      coverage: { observed: 4, evaluated: 3 },
    };
    const afterReject = finding(1, {
      checkId: 'CONSENT-05',
      variant: 'tracking-after-reject',
      messageId: 'CONSENT-05.tracking-after-reject',
      severity: 'critical',
      params: { kind: 'request', service: 'Example Analytics', host: 'a.example', pageCount: 1 },
      text: undefined,
    });
    const r = reportWith([
      afterReject,
      inventory(1, 'Example Analytics', ['event-sent', 'event-sent', 'none']),
    ]);
    r.checks = [check('CONSENT-04', 'completed', null), partly];
    const view = buildReportView(r, ctx('brief'));

    expect(view.overview).toContain('Der Scan ist durchgelaufen.');
    expect(view.overview).toContain(
      'Eine Prüfung wurde nur teilweise ausgewertet: Anfragen beim Verlassen einer Seite werden nicht erfasst (3 von 4 Seiten ausgewertet). Die gezeigten Befunde „Anfragen mit dauerhafter Kennung nach bestätigter Ablehnung: Example Analytics“ gelten dennoch.',
    );
    // Named once, by the title the owner sees below, and not again under the table of services.
    expect(view.overview.join(' ')).not.toContain('CONSENT-05');
    expect(view.overview.join(' ')).not.toContain('kein abschließendes Ergebnis');
    expect(view.serviceNotes.join(' ')).not.toContain('teilweise');

    // Without findings the same check has no result, and the sentence gives the reason in words.
    r.findings = [];
    expect(buildReportView(r, ctx('brief')).overview).toContain(
      'Eine Prüfung (CONSENT-05) hat kein abschließendes Ergebnis: Anfragen beim Verlassen einer Seite werden nicht erfasst (3 von 4 Seiten ausgewertet).',
    );
  });

  it('gives the reason in words when the visit with the reject did not start', () => {
    const open = (lang: 'de' | 'en') =>
      overview(
        [check('CONSENT-04', 'completed', null), check('CONSENT-05', 'inconclusive', 'time-budget')],
        [],
        lang,
      );

    expect(open('de')).toContain(
      'Eine Prüfung (CONSENT-05) hat kein abschließendes Ergebnis: Restzeit des Scans nicht ausreichend.',
    );
    expect(open('en')).toContain(
      'One check (CONSENT-05) has no conclusive result: remaining scan time not sufficient.',
    );
  });

  it('speaks English with --lang en', () => {
    const sentences = overview([check('CONSENT-01', 'skipped', 'tls-blocked')], [], 'en');
    expect(sentences).toContain(
      'One check (CONSENT-01) was not run: the certificate of the website was not accepted as valid, so the browser did not visit the website.',
    );
  });
});

describe('the overview: region and redirect', () => {
  const consent = finding(1, {
    checkId: 'CONSENT-01',
    variant: 'tracking-completed',
    messageId: 'CONSENT-01.tracking-completed',
    severity: 'critical',
    text: undefined,
  });
  const REGION = /^Die Region, aus der der Scan lief, ist nicht bekannt/;
  const sentences = (r: FullReport) => buildReportView(r, ctx('brief')).overview;

  it('notes an unknown region on the first page when consent findings depend on it', () => {
    expect(sentences(reportWith([consent])).some((s) => REGION.test(s))).toBe(true);
    expect(sentences(reportWith([entry(1, 'a')])).some((s) => REGION.test(s))).toBe(false);

    const asserted = reportWith([consent]);
    asserted.scan.environment.egress = {
      mode: 'direct',
      region: 'asserted',
      assertedRegion: 'de',
      source: 'assume-region',
    };
    expect(sentences(asserted).some((s) => REGION.test(s))).toBe(false);
  });

  it('suggests scanning the final address when the start page leads to another site', () => {
    const other = reportWith([entry(1, 'a')]);
    other.scan.target = 'https://shop.example/';
    other.scan.finalUrl = 'https://www.other-shop.example/start';
    const same = reportWith([entry(1, 'a')]);
    same.scan.target = 'https://shop.example/';
    same.scan.finalUrl = 'https://www.shop.example/';

    expect(sentences(other)).toContain(
      'Die angegebene Adresse leitet auf www.other-shop.example weiter. Für ein vollständiges Bild sollte auch diese Adresse direkt gescannt werden.',
    );
    expect(sentences(same).join(' ')).not.toContain('leitet auf');
  });
});

describe('the action list: params of grouped findings', () => {
  const counted = (
    n: number,
    params: Finding['params'],
    pages: string[],
    severity: Finding['severity'] = 'info',
  ) =>
    finding(300 + n, {
      checkId: 'TEST-02',
      variant: 'counted',
      messageId: 'TEST-02.counted',
      severity,
      params,
      pages,
      text: undefined,
    });
  const PAGE = (p: string) => `https://www.example.de/${p}`;

  it('keeps shared values, adds up differing numbers, lists other values and counts distinct pages', () => {
    const r = reportWith([
      counted(1, { name: 'b', count: 2, host: 'h.example', kind: 'cookie', pageCount: 2, mode: true }, [
        PAGE('a'),
        PAGE('b'),
      ]),
      counted(2, { name: 'a', count: 3, host: 'h.example', kind: 'request', pageCount: 2, mode: true }, [
        PAGE('b'),
        PAGE('c'),
      ]),
    ]);
    const [item] = buildReportView(r, ctx()).actions;

    // `kind` differs: the select falls back to its neutral branch
    expect(item!.title).toBe('Eintrag a, b auf 3 Seiten');
    expect(item!.action).toBe('Prüfen Sie a, b (5 Stück, h.example) sofort.');
    expect(item!.covers).toBe('2 Befunde, 3 Seiten');
  });

  it('formats the action of a single finding with its own params', () => {
    const r = reportWith([
      counted(1, { name: 'x', count: 1, host: 'h.example', kind: 'cookie', mode: false }, []),
    ]);
    expect(buildReportView(r, ctx()).actions[0]!.action).toBe('Prüfen Sie x (1 Stück, h.example).');
  });

  it('orders by severity, then data protection before transport security and mail, then by the pages covered', () => {
    const r = reportWith([
      finding(1, {
        checkId: 'MAIL-01',
        variant: 'policy-none',
        messageId: 'MAIL-01.policy-none',
        severity: 'warning',
        pages: [],
        text: undefined,
      }),
      finding(2, {
        checkId: 'HDR-01',
        variant: 'hsts-missing',
        messageId: 'HDR-01.hsts-missing',
        severity: 'warning',
        pages: [PAGE('a')],
        text: undefined,
      }),
      finding(3, {
        checkId: 'PRIV-01',
        variant: 'not-named',
        messageId: 'PRIV-01.not-named',
        severity: 'warning',
        pages: [PAGE('a')],
        text: undefined,
      }),
      finding(4, {
        checkId: 'EMBED-01',
        variant: 'fonts-loaded',
        messageId: 'EMBED-01.fonts-loaded',
        severity: 'warning',
        pages: [PAGE('a'), PAGE('b')],
        text: undefined,
      }),
      finding(5, {
        checkId: 'TLS-02',
        variant: 'certificate-invalid',
        messageId: 'TLS-02.certificate-invalid',
        severity: 'critical',
        pages: [],
        text: undefined,
      }),
    ]);
    r.checks = [
      ['MAIL-01', 'dns'],
      ['HDR-01', 'http'],
      ['TLS-02', 'http'],
      ['PRIV-01', 'browser'],
      ['EMBED-01', 'browser'],
    ].map(([id, module]) => ({ ...r.checks[0]!, id: id!, module: module! }));

    const order = buildReportView(r, ctx()).actions.map((a) => a.title);
    const ids = ['TLS-02', 'EMBED-01', 'PRIV-01', 'HDR-01', 'MAIL-01'].map(
      (id) =>
        buildReportView(reportWith(r.findings.filter((f) => f.checkId === id)), ctx()).actions[0]!.title,
    );
    expect(order).toEqual(ids);
  });
});

describe('the evidence of a finding', () => {
  const base = () => sampleFullReport();
  function withEvidence(items: Evidence[], params: Finding['params'] = {}): FullReport {
    const r = base();
    r.evidence = items;
    r.findings = [{ ...r.findings[0]!, evidenceIds: items.map((e) => e.id), params }];
    return r;
  }

  it('merges cookies and storage entries seen again in another phase, listing the phases', () => {
    const cookie = base().evidence.find((e) => e.id === 'ev-cookie')!;
    const r = withEvidence([
      { ...cookie, id: 'ev-c1', phase: 'B', page: 'https://www.example.de/', tMs: 10 } as Evidence,
      { ...cookie, id: 'ev-c2', phase: 'A', page: 'https://www.example.de/', tMs: 20 } as Evidence,
    ]);
    const html = renderHtml(r, ctx());

    expect(html.match(/<li class="ev[ "]/g)).toHaveLength(1);
    expect(html).toContain('<span class="ev-count">2× im Auszug</span>');
    expect(html).toContain('A (vor einer Interaktion), B (nach Ablehnung)');
  });

  it('keeps the frame of an embedded service visible: its URL is compared and shown, its ids stay in JSON', () => {
    const request = base().evidence.find((e) => e.id === 'ev-request')!;
    const frameUrl = 'https://www.video.example/embed/1';
    const r = withEvidence([
      { ...request, id: 'ev-r1', frameId: 'A-f2', frameUrl, page: 'https://www.example.de/a' } as Evidence,
      { ...request, id: 'ev-r2', frameId: 'A-f3', frameUrl, page: 'https://www.example.de/b' } as Evidence,
      { ...request, id: 'ev-r3', frameId: 'A-f1', page: 'https://www.example.de/a' } as Evidence,
    ]);
    const html = renderHtml(r, ctx());

    expect(html.match(/<li class="ev[ "]/g)).toHaveLength(2);
    expect(html).toContain(
      '<dt>Rahmen (Frame)</dt><dd><div><code class="url">https://<wbr>www.video.example/<wbr>embed/<wbr>1</code></div></dd>',
    );
    expect(html).not.toContain('A-f2');
  });

  it('says how many requests the finding counted when the evidence shows fewer', () => {
    const request = base().evidence.find((e) => e.id === 'ev-request')!;
    const sampled = renderHtml(withEvidence([request], { requestCount: 14 }), ctx());
    const whole = renderHtml(withEvidence([request], { requestCount: 1 }), ctx());

    expect(sampled).toContain('Auszug: 1 von 14 beobachteten Anfragen.');
    expect(whole).not.toContain('beobachteten Anfragen');
  });

  it('shows a request in words: fetch, phase, page and identifier, without parser details or JSON', () => {
    const html = renderHtml(withEvidence([base().evidence.find((e) => e.id === 'ev-request')!]), ctx());

    expect(html).toContain('<dt>Abruf</dt><dd><div>POST · Ping · Antwort 204</div></dd>');
    expect(html).toContain(
      '<dt>Kennung</dt><dd><div>dauerhaft (Abgleich mit gespeichertem Cookie oder Speichereintrag) – cid</div></dd>',
    );
    expect(html).not.toContain('parserVersion');
    expect(html).not.toContain('identifier.kind');
    expect(html).not.toMatch(/<code>\{&quot;/);
  });

  it('lists the pages and headers of a finding as one item, one line each', () => {
    const page = base().evidence.find((e) => e.id === 'ev-page')!;
    const header = base().evidence.find((e) => e.id === 'ev-header')!;
    const html = renderHtml(
      withEvidence([
        { ...page, id: 'ev-p1', url: 'https://www.example.de/' } as Evidence,
        { ...page, id: 'ev-p2', url: 'https://www.example.de/impressum', role: 'impressum' } as Evidence,
        { ...header, id: 'ev-h1' } as Evidence,
        { ...header, id: 'ev-h2', url: 'https://www.example.de/impressum' } as Evidence,
      ]),
      ctx(),
    );

    expect(html.match(/<li class="ev[ "]/g)).toHaveLength(2);
    expect(html).toContain('<span class="ev-type">Seiten</span>');
    expect(html).toMatch(
      /<dt>Impressum<\/dt><dd><div><code class="url">https:\/\/<wbr>www\.example\.de\/<wbr>impressum/,
    );
    expect(html).toContain('Belege (4)');
  });
});

describe('the full report in words', () => {
  const html = (r: FullReport = sampleFullReport(), lang: 'de' | 'en' = 'de') =>
    renderHtml(r, ctx('full', lang));

  it('states date, time and region of the scan at the top of both reports', () => {
    const line = 'Scan am 2026-10-30 12:00 UTC · Region des Netzausgangs: nicht festgestellt';
    expect(html()).toContain(line);
    expect(renderHtml(sampleFullReport(), ctx('brief'))).toContain(line);
    expect(html(sampleFullReport(), 'en')).toContain(
      'Scan on 2026-10-30 12:00 UTC · region of the network egress: not determined',
    );
    expect(renderHtml(sampleFailedReport(), ctx('brief'))).toContain('Scan am 2026-10-30 12:00 UTC</p>');
  });

  it('words mode, region and source of the egress in the language of the report', () => {
    const asserted = sampleFullReport();
    asserted.scan.environment.egress = {
      mode: 'proxy',
      region: 'asserted',
      assertedRegion: 'eea',
      source: 'assume-region',
    };
    const legacy = sampleFullReport();
    legacy.scan.environment.egress.source = 'nicht festgestellt';

    expect(html(sampleFullReport(), 'en')).toContain('direct · region not determined</div>');
    expect(html(legacy, 'en')).toContain('direct · region not determined</div>');
    expect(html(legacy, 'en')).not.toContain('nicht festgestellt');
    expect(html(asserted)).toContain('über Proxy · Region EWR laut Nutzerangabe</div>');
  });

  it('names the service of a group, the matching and related findings in words', () => {
    const r = sampleFullReport();
    r.findings[0]!.params = { ...r.findings[0]!.params, service: 'Google Analytics' };
    r.findings[0]!.dpfEntity = { name: 'Google LLC', listed: null, checkedAt: null, source: null };
    const out = html(r);

    expect(out).toContain('<h3>Dienst: Google Analytics</h3>');
    expect(out).toContain('Dienstekatalog (2026.10.0)');
    expect(out).toContain('Erkennung nach Merkmalen');
    expect(out).toMatch(/CONSENT-04: [^<(]+ \(gleicher Dienst\)/);
    expect(out).toContain('Google LLC: nicht geprüft</div>');
    expect(out).not.toContain('(Stand –)');
  });

  // The reasons the evaluation and the checks end a check with; `collector-error` names its collector after the colon.
  const CHECK_REASONS = [
    // evaluation
    'not-selected not-run not-collected collector-skipped collector-error:browser',
    'tls-blocked timeout exception invalid-observation',
    // browser checks; CONSENT-05 passes on why the visit with the reject did not start
    'throttled geo bot-mode cmp-not-observed no-banner banner-not-recognized cmp-not-supported',
    'first-layer-not-visible unknown-classification consent-frame-unresolved banner-candidate-unrecognized',
    'banner-undetermined',
    'no-pre-consent-observation',
    'no-network-observation phase-b-missing phase-c-missing time-budget request-cap no-reject-click',
    'reject-not-confirmed pagehide-capture-unavailable legal-targets-not-evaluable privacy-policy-not-found',
    'pdf-not-evaluated unsupported-format language-unsupported document-incomplete no-evaluable-pages',
    'insufficient-pages contact-page-not-evaluable',
    // http and dns checks
    'blocked start-page-unavailable start-page-status tls-invalid no-https handshake-inconclusive undecided',
    'ip-target no-registrable-domain multiple-records',
  ].flatMap((line) => line.split(' '));

  it.each(['de', 'en'] as const)('words every reason a check can end with (%s)', (lang) => {
    const r = sampleFullReport();
    const id = (n: number) => `TEST-${String(n).padStart(2, '0')}`;
    r.checks = CHECK_REASONS.map((reason, n) => ({
      id: id(n),
      module: 'browser',
      status: 'inconclusive',
      reason,
      limitations: [],
      coverage: null,
      durationMs: 1,
    }));
    const shown = new Map(buildReportView(r, ctx('full', lang)).checks!.map((c) => [c.id, c.reason]));

    expect(CHECK_REASONS.filter((reason, n) => shown.get(id(n)) === reason)).toEqual([]);
  });

  it('words the exit reasons and the phases', () => {
    const out = html();
    expect(out).toContain('<div>Befunde ab der eingestellten Schwelle</div>');
    expect(out).toContain('<div>Prüfung MAIL-01 fehlgeschlagen</div>');
    expect(out).not.toContain('(threshold)');
    expect(out).toContain('A (vor einer Interaktion), B (nach Ablehnung)');
  });

  it('labels phases B and C by what their banner click did, in the findings and in the coverage of pages', () => {
    const r = sampleFullReport();
    r.findings[0]!.phases = ['A', 'B', 'C'];
    r.scan.coverage.pages[0]!.phases = ['A', 'B', 'C'];
    r.scan.coverage.consentActions = [
      { action: 'reject', clicked: false, verified: null },
      { action: 'accept', clicked: false, verified: null },
    ];
    const failed = html(r);
    expect(failed).toContain(
      'A (vor einer Interaktion), B (erneuter Besuch, keine Ablehnung ausgelöst), C (erneuter Besuch, keine Annahme ausgelöst)',
    );
    expect(failed).toContain('<td>A, B (ohne Ablehnung), C (ohne Annahme)</td>');
    expect(failed).not.toContain('B (nach Ablehnung)');
    expect(html(r, 'en')).toContain(
      'B (repeat visit, no rejection made), C (repeat visit, no acceptance made)',
    );

    r.scan.coverage.consentActions = [
      { action: 'reject', clicked: true, verified: true },
      { action: 'accept', clicked: true, verified: false },
    ];
    const unconfirmed = html(r);
    expect(unconfirmed).toContain('B (nach Ablehnung), C (nach Zustimmung, vom Banner nicht bestätigt)');
    expect(unconfirmed).toContain('<td>A, B, C (Annahme nicht bestätigt)</td>');
    expect(html(r, 'en')).toContain('B (after rejection), C (after acceptance, not confirmed by the banner)');
  });

  it('says that there was nothing to click when no banner was found', () => {
    const r = sampleFullReport();
    r.findings = r.findings.filter((f) => f.checkId !== 'CONSENT-04');
    const consent04 = r.checks.find((c) => c.id === 'CONSENT-04')!;
    consent04.status = 'not_applicable';
    consent04.reason = 'no-banner';
    r.scan.coverage.consentActions = [{ action: 'reject', clicked: false, verified: null }];
    expect(html(r)).toContain(
      'Klicks im Einwilligungsbanner: keine, da kein Einwilligungsbanner gefunden wurde',
    );
    expect(html(r)).not.toContain('Ablehnen nicht ausgelöst');
  });

  it('dates a re-evaluated snapshot to its capture and gives the evaluation time in the full report only', () => {
    const r = sampleFullReport();
    r.scan.evaluatedAt = '2026-11-01T09:30:00.000Z';
    expect(html(r)).toContain('Scan am 2026-10-30 12:00 UTC');
    expect(html(r)).toContain('<dt>Neu ausgewertet (UTC)</dt><dd><div>2026-11-01T09:30:00.000Z</div></dd>');
    expect(renderHtml(r, ctx('brief'))).not.toContain('2026-11-01T09:30');
    expect(html(sampleFullReport())).not.toContain('Neu ausgewertet');
  });

  it('shows the outcome of the banner clicks in the coverage', () => {
    const r = sampleFullReport();
    r.scan.coverage.consentActions = [
      { action: 'reject', clicked: true, verified: true },
      { action: 'accept', clicked: false, verified: null },
    ];
    expect(html(r)).toContain(
      'Klicks im Einwilligungsbanner: Ablehnen ausgelöst und bestätigt; Annehmen nicht ausgelöst',
    );
  });

  it('prints the draft note once, next to the stamp', () => {
    const texts = loadTexts('de').ui;
    const out = html();
    expect(out).not.toContain(texts['disclaimer.draft']!.text);
    expect(out.split(texts['report.notice.draft']!.text)).toHaveLength(2);
  });

  it('shows a banner screenshot no finding cites under the other screenshots', () => {
    const r = sampleFullReport();
    r.findings = r.findings.filter((f) => f.checkId !== 'CONSENT-04');
    expect(html(r)).toContain('Weitere Screenshots');
  });
});

describe('the action list without an item', () => {
  const actionSection = (out: string) => {
    const start = out.indexOf('>Was zu tun ist</h2>');
    return out.slice(start, out.indexOf('</section>', start));
  };

  it('points to the services table when every finding is an inventory row', () => {
    const r = reportWith([
      inventory(1, 'Matomo', ['tracking', 'not-observed', 'not-observed']),
      inventory(2, 'Vimeo', ['loaded', 'not-observed', 'not-observed']),
    ]);
    for (const detail of ['full', 'brief'] as const) {
      const section = actionSection(renderHtml(r, ctx(detail)));
      expect(section).toContain('Kein Befund, aus dem sich ein Schritt ergibt.');
      expect(section).toContain('Die 2 beobachteten Dienste stehen in der Tabelle „Beobachtete Dienste“.');
      expect(section).not.toContain('Keine Befunde beobachtet');
    }
  });

  it('leaves a suppressed finding out of the list and says that it is suppressed', () => {
    const suppressed = {
      ...entry(1, 'a'),
      suppression: { reason: 'geprüft', expires: '2099-01-01', expired: false },
    };
    const r = reportWith([suppressed]);
    r.summary.counts = { ...r.summary.counts!, info: 0, suppressed: 1 };
    const section = actionSection(renderHtml(r, ctx('brief')));

    expect(section).not.toContain('Eintrag a gefunden');
    expect(section).toContain('Ein Befund ist unterdrückt.');
  });

  it('keeps a finding whose suppression has expired in the list', () => {
    const expired = {
      ...entry(1, 'a'),
      suppression: { reason: 'geprüft', expires: '2020-01-01', expired: true },
    };

    expect(actionSection(renderHtml(reportWith([expired]), ctx('brief')))).toContain('Eintrag a gefunden');
  });

  it('says no findings were observed when the report has none', () => {
    const section = actionSection(renderHtml(reportWith([]), ctx('brief')));

    expect(section).toContain('Keine Befunde beobachtet.');
  });
});
