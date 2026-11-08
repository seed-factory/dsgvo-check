/**
 * Orchestrator robustness: the global timeout after a partial browser collection, a browser collector that hands over
 * nothing, texts of SCAN-BLOCKED / SCAN-TIMEOUT / SCAN-PRIVATE-REQUEST-BLOCKED, Nutzungshinweise, the CA setting.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { consent03 } from '../../../src/checks/browser/consent-03.ts';
import { consent05 } from '../../../src/checks/browser/consent-05.ts';
import { loadTexts } from '../../../src/core/data/load.ts';
import { renderMessage, uiText } from '../../../src/core/data/messages.ts';
import { defineCheck } from '../../../src/core/evaluation/check.ts';
import { executeCheck } from '../../../src/core/evaluation/execute.ts';
import { CheckRegistry } from '../../../src/core/evaluation/registry.ts';
import { createLogger } from '../../../src/core/runtime/logger.ts';
import { uaToken } from '../../../src/core/runtime/user-agent.ts';
import type { Collectors } from '../../../src/core/snapshot/collector.ts';
import type { ScanOptions } from '../../../src/scan-options.ts';
import { expectValidReport } from '../../utils/report/validator.ts';
import { fakeCollectors, testDataDir } from '../../utils/scan-harness.ts';
import {
  checkContext,
  makeBrowser,
  makeCmp,
  makeDns,
  makeDnsQuery,
  makePage,
  makePhase,
  makeSnapshot,
  REPO_ROOT,
  withDerived,
} from '../../utils/snapshot-builder.ts';
import { abortAware, scanWith } from './fixtures.ts';

const START = 'https://www.example.de/';
const startVisit = () => makePage({ url: START, phase: 'A' });
describe('checks that lack data because the deadline cut the browser collection end in error/timeout', () => {
  const partial = (phases: ReturnType<typeof makePhase>[], reason: string | null = 'timeout') =>
    withDerived(
      makeSnapshot({
        browser: makeBrowser({ phases }),
        cmp: makeCmp(),
        collection: { browser: { status: 'partial', durationMs: 1, ...(reason ? { reason } : {}) } },
      }),
    );
  const run = (check: Parameters<typeof executeCheck>[0], snapshot: ReturnType<typeof partial>) =>
    executeCheck(check, snapshot, checkContext({ dataDirs: check.data ?? [] }), { timedOut: true });

  it('phase B never started (no record) → CONSENT-05 error/timeout, limitation deadline:phase-b-missing', () => {
    const r = run(consent05, partial([makePhase('A', { pages: [startVisit()] })]));
    expect(r).toMatchObject({ status: 'error', reason: 'timeout', outcome: null });
    expect(r.limitations).toEqual(['deadline:phase-b-missing']);
  });

  it('phase B recorded as skipped by the deadline → error/timeout as well', () => {
    const r = run(
      consent05,
      partial([
        makePhase('A', { pages: [startVisit()] }),
        makePhase('B', { status: 'skipped', reason: 'timeout' }),
      ]),
    );
    expect(r).toMatchObject({ status: 'error', reason: 'timeout' });
  });

  it('too few pages because the deadline cut phase A → CONSENT-03 error/timeout', () => {
    const r = run(
      consent03,
      partial([makePhase('A', { status: 'partial', reason: 'timeout', pages: [startVisit()] })]),
    );
    expect(r).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(r.limitations).toEqual(['deadline:insufficient-pages']);
  });

  // the reason belongs to a phase; only a phase the deadline cut makes the deadline the cause.
  describe('a reason from a phase that ended by itself stays inconclusive when only a later phase was cut', () => {
    const cutC = makePhase('C', { status: 'partial', reason: 'timeout' });
    const skippedC = makePhase('C', { status: 'skipped', reason: 'timeout' });

    it('A and B completed, C cut: CONSENT-03 insufficient-pages stays inconclusive', () => {
      const snapshot = partial([
        makePhase('A', { pages: [startVisit()] }),
        makePhase('B', { pages: [startVisit()] }),
        cutC,
      ]);
      const r = run(consent03, snapshot);
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'insufficient-pages' });
      expect(r.limitations ?? []).not.toContain('deadline:insufficient-pages');
    });

    it('A and B completed, C cut: CONSENT-05 no-reject-click stays inconclusive (B did run)', () => {
      const snapshot = partial([
        makePhase('A', { pages: [startVisit()] }),
        makePhase('B', { status: 'partial', reason: 'no-reject-button', pages: [startVisit()] }),
        skippedC,
      ]);
      const r = run(consent05, snapshot);
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'no-reject-click' });
    });

    it("B cut by the deadline: CONSENT-05 no-reject-click is the deadline's doing → error/timeout", () => {
      const snapshot = partial([
        makePhase('A', { pages: [startVisit()] }),
        makePhase('B', { status: 'partial', reason: 'timeout', pages: [startVisit()] }),
        skippedC,
      ]);
      const r = run(consent05, snapshot);
      expect(r).toMatchObject({ status: 'error', reason: 'timeout', outcome: null });
      expect(r.limitations).toEqual(['deadline:no-reject-click']);
    });

    it("phase C cut: the reasons of phase C (phase-c-missing) are the deadline's doing, the others stay", () => {
      // No shipped check reports phase-c-missing today; the mapping is exercised through a probe check.
      const probe = defineCheck({
        id: 'TEST-TIMEOUT',
        module: 'browser',
        requires: ['browser'],
        variants: [{ variant: 'seen' }],
        run: () => ({ status: 'inconclusive', reason: 'phase-c-missing', observations: [] }),
      });
      const cut = run(probe, partial([makePhase('A'), makePhase('B'), cutC]));
      expect(cut).toMatchObject({ status: 'error', reason: 'timeout' });
      const intact = run(probe, partial([makePhase('A'), makePhase('B'), makePhase('C')]));
      expect(intact).toMatchObject({ status: 'inconclusive', reason: 'phase-c-missing' });
    });

    it('a phase the local time budget stopped counts as cut by the deadline', () => {
      const snapshot = partial([
        makePhase('A', { status: 'partial', reason: 'time-budget', pages: [startVisit()] }),
      ]);
      expect(run(consent03, snapshot)).toMatchObject({ status: 'error', reason: 'timeout' });
    });

    it('a failed phase (not the deadline) keeps its inconclusive reason', () => {
      const snapshot = partial([
        makePhase('A', { pages: [startVisit()] }),
        makePhase('B', { status: 'failed', reason: 'dom-unavailable', pages: [startVisit()] }),
      ]);
      expect(run(consent05, snapshot)).toMatchObject({ status: 'inconclusive' });
    });
  });

  it('counterexample: without a timeout of the browser the same inconclusive result stays', () => {
    const snapshot = partial([makePhase('A', { pages: [startVisit()] })], null);
    expect(run(consent05, snapshot)).toMatchObject({ status: 'inconclusive', reason: 'phase-b-missing' });
    expect(run(consent03, snapshot)).toMatchObject({ status: 'inconclusive', reason: 'insufficient-pages' });
  });

  it('counterexample: a timeout of another collector does not turn a browser check into an error', () => {
    const snapshot = withDerived(
      makeSnapshot({
        browser: makeBrowser({ phases: [makePhase('A', { pages: [startVisit()] })] }),
        cmp: makeCmp(),
        collection: {
          browser: { status: 'ok', durationMs: 1 },
          http: { status: 'error', reason: 'timeout', durationMs: 1 },
        },
      }),
    );
    expect(run(consent05, snapshot)).toMatchObject({ status: 'inconclusive', reason: 'phase-b-missing' });
  });
});

const dnsProbe = defineCheck({
  id: 'TEST-04',
  module: 'dns',
  requires: ['dns'],
  variants: [{ variant: 'seen' }],
  run: () => [],
});

describe('scan after the deadline cut phase B', () => {
  const dataDir = testDataDir({ ruleset: { 'TEST-04': { seen: 'info' } } });
  /** What the browser collected before the deadline: phase A with the start page. */
  const phaseA = () => ({
    browser: makeBrowser({ phases: [makePhase('A', { pages: [startVisit()] })] }),
    cmp: makeCmp(),
  });
  const dnsOk = async () => ({
    status: 'ok' as const,
    sections: { dns: makeDns({ queries: [makeDnsQuery({ qname: 'www.example.de' })] }) },
  });
  const runAfterDeadline = (over: Partial<ScanOptions> = {}) =>
    scanWith({
      dataDir,
      registry: new CheckRegistry([consent05, consent03, dnsProbe]),
      timeoutMs: 100,
      abortGraceMs: 500,
      collectors: fakeCollectors({ browser: abortAware(phaseA), dns: dnsOk as never }),
      ...over,
    });

  it('CONSENT-05 error/timeout (phase B cut); CONSENT-03 stays inconclusive (phase A ended by itself); SCAN-TIMEOUT names only the first; the other collectors keep their results', async () => {
    const r = await runAfterDeadline();

    expectValidReport(r.report);

    const byId = Object.fromEntries((r.report.checks ?? []).map((c) => [c.id, c]));
    expect(byId['CONSENT-05']).toMatchObject({ status: 'error', reason: 'timeout' });
    // one page in a completed phase A is the site's fact, not the deadline's doing.
    expect(byId['CONSENT-03']).toMatchObject({ status: 'inconclusive', reason: 'insufficient-pages' });

    const diag = r.report.diagnostics?.find((d) => d.code === 'SCAN-TIMEOUT');
    expect(diag?.affects).toEqual(['CONSENT-05']);
    expect(diag?.params).toMatchObject({ count: 1 });
    expect(r.snapshot?.dns?.queries).toHaveLength(1);

    expect(r.report.scan.status).toBe('partial');
    // The gate counts the unfinished relevant checks: exit 2 with the timeout among the reasons.
    expect(r.report.summary.exitReasons).toEqual(expect.arrayContaining(['timeout']));
    // No finding reached the threshold, and still not exit 0: the relevant checks did not finish.
    expect(r.report.findings ?? []).toEqual([]);
    expect(r.exitCode).toBe(2);
  });

  it('fail-on none: the diagnostic stays, the exit code is 0', async () => {
    const r = await runAfterDeadline({ failOn: 'none' });

    expect(r.exitCode).toBe(0);
    expect(r.report.diagnostics?.map((d) => d.code)).toContain('SCAN-TIMEOUT');
  });
});

describe('texts of SCAN-TIMEOUT', () => {
  it.each(['de', 'en'] as const)(
    '%s: no claim about errors without unfinished checks, a count with them',
    (lang) => {
      const texts = loadTexts(lang);
      const none = renderMessage(texts, 'diagnostic.SCAN-TIMEOUT', { count: 0 });
      const two = renderMessage(texts, 'diagnostic.SCAN-TIMEOUT', { count: 2 });
      const one = renderMessage(texts, 'diagnostic.SCAN-TIMEOUT', { count: 1 });

      expect(none.body).not.toMatch(/Fehler|errors|markiert|marked|\d/);
      expect(two.body).toContain('2');
      expect(one.body).not.toContain('{');
      expect(two.body).not.toContain('{');

      // The observations that were collected stay in the report.
      expect(none.body).toMatch(lang === 'de' ? /bleiben im Bericht/ : /remain in the report/);
    },
  );
});

/** A browser collector that hands over an empty partial result as soon as the global deadline aborts it. */
const emptyPartialOnAbort: Collectors['browser'] = (ctx) =>
  new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve({ status: 'partial', sections: {} } as never), {
      once: true,
    });
  });

describe('no hand-over after the global timeout', () => {
  const modes: Array<{
    browser: Collectors['browser'];
    code: string;
    warns: boolean;
  }> = [
    { browser: () => new Promise(() => {}), code: 'browser-no-handover', warns: true },
    { browser: emptyPartialOnAbort, code: 'scan-timeout', warns: false },
  ];
  const cases = modes.flatMap((mode) => (['de', 'en'] as const).map((lang) => ({ ...mode, lang })));

  it.each(cases)(
    '$code produces a localized failed report ($lang)',
    async ({ lang, browser, code, warns }) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        const lines: string[] = [];
        const pending = scanWith({
          lang,
          registry: new CheckRegistry([consent05]),
          log: createLogger('warn', (line) => lines.push(line)),
          timeoutMs: 1_200,
          abortGraceMs: 30,
          collectors: fakeCollectors({ browser }),
        });
        await vi.advanceTimersByTimeAsync(1_230);
        const { report } = await pending;
        expectValidReport(report);
        expect(report.summary.exitReasons).toContain('timeout');
        if (report.scan.status !== 'failed') throw new Error('expected a failed report');

        const { failure } = report.scan;
        expect(failure.code).toBe(code);
        expect(failure.message).toBe(uiText(loadTexts(lang), `failure.${code}`, { seconds: 1 }));
        expect(failure.message).toContain('1 s');
        expect(failure.message).toMatch(lang === 'de' ? /^Globales Zeitlimit/ : /^Global time limit/);
        if (warns) expect(failure.message).not.toMatch(/bevor die Startseite|before the start page/);
        expect(lines.some((line) => /warn.*browser.*handed over no result/.test(line))).toBe(warns);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('both languages have both texts and neither leaves a placeholder open', () => {
    for (const lang of ['de', 'en'] as const) {
      const texts = loadTexts(lang);
      for (const key of ['failure.scan-timeout', 'failure.browser-no-handover']) {
        const rendered = uiText(texts, key, { seconds: 7 });

        expect(texts.ui[key], `${lang} ${key}`).toBeDefined();
        expect(rendered).not.toMatch(/[{}]/);
        expect(rendered).toContain('7');
      }
    }
  });
});

describe('SCAN-BLOCKED names the page', () => {
  it.each(['de', 'en'] as const)('%s: {page} for one page, a count and the list for several', (lang) => {
    const texts = loadTexts(lang);
    const one = renderMessage(texts, 'diagnostic.SCAN-BLOCKED', {
      count: 1,
      page: 'https://www.example.de/impressum',
    });
    expect(one.body).toContain('https://www.example.de/impressum');
    expect(one.body).not.toContain('{');

    const many = renderMessage(texts, 'diagnostic.SCAN-BLOCKED', {
      count: 3,
      page: 'https://www.example.de/a',
      pages: 'https://www.example.de/a, https://www.example.de/b, https://www.example.de/c',
    });

    expect(many.body).toContain('3');
    expect(many.body).toContain('https://www.example.de/b');
    expect(many.body).not.toContain('{');
  });
});

describe('SCAN-PRIVATE-REQUEST-BLOCKED tells an unresolvable name from a private address', () => {
  const render = (lang: 'de' | 'en', params: Record<string, string | number | boolean>) =>
    renderMessage(loadTexts(lang), 'diagnostic.SCAN-PRIVATE-REQUEST-BLOCKED', params).body;

  it('de', () => {
    const unresolved = render('de', {
      count: 2,
      addressClass: 'unresolved',
      unresolved: 2,
      nonPublic: 0,
      hasLookupCodes: true,
      lookupCodes: 'EAI_AGAIN',
    });
    expect(unresolved).toContain('Name nicht auflösbar');
    expect(unresolved).toContain('EAI_AGAIN');
    expect(unresolved).not.toContain('Private Adresse');

    const priv = render('de', {
      count: 1,
      addressClass: 'private',
      unresolved: 0,
      nonPublic: 1,
      hasLookupCodes: false,
    });

    expect(priv).toContain('Private Adresse');
    expect(priv).not.toContain('Name nicht auflösbar');
    expect(priv).not.toContain('{');
  });

  it('en', () => {
    const unresolved = render('en', {
      count: 1,
      addressClass: 'unresolved',
      unresolved: 1,
      nonPublic: 0,
      hasLookupCodes: false,
    });

    expect(unresolved).toContain('Name not resolvable');
    expect(unresolved).not.toContain('Private address');
    expect(unresolved).not.toContain('{');
  });

  // navigations that a retry loaded afterwards are named as such, not as documents that were not fetched.
  it.each([
    ['de', /nach Wiederholung geladen/, /Eine weitere Navigation/, /2 weitere Navigationen/],
    ['en', /loaded after a retry/, /One more navigation/, /2 more navigations/],
  ] as const)('%s: a recovered navigation is stated as loaded after the retry', (lang, loaded, one, many) => {
    const base = {
      count: 1,
      addressClass: 'private',
      unresolved: 0,
      nonPublic: 1,
      hasLookupCodes: false,
    };
    const plain = render(lang, base);
    const withOne = render(lang, { ...base, recovered: 1 });
    const withTwo = render(lang, { ...base, recovered: 2 });

    expect(plain).not.toMatch(loaded);
    expect(render(lang, { ...base, recovered: 0 })).toBe(plain);
    expect(withOne).toMatch(one);
    expect(withOne).toMatch(loaded);
    expect(withTwo).toMatch(many);
    expect(withTwo).not.toMatch(/[{}#]/);
  });
});

describe('Nutzungshinweise', () => {
  it.each(['de', 'en'] as const)('%s: the User-Agent named is the token the scanner sends', (lang) => {
    const text = uiText(loadTexts(lang), 'usageNotes', { version: '1.2.3' }).replace(/\s+/g, ' ');

    expect(text).toContain(uaToken('1.2.3'));
  });

  it('en: the IP address is "disclosed to" the third parties, not "transmitted"', () => {
    const text = uiText(loadTexts('en'), 'usageNotes', { version: '1' });

    expect(text).not.toMatch(/transmits/i);
    expect(text).toMatch(/Phase C discloses the scanning machine's IP address to the third parties/);
  });

  it('de: the Phase C sentence and the README section Nutzungshinweise match the data text', () => {
    const de = uiText(loadTexts('de'), 'usageNotes', { version: '<version>' }).replace(/\s+/g, ' ');
    const phaseC =
      'Phase C übermittelt die IP-Adresse des prüfenden Rechners an die Drittanbieter, deren Ressourcen die Website nach der Annahme im Banner lädt.';
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Nutzungshinweise'), readme.indexOf('## Entwicklung'));
    const flat = section.replace(/`/g, '').replace(/\s+/g, ' ');

    expect(de).toContain(phaseC);
    expect(flat).toContain(phaseC);

    // The README paragraph is the de text of test/data/texts (modulo markdown backticks and typographic quotes).
    const plain = (t: string) => t.replace(/[`„“]/g, '').replace(/\s+/g, ' ');
    expect(plain(section)).toContain(plain(de));
  });
});

describe('trust store of the process', () => {
  it('scan: the snapshot environment records it', async () => {
    const run = async () => {
      const r = await scanWith({ registry: new CheckRegistry([]), collectors: fakeCollectors() });
      return r.snapshot?.environment.trustStore;
    };

    vi.stubEnv('NODE_USE_SYSTEM_CA', '1');
    try {
      expect(await run()).toBe('system');
    } finally {
      vi.unstubAllEnvs();
    }

    vi.stubEnv('NODE_USE_SYSTEM_CA', '');
    try {
      expect(await run()).toBe('node-bundled');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
