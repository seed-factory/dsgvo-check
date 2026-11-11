import { describe, expect, it } from 'vitest';
import type { CheckResult, Finding, FullReport } from '../../../../src/core/report/schema.ts';
import { buildReportView } from '../../../../src/reporters/report-view.ts';
import { checkResult as check, consentClicks } from '../../../utils/report/reporter-inputs.ts';
import { ctx, entry, findingOf, inventory, RAN_WITH_OPEN_CHECKS, reportWith } from './front-page-fixtures.ts';

const COMPLETE = 'Der Scan wurde vollständig durchgeführt.';

describe('the overview: checks without a result', () => {
  const overview = (checks: CheckResult[], findings: Finding[] = [], lang: 'de' | 'en' = 'de') => {
    const r = reportWith(findings);
    r.checks = checks;
    return buildReportView(r, ctx('brief', lang)).overview;
  };

  it('says the scan was complete only when every check has a result', () => {
    expect(
      overview([check('CONSENT-01', 'completed', null), check('HDR-01', 'not_applicable', 'no-https')]),
    ).toContain(COMPLETE);
    // checks left out with --checks were not asked for
    expect(
      overview([check('CONSENT-01', 'completed', null), check('HDR-01', 'skipped', 'not-selected')]),
    ).toContain(COMPLETE);
  });

  it('names the browser checks an invalid certificate kept from running', () => {
    const sentences = overview([
      check('CONSENT-01', 'skipped', 'tls-blocked'),
      check('PRIV-01', 'skipped', 'tls-blocked'),
      check('HDR-01', 'inconclusive', 'start-page-status', 'http'),
      check('TLS-02', 'completed', null, 'http'),
    ]);

    expect(sentences).not.toContain(COMPLETE);
    expect(sentences).toContain(RAN_WITH_OPEN_CHECKS);
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
    [
      'dialogNotOpened',
      check('CONSENT-04', 'inconclusive', 'cmp-dialog-not-opened'),
      /im Seitenquelltext vorhanden, wurde dem Scanner aber nicht geöffnet \(Bedienelemente deaktiviert\)/,
    ],
  ])('describes the banner state %s', (_state, consent04, sentence) => {
    const sentences = overview([consent04, check('CONSENT-05', 'inconclusive', 'no-reject-click')]);
    expect(sentences.some((s) => sentence.test(s))).toBe(true);
    expect(sentences).toContain(RAN_WITH_OPEN_CHECKS);
  });

  describe('a consent dialog the CMP did not open for the scanner', () => {
    const unopenedChecks = () => [
      check('CONSENT-03', 'inconclusive', 'cmp-dialog-not-opened'),
      check('CONSENT-04', 'inconclusive', 'cmp-dialog-not-opened'),
      check('CONSENT-05', 'inconclusive', 'cmp-dialog-not-opened'),
    ];

    it.each([
      [
        'de',
        'Ein Einwilligungsbanner ist im Seitenquelltext vorhanden, wurde dem Scanner aber nicht geöffnet (Bedienelemente deaktiviert); Ablehnung und Zustimmung wurden daher nicht geprüft.',
      ],
      [
        'en',
        'A consent banner is present in the page source but was not opened for the scanner (controls disabled); rejection and acceptance were therefore not checked.',
      ],
    ] as const)(
      'has its own banner sentence, never the one about a banner not shown visibly (%s)',
      (lang, text) => {
        const sentences = overview(unopenedChecks(), [], lang);

        expect(sentences).toContain(text);
        expect(sentences.join(' ')).not.toMatch(/nicht sichtbar angezeigt|not shown visibly/);
        // The banner sentence explains the open checks; they are not listed again under "no conclusive result".
        expect(sentences.join(' ')).not.toMatch(/CONSENT-0[345]/);
        expect(sentences).not.toContain(COMPLETE);
      },
    );

    it('says nothing about what visitors see', () => {
      const sentence = overview(unopenedChecks()).find((s) => s.includes('Seitenquelltext')) ?? '';
      expect(sentence).not.toMatch(/Besucher|angezeigt|sichtbar/);
    });

    it.each([
      [
        'de',
        'Ein Einwilligungsbanner ist im Seitenquelltext vorhanden, wurde dem Scanner beim Besuch mit Ablehnung aber nicht geöffnet (Bedienelemente deaktiviert); die Ablehnung wurde daher nicht geprüft.',
        /Zustimmung wurden daher nicht geprüft/,
      ],
      [
        'en',
        'A consent banner is present in the page source but was not opened for the scanner in the visit with rejection (controls disabled); rejection was therefore not checked.',
        /acceptance were therefore not checked/,
      ],
    ] as const)(
      'when the dialog opened in the visit with consent and our accept was clicked, only the reject is open (%s)',
      (lang, text, denied) => {
        const r = reportWith([]);
        r.checks = unopenedChecks();
        r.scan.coverage.consentActions = consentClicks({ reject: 'not-clicked', accept: 'confirmed' });

        const sentences = buildReportView(r, ctx('brief', lang)).overview;

        expect(sentences).toContain(text);
        expect(sentences.join(' ')).not.toMatch(denied);
      },
    );

    it('an accept that was not clicked keeps both open', () => {
      const r = reportWith([]);
      r.checks = unopenedChecks();
      r.scan.coverage.consentActions = consentClicks({ reject: 'not-clicked', accept: 'not-clicked' });

      expect(buildReportView(r, ctx('brief')).overview.join(' ')).toMatch(
        /Ablehnung und Zustimmung wurden daher nicht geprüft/,
      );
    });
  });

  describe('a banner observed but not recognised', () => {
    const notRecognized = findingOf(1, 'CONSENT-04.banner-not-recognized', 'info');
    const candidateChecks = () => [
      check('CONSENT-03', 'inconclusive', 'banner-candidate-unrecognized'),
      check('CONSENT-04', 'inconclusive', 'banner-not-recognized'),
      check('CONSENT-05', 'inconclusive', 'banner-not-recognized'),
    ];

    it('the reject and the accept stay open: the scan is not called complete, the banner sentence says why', () => {
      const sentences = overview(candidateChecks(), [notRecognized]);

      expect(sentences).not.toContain(COMPLETE);
      expect(sentences).toContain(RAN_WITH_OPEN_CHECKS);
      expect(sentences.join(' ')).toMatch(/Das Einwilligungsbanner wurde nicht erkannt; .* manuell geprüft/);
      expect(sentences.join(' ')).not.toMatch(/CONSENT-0[345]|kein Einwilligungsbanner gefunden/);
    });

    it('without CONSENT-04 in the report, CONSENT-03 alone still says the banner was not recognised', () => {
      const sentences = overview([check('CONSENT-03', 'inconclusive', 'banner-candidate-unrecognized')]);

      expect(sentences).not.toContain(COMPLETE);
      expect(sentences.join(' ')).toMatch(/Das Einwilligungsbanner wurde nicht erkannt/);
    });

    it('a banner that an older snapshot leaves undetermined keeps the checks open and is neither named nor missing', () => {
      const sentences = overview([
        check('CONSENT-03', 'inconclusive', 'banner-undetermined'),
        check('CONSENT-04', 'inconclusive', 'banner-undetermined'),
        check('CONSENT-05', 'inconclusive', 'banner-undetermined'),
      ]);

      expect(sentences).not.toContain(COMPLETE);
      expect(sentences.join(' ')).not.toMatch(/nicht erkannt|kein Einwilligungsbanner gefunden/);
    });

    it('a not recognised banner is never "complete", even when every check reported a result', () => {
      const sentences = overview([check('CONSENT-04', 'completed', null)], [notRecognized]);

      expect(sentences).not.toContain(COMPLETE);
    });
  });

  it('a banner an adapter recognised whose first layer could not be read is named recognised, its checks stay open', () => {
    const ambiguous = findingOf(1, 'CONSENT-04.banner-not-recognized', 'info', {
      params: {
        cmp: 'cookieman',
        reasons: 'ambiguous-first-layer:blocking-no-reject',
        bannerRecognized: true,
      },
    });
    const sentences = overview([check('CONSENT-04', 'inconclusive', 'banner-not-recognized')], [ambiguous]);

    expect(sentences).not.toContain(COMPLETE);
    expect(sentences.join(' ')).toMatch(
      /Das Einwilligungsbanner wurde erkannt, seine erste Ebene aber nicht eindeutig eingeordnet; .* manuell geprüft/,
    );
    expect(sentences.join(' ')).not.toMatch(/wurde nicht erkannt/);
  });

  it.each([
    [
      'de',
      'Es wurde ein kritischer Befund beobachtet.',
      'Das Einwilligungsbanner wurde erkannt.',
      /kein Einwilligungsbanner gefunden|nicht erkannt/,
    ],
    [
      'en',
      'One critical finding was observed.',
      'The consent banner was recognised.',
      /No consent banner was found|not recognised/,
    ],
  ] as const)(
    'a first layer without a reject is a critical finding about a recognised banner, never a banner called missing (%s)',
    (lang, counts, recognised, missing) => {
      const noReject = findingOf(1, 'CONSENT-04.nonblocking-no-reject', 'critical', {
        params: { cmp: 'wix' },
      });
      const sentences = overview(
        [
          check('CONSENT-03', 'completed', null),
          check('CONSENT-04', 'completed', null),
          check('CONSENT-05', 'inconclusive', 'no-reject-click'),
        ],
        [noReject],
        lang,
      );

      expect(sentences[0]).toBe(counts);
      expect(sentences).toContain(recognised);
      expect(sentences.join(' ')).not.toMatch(missing);
      // The reject that was never clicked stays open, and the overview says so.
      expect(sentences.join(' ')).toContain('(CONSENT-05)');
    },
  );

  // Only CONSENT-04 "no-banner" says the banner is missing; every outcome of a banner an adapter found says otherwise.
  it.each([
    ['completed', null, []],
    ['inconclusive', 'first-layer-not-visible', []],
    ['inconclusive', 'cmp-dialog-not-opened', []],
    ['inconclusive', 'cmp-not-supported', []],
    ['inconclusive', 'unknown-classification', []],
    ['inconclusive', 'bot-mode', []],
    ['inconclusive', 'geo', []],
    ['inconclusive', 'banner-not-recognized', [{ cmp: 'wix', bannerRecognized: true }]],
  ] as const)('CONSENT-04 %s (%s) never gives the sentence of a missing banner', (status, reason, params) => {
    const findings = params.map((p, i) =>
      findingOf(10 + i, 'CONSENT-04.banner-not-recognized', 'info', { params: p }),
    );
    const checks = [
      check('CONSENT-04', status, reason),
      check('CONSENT-05', 'inconclusive', 'no-reject-click'),
    ];

    expect(overview(checks, findings).join(' ')).not.toMatch(/kein Einwilligungsbanner gefunden/);
    expect(overview(checks, findings, 'en').join(' ')).not.toMatch(/No consent banner was found/);
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
    const afterReject = findingOf(1, 'CONSENT-05.tracking-after-reject', 'critical', {
      params: { kind: 'request', service: 'Example Analytics', host: 'a.example', pageCount: 1 },
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

  it('names the browser checks that did not run because the redirect target of a refused certificate failed too', () => {
    const sentences = overview([
      check('CONSENT-01', 'skipped', 'tls-fallback-failed'),
      check('TLS-02', 'completed', null, 'http'),
    ]);

    expect(sentences).toContain(
      'Eine Prüfung (CONSENT-01) wurde nicht ausgeführt: Das Zertifikat der Website wurde nicht als gültig angenommen, und auf dem Ziel ihrer HTTP-Weiterleitung hat der Browser keine auswertbare Seite erhalten.',
    );
    expect(overview([check('CONSENT-01', 'skipped', 'tls-fallback-failed')], [], 'en')).toContain(
      'One check (CONSENT-01) was not run: the certificate of the website was not accepted as valid, and the browser did not receive an evaluable page on the target of its HTTP redirect.',
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
  const consent = findingOf(1, 'CONSENT-01.tracking-completed', 'critical');
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

  function redirectAfterRefusedCertificate(finalUrl = 'https://site.example.test/start'): FullReport {
    const r = reportWith([entry(1, 'a')]);
    r.scan.target = 'https://broken.example.test/';
    r.scan.finalUrl = finalUrl;
    r.scan.entry = {
      reason: 'tls-invalid',
      requested: 'https://broken.example.test/',
      via: 'http://broken.example.test/',
      url: 'https://site.example.test/start',
    };
    return r;
  }

  it('says the browser checks continued on the redirect target of a refused certificate instead of asking for a direct scan', () => {
    const continued = (lang: 'de' | 'en') =>
      buildReportView(redirectAfterRefusedCertificate(), ctx('brief', lang)).overview;

    expect(continued('de')).toContain(
      'Das Zertifikat der angegebenen Adresse broken.example.test wurde nicht als gültig angenommen. Ihre unverschlüsselte Adresse leitet auf site.example.test weiter, dessen Zertifikat als gültig angenommen wurde; die Prüfungen im Browser beziehen sich auf site.example.test.',
    );
    expect(continued('de').join(' ')).not.toContain('direkt gescannt werden');
    expect(continued('en')).toContain(
      'The certificate of the given address broken.example.test was not accepted as valid. Its plain-http address redirects to site.example.test, whose certificate was accepted as valid; the browser checks refer to site.example.test.',
    );
    expect(continued('en').join(' ')).not.toContain('scanned directly');
  });

  it('names the host the browser ended up on when the redirect target sent it on once more', () => {
    const r = redirectAfterRefusedCertificate('https://www.other.example.org/');

    expect(sentences(r)).toContain(
      'Das Zertifikat der angegebenen Adresse broken.example.test wurde nicht als gültig angenommen. Ihre unverschlüsselte Adresse leitet auf site.example.test weiter, dessen Zertifikat als gültig angenommen wurde; die Prüfungen im Browser beziehen sich auf www.other.example.org.',
    );
  });
});
