import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../../src/core/data/load.ts';
import type { FullReport } from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';
import { checkResult as check, consentClicks } from '../../../utils/report/reporter-inputs.ts';
import { ctx } from './front-page-fixtures.ts';

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
    'tls-blocked tls-fallback-failed timeout exception invalid-observation',
    // browser checks; CONSENT-05 passes on why the visit with the reject did not start
    'throttled geo bot-mode cmp-not-observed no-banner banner-not-recognized cmp-not-supported',
    'first-layer-not-visible unknown-classification consent-frame-unresolved banner-candidate-unrecognized',
    'banner-undetermined cmp-dialog-not-opened cmp-bot-user-agent',
    'no-pre-consent-observation',
    'no-network-observation phase-b-missing phase-c-missing time-budget request-cap no-reject-click',
    'reject-not-confirmed pagehide-capture-unavailable legal-targets-not-evaluable privacy-policy-not-found',
    'pdf-not-evaluated unsupported-format language-unsupported document-incomplete no-evaluable-pages',
    'insufficient-pages contact-page-not-evaluable claim-ambiguous',
    // http and dns checks
    'blocked start-page-unavailable start-page-status tls-invalid no-https handshake-inconclusive undecided',
    'ip-target no-registrable-domain multiple-records',
  ].flatMap((line) => line.split(' '));

  it.each(['de', 'en'] as const)('words every reason a check can end with (%s)', (lang) => {
    const r = sampleFullReport();
    const id = (n: number) => `TEST-${String(n).padStart(2, '0')}`;
    r.checks = CHECK_REASONS.map((reason, n) => check(id(n), 'inconclusive', reason));
    const shown = new Map(buildReportView(r, ctx('full', lang)).checks!.map((c) => [c.id, c.reason]));

    expect(CHECK_REASONS.filter((reason, n) => shown.get(id(n)) === reason)).toEqual([]);
  });

  it.each([
    ['de', 'reject-not-in-effect', /nach der Ablehnung.*erneut/],
    ['de', 'accept-not-in-effect', /nach der Zustimmung.*erneut/],
    ['en', 'reject-not-in-effect', /after the rejection.*again/],
    ['en', 'accept-not-in-effect', /after the acceptance.*again/],
  ] as const)(
    'words the control pages left out because the click decision is not in effect there (%s, %s)',
    (lang, code, words) => {
      const r = sampleFullReport();
      r.checks = [
        {
          ...check('CONSENT-05', 'partial', null),
          limitations: [code],
          coverage: { observed: 4, evaluated: 2 },
        },
      ];
      const [shown] = buildReportView(r, ctx('full', lang)).checks!;
      expect(shown?.limitations).toEqual([{ text: expect.stringMatching(words), code: null }]);
    },
  );

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
    r.scan.coverage.consentActions = consentClicks({ reject: 'not-clicked', accept: 'not-clicked' });
    const failed = html(r);
    expect(failed).toContain(
      'A (vor einer Interaktion), B (erneuter Besuch, keine Ablehnung ausgelöst), C (erneuter Besuch, keine Annahme ausgelöst)',
    );
    expect(failed).toContain('<td>A, B (ohne Ablehnung), C (ohne Annahme)</td>');
    expect(failed).not.toContain('B (nach Ablehnung)');
    expect(html(r, 'en')).toContain(
      'B (repeat visit, no rejection made), C (repeat visit, no acceptance made)',
    );

    r.scan.coverage.consentActions = consentClicks({ reject: 'confirmed', accept: 'unconfirmed' });
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
    r.scan.coverage.consentActions = consentClicks({ reject: 'confirmed', accept: 'not-clicked' });
    expect(html(r)).toContain(
      'Klicks im Einwilligungsbanner: Ablehnen ausgelöst und bestätigt; Annehmen nicht ausgelöst',
    );
  });

  it('names a reject saved in the settings layer in the coverage', () => {
    const r = sampleFullReport();
    r.scan.coverage.consentActions = [
      { action: 'reject', clicked: true, verified: true, path: 'settings' },
      { action: 'accept', clicked: true, verified: true },
    ];
    expect(html(r)).toContain(
      'Klicks im Einwilligungsbanner: Ablehnen über die Einstellungen ausgelöst und bestätigt; Annehmen ausgelöst und bestätigt',
    );
    expect(html(r, 'en')).toContain('reject click via the settings triggered and confirmed');
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
