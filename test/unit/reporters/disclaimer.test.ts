/**
 * Disclaimer with conditional paragraphs: each is rendered only when its condition holds in the report, in every
 * human-readable format and in `disclaimer.text` of the JSON report; every condition in both states.
 */
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data/load.ts';
import { templateParams, uiText } from '../../../src/core/data/messages.ts';
import type { FullReport, MessageParams, Report } from '../../../src/core/report/schema.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { DISCLAIMER_KEYS, disclaimerParagraphs, disclaimerText } from '../../../src/reporters/disclaimer.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderJson } from '../../../src/reporters/json.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report/fixtures.ts';
import { reporterContext as ctx } from '../../utils/report/reporter-inputs.ts';

const para = (key: string, params: MessageParams = {}, lang: 'de' | 'en' = 'de') =>
  uiText(loadTexts(lang), key, params);

type Mutate = (r: FullReport) => void;

interface Case {
  key: string;
  params?: MessageParams;
  on: Mutate;
  off: Mutate[];
}

const CASES: Case[] = [
  {
    key: 'disclaimer.screenshots',
    on: (r) => {
      r.scan.options!.screenshots = true;
    },
    off: [
      (r) => {
        r.scan.options!.screenshots = false;
      },
      // the option was on, but no image was taken
      (r) => {
        r.evidence = r.evidence.filter((e) => e.type !== 'screenshot');
      },
    ],
  },
  {
    key: 'disclaimer.bannerNotRecognized',
    on: () => {}, // the sample has CONSENT-04 banner-not-recognized
    off: [
      (r) => {
        r.findings = r.findings.filter((f) => f.variant !== 'banner-not-recognized');
      },
    ],
  },
  {
    key: 'disclaimer.botOrGeo',
    params: { checks: 'CONSENT-01, CONSENT-03' },
    on: (r) => {
      r.diagnostics = [
        { code: 'SCAN-GEO', affects: ['CONSENT-03', 'CONSENT-01'], evidenceIds: [] },
        { code: 'SCAN-BOTMODE', affects: ['CONSENT-01'], evidenceIds: [] },
      ];
    },
    off: [
      (r) => {
        r.diagnostics = [{ code: 'SCAN-TIMEOUT', affects: ['CONSENT-01'], evidenceIds: [] }];
      },
    ],
  },
  {
    key: 'disclaimer.egressUnknown',
    on: (r) => {
      r.scan.environment.egress = { mode: 'direct', region: 'unknown', source: 'nicht festgestellt' };
    },
    off: [
      (r) => {
        r.scan.environment.egress = {
          mode: 'direct',
          region: 'asserted',
          assertedRegion: 'de',
          source: 'laut Nutzerangabe (--assume-region)',
        };
        r.scan.options!.assumeRegion = 'de';
      },
      // no active CONSENT check
      (r) => {
        r.checks = r.checks.filter((c) => !c.id.startsWith('CONSENT-'));
      },
      (r) => {
        for (const c of r.checks) if (c.id.startsWith('CONSENT-')) c.status = 'skipped';
      },
    ],
  },
  {
    key: 'disclaimer.egressAsserted',
    params: { region: 'de' },
    on: (r) => {
      r.scan.environment.egress = {
        mode: 'direct',
        region: 'asserted',
        assertedRegion: 'de',
        source: 'laut Nutzerangabe (--assume-region)',
      };
      r.scan.options!.assumeRegion = 'de';
    },
    off: [
      (r) => {
        r.scan.environment.egress = { mode: 'direct', region: 'unknown', source: 'nicht festgestellt' };
        r.scan.options!.assumeRegion = null;
      },
    ],
  },
  {
    key: 'disclaimer.proxy',
    on: (r) => {
      r.scan.options!.proxy = true;
      r.scan.environment.egress.mode = 'proxy';
    },
    off: [
      (r) => {
        r.scan.options!.proxy = false;
        r.scan.environment.egress.mode = 'direct';
      },
    ],
  },
  {
    key: 'disclaimer.sandboxOff',
    on: (r) => {
      r.scan.options!.sandbox = 'off';
      r.scan.environment.sandbox = { mode: 'off', active: false };
    },
    off: [
      (r) => {
        r.scan.options!.sandbox = 'require';
        r.scan.environment.sandbox = { mode: 'require', active: true };
      },
      (r) => {
        r.scan.options!.sandbox = 'container';
        r.scan.environment.sandbox = { mode: 'container', active: false };
      },
    ],
  },
  {
    // the exit reasons in words; findings above the threshold are no gap of the scan
    key: 'disclaimer.incomplete',
    params: { status: 'partial', hasReasons: true, reasons: 'Prüfung MAIL-01 fehlgeschlagen' },
    on: (r) => {
      r.scan.status = 'partial';
    },
    off: [
      (r) => {
        r.scan.status = 'complete';
      },
    ],
  },
  {
    key: 'disclaimer.phaseC',
    on: () => {}, // the start page of the sample was visited in phases A, B and C (no click outcome recorded)
    off: [
      (r) => {
        for (const p of r.scan.coverage.pages) p.phases = p.phases.filter((ph) => ph !== 'C');
      },
      // phase C ran, but the accept click did not take place
      (r) => {
        r.scan.coverage.consentActions = [{ action: 'accept', clicked: false, verified: null }];
      },
      // no phase C at all
      (r) => {
        r.scan.coverage.consentActions = [{ action: 'reject', clicked: true, verified: true }];
      },
    ],
  },
  {
    key: 'disclaimer.phaseCFailed',
    on: (r) => {
      r.scan.coverage.consentActions = [{ action: 'accept', clicked: false, verified: null }];
    },
    off: [
      (r) => {
        r.scan.coverage.consentActions = [{ action: 'accept', clicked: true, verified: true }];
      },
      (r) => {
        r.scan.coverage.consentActions = [];
      },
    ],
  },
  {
    key: 'disclaimer.draft',
    on: (r) => {
      r.disclaimer.draft = true;
    },
    off: [
      (r) => {
        r.disclaimer.draft = false;
      },
    ],
  },
];

function report(...mutations: Mutate[]): FullReport {
  const r = sampleFullReport();
  for (const m of mutations) m(r);
  return r;
}

describe('disclaimer paragraphs: each condition in both states', () => {
  it.each(CASES.map((c) => [c.key, c]))('%s', (_key, c) => {
    const expected = para(c.key, c.params);

    expect(disclaimerParagraphs(report(c.on), ctx().texts)).toContain(expected);

    for (const off of c.off) {
      const paragraphs = disclaimerParagraphs(report(c.on, off), ctx().texts);
      const stillShown = paragraphs.filter((p) => p === expected || p.startsWith(expected.slice(0, 40)));
      expect(stillShown).toEqual([]);
    }
  });

  it('always starts with the base text of the texts and ends with the usage note; data minimization is always stated', () => {
    const r = sampleFullReport();

    const paragraphs = disclaimerParagraphs(r, ctx().texts);

    expect(paragraphs[0]).toBe(para('disclaimer'));
    expect(paragraphs).toContain(para('disclaimer.data'));
    expect(paragraphs.at(-1)).toBe(para('disclaimer.usage'));
  });

  it('a banner an adapter recognised, whose first layer could not be read, is attributed: no such paragraph', () => {
    const r = report((x) => {
      const f = x.findings.find((y) => y.variant === 'banner-not-recognized');
      if (f) f.params = { ...f.params, cmp: 'cookieman', bannerRecognized: true };
    });

    expect(disclaimerParagraphs(r, ctx().texts)).not.toContain(para('disclaimer.bannerNotRecognized'));
  });

  it('an unsupported CMP version counts as a banner that was not recognised', () => {
    const r = report((x) => {
      const f = x.findings.find((y) => y.variant === 'banner-not-recognized');
      if (f) f.variant = 'cmp-not-supported';
    });

    expect(disclaimerParagraphs(r, ctx().texts)).toContain(para('disclaimer.bannerNotRecognized'));
  });

  it('a partial scan without exit reasons gets no empty parentheses', () => {
    const r = report((x) => {
      x.scan.status = 'partial';
      x.summary.exitReasons = [];
      x.summary.exitCode = 0;
    });

    const p = disclaimerParagraphs(r, ctx().texts).find((s) =>
      s.startsWith(para('disclaimer.incomplete', { status: 'partial', hasReasons: false, reasons: '' })),
    );

    expect(p).toBeDefined();
    expect(p).not.toContain('()');
  });

  it('failed report: incomplete with its reasons, nothing about screenshots, egress or phase C', () => {
    const paragraphs = disclaimerParagraphs(sampleFailedReport(), ctx().texts);

    expect(paragraphs).toContain(
      para('disclaimer.incomplete', {
        status: 'failed',
        hasReasons: true,
        reasons: 'Website nicht erreichbar',
      }),
    );
    for (const key of ['disclaimer.screenshots', 'disclaimer.egressUnknown', 'disclaimer.phaseC']) {
      expect(paragraphs).not.toContain(para(key));
    }
  });

  it('is idempotent: a report whose text already carries the paragraphs is not extended again', () => {
    const r = sampleFullReport();
    const first = JSON.parse(renderJson(r, ctx())) as Report;
    const second = JSON.parse(renderJson(first, ctx())) as Report;

    expect(second.disclaimer.text).toBe(first.disclaimer.text);
  });

  it('every disclaimer key exists in de and en with the same parameters', () => {
    const de = loadTexts('de').ui;
    const en = loadTexts('en').ui;

    for (const key of DISCLAIMER_KEYS) {
      expect(de[key]?.text, `de ${key}`).toBeTypeOf('string');
      expect(en[key]?.text, `en ${key}`).toBeTypeOf('string');
      expect(templateParams(en[key]!.text).sort(), key).toEqual(templateParams(de[key]!.text).sort());
    }
    expect(DISCLAIMER_KEYS).toEqual(expect.arrayContaining(CASES.map((c) => c.key)));
  });

  it('English texts render in English', () => {
    const paragraphs = disclaimerParagraphs(report(), ctx('en').texts);

    expect(paragraphs).toContain(para('disclaimer.phaseC', {}, 'en'));
    expect(para('disclaimer.phaseC', {}, 'en')).toMatch(/IP address/);
  });

  it('a report saved in German renders in English without a German paragraph', () => {
    const r = sampleFullReport();
    r.disclaimer = {
      messageId: 'disclaimer',
      lang: 'de',
      text: disclaimerText(r, ctx('de').texts),
      draft: true,
    };

    const paragraphs = disclaimerParagraphs(r, ctx('en').texts);
    const json = JSON.parse(renderJson(r, ctx('en'))) as Report;

    expect(paragraphs[0]).toBe(para('disclaimer', {}, 'en'));
    expect(paragraphs[0]).toMatch(/^This report describes/);
    expect(paragraphs.join('\n')).toMatch(/not legal advice/);
    expect(paragraphs.join('\n')).not.toMatch(/Dieser Bericht|Rechtsberatung|Werte von Cookies/);
    expect(json.disclaimer).toMatchObject({ lang: 'en' });
    expect(json.disclaimer.text).not.toMatch(/Dieser Bericht/);
  });

  it('an accept the banner did not confirm is said so in the paragraph of phase C', () => {
    const confirmed = report((r) => {
      r.scan.coverage.consentActions = [{ action: 'accept', clicked: true, verified: true }];
    });
    const unconfirmed = report((r) => {
      r.scan.coverage.consentActions = [{ action: 'accept', clicked: true, verified: false }];
    });

    expect(disclaimerParagraphs(confirmed, ctx().texts)).toContain(
      para('disclaimer.phaseC', { verified: true }),
    );
    expect(disclaimerParagraphs(unconfirmed, ctx().texts)).toContain(
      para('disclaimer.phaseC', { verified: false }),
    );
    expect(para('disclaimer.phaseC', { verified: false })).toMatch(/Annahme nicht vollständig bestätigt/);
    expect(para('disclaimer.phaseC', { verified: true })).not.toMatch(/nicht bestätigt/);
  });

  it('the report for the site owner names no command-line options; the full report does', () => {
    const r = report((x) => {
      x.scan.options = { ...x.scan.options!, proxy: true, sandbox: 'off', assumeRegion: 'de' };
      x.scan.environment.sandbox = { mode: 'off', active: false };
    });

    const brief = disclaimerParagraphs(r, ctx().texts, { detail: 'brief' }).join('\n');
    const full = disclaimerParagraphs(r, ctx().texts, { detail: 'full' }).join('\n');

    expect(brief).not.toMatch(/--[a-z]/);
    for (const option of ['--no-screenshots', '--proxy', '--sandbox off', '--assume-region']) {
      expect(full).toContain(option);
    }
  });

  it('leaves the draft paragraph out where the report prints its own draft line', () => {
    const r = report((x) => {
      x.disclaimer.draft = true;
    });

    expect(disclaimerParagraphs(r, ctx().texts)).toContain(para('disclaimer.draft'));
    expect(disclaimerParagraphs(r, ctx().texts, { withoutDraft: true })).not.toContain(
      para('disclaimer.draft'),
    );
  });
});

describe('disclaimer in every format', () => {
  // Phase C ran and the sandbox was off: both paragraphs must reach every output.
  const r = () =>
    report((x) => {
      x.scan.options!.sandbox = 'off';
      x.scan.environment.sandbox = { mode: 'off', active: false };
    });
  // The same report once the "phase C ran" condition no longer holds.
  const withoutPhaseC = () => report(CASES.find((c) => c.key === 'disclaimer.phaseC')!.off[0]!);
  const PHASE_C = /IP-Adresse des prüfenden Rechners/;

  it('console', () => {
    const out = renderConsole(r(), ctx());
    const withoutC = renderConsole(withoutPhaseC(), ctx());

    expect(out).toMatch(PHASE_C);
    expect(out).toContain(para('disclaimer.sandboxOff'));
    expect(withoutC).not.toMatch(PHASE_C);
  });

  it('HTML (notice section and Messumgebung)', () => {
    const html = renderHtml(r(), ctx());
    const notice = html.slice(html.indexOf('<section id="hinweis">'));
    const env = html.slice(
      html.indexOf('<section id="messumgebung">'),
      html.indexOf('<section id="abdeckung">'),
    );
    const withoutC = renderHtml(withoutPhaseC(), ctx());

    expect(notice).toMatch(PHASE_C);
    expect(notice).toContain(para('disclaimer.sandboxOff'));
    expect(env).toContain(uiText(loadTexts('de'), 'report.env.phaseC'));
    expect(withoutC).not.toMatch(PHASE_C);
    expect(withoutC).not.toContain(uiText(loadTexts('de'), 'report.env.phaseC'));
  });

  it('Job Summary', () => {
    const md = renderSummary(r(), ctx());
    const withoutC = renderSummary(withoutPhaseC(), ctx());

    expect(md).toMatch(PHASE_C);
    expect(md).toContain('Chromium-Sandbox');
    expect(withoutC).not.toMatch(PHASE_C);
  });

  it('JSON: disclaimer.text carries the paragraphs, separated by blank lines', () => {
    const baseText = para('disclaimer');

    const json = JSON.parse(renderJson(r(), ctx())) as Report;

    expect(json.disclaimer.text).toMatch(PHASE_C);
    expect(json.disclaimer.text.split('\n\n')).toContain(para('disclaimer.sandboxOff'));
    expect(json.disclaimer.text.slice(0, baseText.length)).toBe(baseText);
  });

  it('JSON without texts (minimal failed report written synchronously) keeps the base text', () => {
    const failed = sampleFailedReport();

    const json = JSON.parse(renderJson(failed, null as never)) as Report;

    expect(json.disclaimer).toEqual(failed.disclaimer);
  });
});
