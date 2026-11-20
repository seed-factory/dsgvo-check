import { describe, expect, it } from 'vitest';
import type { ReportDetail, ReporterContext } from '../../../../src/core/report/reporter.ts';
import type { FullReport } from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';
import { reporterContext } from '../../../utils/report/reporter-inputs.ts';

const ctx = (detail: ReportDetail = 'full', lang: 'de' | 'en' = 'de'): ReporterContext =>
  reporterContext(lang, { detail });

const notice = (r: FullReport | ReturnType<typeof sampleFailedReport>, c: ReporterContext = ctx()) =>
  buildReportView(r, c).notice;

const labels = (group: { items: Array<{ label: string }> }) => group.items.map((i) => i.label);

/** A scan without consent checks, consent click or screenshot: the region does not matter, no condition applies. */
function plainReport(): FullReport {
  const r = sampleFullReport();
  r.checks = r.checks.map((c) => (c.id.startsWith('CONSENT-') ? { ...c, status: 'skipped' } : c));
  r.scan.options = { ...r.scan.options!, assumeRegion: null, screenshots: false };
  r.scan.coverage!.consentActions = [];
  r.findings = r.findings.filter((f) => f.checkId !== 'CONSENT-04');
  r.diagnostics = [];
  return r;
}

describe('the notice section', () => {
  it('sorts the paragraphs into labelled groups: the report and what it stores, then this scan', () => {
    const groups = notice(sampleFullReport());

    expect(groups.map((g) => g.title)).toEqual(['Was dieser Bericht ist', 'Bedingungen dieses Scans']);
    expect(labels(groups[0]!)).toEqual(
      expect.arrayContaining([
        'Art des Berichts',
        'Kein Befund',
        'Einflussfaktoren',
        'Gespeicherte Werte',
        'Verwendung',
        'Textstand',
      ]),
    );
    for (const group of groups) {
      for (const item of group.items) expect(item.text, item.label).not.toBe('');
    }
  });

  it('gives each statement of the base text its own row', () => {
    const [about] = notice(sampleFullReport());
    const byLabel = new Map(about!.items.map((i) => [i.label, i.text]));

    expect(byLabel.get('Art des Berichts')).toMatch(/keine Rechtsberatung/);
    expect(byLabel.get('Art des Berichts')).not.toMatch(/kein Befund/i);
    expect(byLabel.get('Kein Befund')).toMatch(/nicht, dass eine Anforderung erfüllt ist/);
    expect(byLabel.get('Einflussfaktoren')).toMatch(/Standort, Zeitpunkt/);
  });

  it('puts the region first among the conditions of the scan', () => {
    const r = sampleFullReport();
    r.scan.environment!.egress.region = 'unknown';
    const scan = notice(r).find((g) => g.title === 'Bedingungen dieses Scans');

    expect(scan?.items[0]?.label).toBe('Region');
  });

  it('leaves the group of scan conditions out when none of them holds', () => {
    const titles = notice(plainReport()).map((g) => g.title);

    expect(titles).toEqual(['Was dieser Bericht ist']);
  });

  it('prints the draft stamp in the row of the text status, and nothing when the texts are final', () => {
    const [about] = notice(sampleFullReport());
    const draft = about!.items.find((i) => i.label === 'Textstand');
    expect(draft?.stamp).toBeTruthy();

    const c = ctx();
    const reviewed = <T extends { draft: boolean }>(entries: Record<string, T>) =>
      Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...entry, draft: false }]));
    const r = sampleFullReport();
    r.disclaimer.draft = false;
    const final = notice(r, {
      ...c,
      texts: { ...c.texts, ui: reviewed(c.texts.ui), messages: reviewed(c.texts.messages) },
    });
    expect(final.flatMap(labels)).not.toContain('Textstand');
  });

  it('renders each group as a heading over a list of labels and texts', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    const section = html.slice(html.indexOf('<section id="hinweis">'));

    expect(section).toMatch(/<h2>Hinweise zum Bericht<\/h2>/);
    expect(section).toMatch(
      /<h3>Was dieser Bericht ist<\/h3>\s*<dl class="kv notice">\s*<dt>Art des Berichts<\/dt>/,
    );
    expect(section.match(/<dl class="kv notice">/g)).toHaveLength(2);
  });

  it('labels the groups in English for --lang en, with no German paragraph', () => {
    const groups = notice(sampleFullReport(), ctx('full', 'en'));

    expect(groups.map((g) => g.title)).toEqual(['What this report is', 'Conditions of this scan']);
    expect(groups.flatMap((g) => g.items.map((i) => i.text)).join(' ')).not.toMatch(/Dieser Bericht|nicht/);
  });

  it('names no scan phase in the owner report', () => {
    const r = sampleFullReport();
    r.scan.coverage!.consentActions = [{ action: 'accept', clicked: true, verified: true }];
    const owner = notice(r, ctx('brief')).flatMap((g) => g.items);
    const developer = notice(r, ctx('full')).flatMap((g) => g.items);

    const consent = (items: typeof owner) =>
      items.find((i) => i.label === 'Zustimmung im Banner')?.text ?? '';
    expect(consent(owner)).toMatch(
      /^Der Scan hat im Einwilligungsbanner zugestimmt\. Dabei wird die IP-Adresse/,
    );
    expect(consent(owner)).not.toMatch(/Phase/);
    expect(consent(developer)).toMatch(/^Phase C \(Annahme im Einwilligungsbanner\) wurde durchgeführt\./);
  });

  it('groups the notice of a failed report too', () => {
    const groups = notice(sampleFailedReport());

    expect(groups[0]?.title).toBe('Was dieser Bericht ist');
    expect(groups.flatMap(labels)).toContain('Vollständigkeit');
  });
});
