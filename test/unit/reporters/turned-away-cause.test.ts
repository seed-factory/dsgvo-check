/**
 * Why the scanner saw no banner or no site when something turned it away: a CMP whose own crawler test matched the
 * scanner's User-Agent, or bot or WAF protection on the redirect target of a refused certificate. Every report names
 * the cause, in German and English, in the overview, the diagnostics and the console and summary lines; another cause
 * keeps today's text.
 */
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import type { ReportDetail, ReporterContext } from '../../../src/core/report/reporter.ts';
import type { Diagnostic, FullReport } from '../../../src/core/report/schema.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { buildReportView } from '../../../src/reporters/report-view.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';
import { sampleFullReport } from '../../utils/report/fixtures.ts';

type Lang = 'de' | 'en';
type Check = FullReport['checks'][number];

const ctx = (lang: Lang, detail: ReportDetail = 'full'): ReporterContext => ({
  texts: loadTexts(lang),
  lang,
  outDir: '/nonexistent-out',
  color: false,
  detail,
});

const check = (id: string, status: Check['status'], reason: string | null, module = 'browser'): Check => ({
  id,
  module,
  status,
  reason,
  limitations: [],
  coverage: null,
  durationMs: 1,
});

const diagnostic = (code: string, affects: string[], params: Diagnostic['params']): Diagnostic => ({
  code,
  affects,
  evidenceIds: [],
  messageId: `diagnostic.${code}`,
  params,
});

/** As the HTML report writes a text. */
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');

function report(checks: Check[], diagnostics: Diagnostic[]): FullReport {
  const r = sampleFullReport();
  r.findings = [];
  r.summary.counts = { ...r.summary.counts!, critical: 0, warning: 0, info: 0 };
  r.checks = checks;
  r.diagnostics = diagnostics;
  return r;
}

/** Everything a reader of each format sees: the overview of both reports, the diagnostics, console and summary. */
function rendered(r: FullReport, lang: Lang) {
  const full = buildReportView(r, ctx(lang, 'full'));
  return {
    overview: buildReportView(r, ctx(lang, 'brief')).overview.join(' '),
    fullOverview: full.overview.join(' '),
    checks: new Map((full.checks ?? []).map((c) => [c.id, c.reason])),
    diagnostics: (full.diagnostics ?? []).map((d) => `${d.title}: ${d.body}`).join(' '),
    html: renderHtml(r, ctx(lang, 'full')),
    console: renderConsole(r, ctx(lang)),
    summary: renderSummary(r, ctx(lang)),
  };
}

describe('a CMP whose own crawler test matched the scanner User-Agent', () => {
  const TEST = 'CCM19 isBotBrowser (app.js)';
  const OPEN = ['CONSENT-01', 'CONSENT-03', 'CONSENT-04', 'CONSENT-05', 'EMBED-01'];
  const crawler = () =>
    report(
      [
        ...OPEN.map((id) => check(id, 'inconclusive', 'cmp-bot-user-agent')),
        check('HDR-01', 'completed', null),
      ],
      [diagnostic('SCAN-BOTMODE', OPEN, { signal: 'bot-user-agent', cause: 'user-agent', test: TEST })],
    );

  const WORDS = {
    de: {
      banner:
        'Ein Einwilligungsbanner ist im Seitenquelltext vorhanden, wurde dem Scanner aber nicht geöffnet: Das Banner behandelt Browser, deren User-Agent auf sein Erkennungsmuster für Crawler (CCM19 isBotBrowser (app.js)) passt, als Bot und öffnet ihnen sein Banner nicht, und der User-Agent des Scanners passt auf dieses Muster. Ein Besucher mit einem üblichen Browser sieht das Banner womöglich. Die davon abhängigen Prüfungen (CONSENT-01, CONSENT-03, CONSENT-04, CONSENT-05, EMBED-01) sind nicht eindeutig; Ablehnung und Zustimmung wurden nicht geprüft.',
      reason:
        'Einwilligungsbanner dem Scanner nicht geöffnet: User-Agent passt auf das Crawler-Muster des Banners',
      title: 'Einwilligungsbanner öffnet sich nicht für den User-Agent des Scanners',
      body: /Erkennungsmuster für Crawler \(CCM19 isBotBrowser \(app\.js\)\).*User-Agent des Scanners passt.*Besucher mit einem üblichen Browser sieht das Banner womöglich/,
      generic: 'Einwilligungsbanner verhält sich wie gegenüber einem Bot',
    },
    en: {
      banner:
        "A consent banner is present in the page source but was not opened for the scanner: the banner treats browsers whose User-Agent matches its pattern for crawlers (CCM19 isBotBrowser (app.js)) as bots and does not open its banner for them, and the scanner's User-Agent matches this pattern. A visitor with a normal browser may see the banner. The checks that depend on it (CONSENT-01, CONSENT-03, CONSENT-04, CONSENT-05, EMBED-01) are inconclusive; rejection and acceptance were not checked.",
      reason:
        "consent banner not opened for the scanner: its User-Agent matches the banner's crawler pattern",
      title: "Consent banner does not open for the scanner's User-Agent",
      body: /pattern for crawlers \(CCM19 isBotBrowser \(app\.js\)\).*scanner's User-Agent matches.*visitor with a normal browser may see the banner/,
      generic: 'Consent banner behaves as towards a bot',
    },
  } as const;

  it.each(['de', 'en'] as const)('names the crawler test in every report (%s)', (lang) => {
    const w = WORDS[lang];
    const out = rendered(crawler(), lang);

    expect(out.overview).toContain(w.banner);
    expect(out.fullOverview).toContain(w.banner);
    // The banner sentence names the open checks; they are not listed again under "no conclusive result".
    expect(out.overview.match(/CONSENT-01/g)).toHaveLength(1);
    for (const id of OPEN) expect(out.checks.get(id)).toBe(w.reason);
    expect(out.diagnostics).toContain(w.title);
    expect(out.diagnostics).toMatch(w.body);
    expect(out.html).toContain(escaped(w.title));
    expect(out.console).toContain(`SCAN-BOTMODE: ${w.title}`);
    expect(out.summary).toContain(w.title);
    expect(`${out.overview} ${out.diagnostics}`).not.toContain(w.generic);
  });

  it.each([
    [
      'de',
      'wurde dem Scanner beim Besuch mit Ablehnung aber nicht geöffnet: Das Banner behandelt Browser',
      'sind nicht eindeutig; die Ablehnung wurde nicht geprüft.',
      /Zustimmung wurden nicht geprüft/,
    ],
    [
      'en',
      'was not opened for the scanner in the visit with rejection: the banner treats browsers',
      'are inconclusive; rejection was not checked.',
      /acceptance were not checked/,
    ],
  ] as const)(
    'when the banner opened in the visit with consent and our accept was clicked, only the reject is open (%s)',
    (lang, visit, open, denied) => {
      const r = crawler();
      r.scan.coverage.consentActions = [
        { action: 'reject', clicked: false, verified: null },
        { action: 'accept', clicked: true, verified: true },
      ];
      const out = rendered(r, lang);

      expect(out.overview).toContain(visit);
      expect(out.overview).toContain(open);
      expect(out.overview).not.toMatch(denied);
    },
  );

  it.each(['de', 'en'] as const)(
    'counterexample: another bot signal keeps the general bot text (%s)',
    (lang) => {
      const r = report(
        [check('CONSENT-01', 'inconclusive', 'bot-mode'), check('CONSENT-04', 'inconclusive', 'bot-mode')],
        [diagnostic('SCAN-BOTMODE', ['CONSENT-01', 'CONSENT-04'], { signal: 'rcb:accept-all-for-bots' })],
      );
      const out = rendered(r, lang);

      expect(out.diagnostics).toContain(WORDS[lang].generic);
      expect(out.diagnostics).toContain('rcb:accept-all-for-bots');
      expect(out.console).toContain(`SCAN-BOTMODE: ${WORDS[lang].generic}`);
      expect(`${out.overview} ${out.diagnostics}`).not.toMatch(/Crawler|crawler/);
    },
  );

  it.each(['de', 'en'] as const)(
    'counterexample: a dialog that stayed closed without the crawler signal keeps its own sentence (%s)',
    (lang) => {
      const r = report(
        ['CONSENT-03', 'CONSENT-04', 'CONSENT-05'].map((id) =>
          check(id, 'inconclusive', 'cmp-dialog-not-opened'),
        ),
        [],
      );
      const out = rendered(r, lang);

      expect(out.overview).toMatch(/\(Bedienelemente deaktiviert\)|\(controls disabled\)/);
      expect(out.overview).not.toMatch(/Crawler|crawler|Besucher|visitor/);
    },
  );
});

describe('bot or WAF protection on the redirect target of a refused certificate', () => {
  const VIA = 'http://broken.example.test/';
  const URL = 'https://site.example.test/';
  const tlsBlocked = (extra: Record<string, string>) =>
    report(
      [
        check('CONSENT-01', 'skipped', 'tls-fallback-failed'),
        check('PRIV-01', 'skipped', 'tls-fallback-failed'),
      ],
      [
        diagnostic('SCAN-TLS-BLOCKED', ['CONSENT-01', 'PRIV-01'], {
          host: 'broken.example.test',
          via: VIA,
          url: URL,
          ...extra,
        }),
      ],
    );

  const WORDS = {
    de: {
      open: '2 Prüfungen (CONSENT-01, PRIV-01) wurden nicht ausgeführt: Das Zertifikat der Website wurde nicht als gültig angenommen, und das Ziel ihrer HTTP-Weiterleitung hat mit dem Signal eines Bot- oder WAF-Schutzes geantwortet (header:x-vercel-mitigated); der Browser hat dort keine auswertbare Seite erhalten.',
      today:
        '2 Prüfungen (CONSENT-01, PRIV-01) wurden nicht ausgeführt: Das Zertifikat der Website wurde nicht als gültig angenommen, und auf dem Ziel ihrer HTTP-Weiterleitung hat der Browser keine auswertbare Seite erhalten.',
      title:
        'Browser-Prüfungen nicht ausgeführt: Zertifikat ungültig, Ziel der HTTP-Weiterleitung mit Bot- oder WAF-Schutz (header:x-vercel-mitigated)',
      body: `Die unverschlüsselte Adresse ${VIA} leitet auf ${URL} weiter; dort hat der Browser keine auswertbare Seite erhalten: Das Ziel antwortete mit dem Signal eines Bot- oder WAF-Schutzes (header:x-vercel-mitigated).`,
      todayBody: `Die unverschlüsselte Adresse ${VIA} leitet auf ${URL} weiter; dort hat der Browser keine auswertbare Seite erhalten.`,
      plainTitle: 'Browser-Prüfungen nicht ausgeführt: Zertifikat ungültig',
      protection: /Bot- oder WAF-Schutz/,
    },
    en: {
      open: '2 checks (CONSENT-01, PRIV-01) were not run: the certificate of the website was not accepted as valid, and the target of its HTTP redirect answered with the signal of a bot or WAF protection (header:x-vercel-mitigated); the browser did not receive an evaluable page there.',
      today:
        '2 checks (CONSENT-01, PRIV-01) were not run: the certificate of the website was not accepted as valid, and the browser did not receive an evaluable page on the target of its HTTP redirect.',
      title:
        'Browser checks not run: certificate invalid, target of the HTTP redirect with bot or WAF protection (header:x-vercel-mitigated)',
      body: `The plain-http address ${VIA} redirects to ${URL}; the browser did not receive an evaluable page there: the target answered with the signal of a bot or WAF protection (header:x-vercel-mitigated).`,
      todayBody: `The plain-http address ${VIA} redirects to ${URL}; the browser did not receive an evaluable page there.`,
      plainTitle: 'Browser checks not run: certificate invalid',
      protection: /bot or WAF protection/,
    },
  } as const;

  it.each(['de', 'en'] as const)('names the protection and its signal in every report (%s)', (lang) => {
    const w = WORDS[lang];
    const out = rendered(
      tlsBlocked({ fallback: 'bot-protection', signals: 'header:x-vercel-mitigated' }),
      lang,
    );

    expect(out.overview).toContain(w.open);
    expect(out.fullOverview).toContain(w.open);
    expect(out.diagnostics).toContain(w.title);
    expect(out.diagnostics).toContain(w.body);
    expect(out.html).toContain(escaped(w.title));
    expect(out.console).toContain(`SCAN-TLS-BLOCKED: ${w.title}`);
    expect(out.summary).toContain(w.title);
  });

  it.each(['de', 'en'] as const)(
    'counterexample: a redirect target that failed for another reason keeps today’s text (%s)',
    (lang) => {
      const w = WORDS[lang];
      for (const r of [
        tlsBlocked({ fallback: 'blocked' }),
        report([check('CONSENT-01', 'skipped', 'tls-fallback-failed')], []),
      ]) {
        const out = rendered(r, lang);
        expect(`${out.overview} ${out.diagnostics} ${out.console} ${out.summary}`).not.toMatch(w.protection);
      }
      const out = rendered(tlsBlocked({ fallback: 'blocked' }), lang);
      expect(out.overview).toContain(w.today);
      expect(out.diagnostics).toContain(w.todayBody);
      expect(out.console).toContain(`SCAN-TLS-BLOCKED: ${w.plainTitle} (`);
    },
  );
});
