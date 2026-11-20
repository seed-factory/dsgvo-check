import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../../src/core/data/load.ts';
import type { Finding } from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';
import { consentClicks } from '../../../utils/report/reporter-inputs.ts';
import { ctx, entry, findingOf, inventory, RAN_WITH_OPEN_CHECKS, reportWith } from './front-page-fixtures.ts';

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
      findingOf(1, 'CONSENT-01.tracking-completed', 'critical'),
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
    const r = reportWith([findingOf(1, 'CONSENT-04.banner-not-recognized', 'info')]);
    const sentences = buildReportView(r, ctx()).overview;

    expect(sentences[0]).toBe(
      'Es wurden keine kritischen Befunde beobachtet. Dazu kommt ein Hinweis zur Information.',
    );
    // CONSENT-04 is inconclusive and MAIL-01 failed: the scan ran, but not every check has a result
    expect(sentences[1]).toBe(RAN_WITH_OPEN_CHECKS);
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
    r.scan.coverage.consentActions = consentClicks({ reject: 'confirmed', accept: 'unconfirmed' });
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

  it('is the full report when no level is given', () => {
    const { detail: _unused, ...withoutDetail } = ctx('full');
    expect(renderHtml(sampleFullReport(), withoutDetail)).toBe(renderHtml(sampleFullReport(), ctx('full')));
  });
});
