/**
 * Orchestrator robustness: the global timeout after a partial browser collection,
 * a browser collector that hands over nothing, texts of the diagnostics SCAN-BLOCKED / SCAN-TIMEOUT /
 * SCAN-PRIVATE-REQUEST-BLOCKED, the Nutzungshinweise wording and the CA setting of the
 * process.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { consent03 } from '../../../src/checks/browser/consent-03.ts';
import { consent05 } from '../../../src/checks/browser/consent-05.ts';
import { defineCheck } from '../../../src/core/check.ts';
import type { CollectorResult, Collectors } from '../../../src/core/collector.ts';
import { loadTexts } from '../../../src/core/data.ts';
import { executeCheck } from '../../../src/core/execute.ts';
import { createLogger } from '../../../src/core/logger.ts';
import { renderMessage, uiText } from '../../../src/core/messages.ts';
import { CheckRegistry } from '../../../src/core/registry.ts';
import { scan } from '../../../src/scan.ts';
import { expectValidReport } from '../../utils/report-validator.ts';
import { fakeCollectors, publicLookup, testDataDir } from '../../utils/scan-harness.ts';
import {
  checkContext,
  FIXED_NOW,
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

  it('phase B missing → CONSENT-05 error/timeout (old: inconclusive phase-b-missing)', () => {
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

    it("B never started (no record): CONSENT-05 phase-b-missing is the deadline's doing → error/timeout", () => {
      const r = run(consent05, partial([makePhase('A', { pages: [startVisit()] })]));
      expect(r).toMatchObject({ status: 'error', reason: 'timeout' });
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
  const partialBrowser = (): CollectorResult<{
    browser: ReturnType<typeof makeBrowser>;
    cmp: ReturnType<typeof makeCmp>;
  }> => ({
    status: 'partial',
    reason: 'timeout',
    sections: {
      browser: makeBrowser({ phases: [makePhase('A', { pages: [startVisit()] })] }),
      cmp: makeCmp(),
    },
  });
  const dnsOk = async () => ({
    status: 'ok' as const,
    sections: { dns: makeDns({ queries: [makeDnsQuery({ qname: 'www.example.de' })] }) },
  });
  const base = (over: Record<string, unknown> = {}) => ({
    url: START,
    dataDir,
    registry: new CheckRegistry([consent05, consent03, dnsProbe]),
    network: { lookup: publicLookup },
    now: () => FIXED_NOW,
    log: createLogger('silent'),
    timeoutMs: 100,
    abortGraceMs: 500,
    collectors: fakeCollectors({
      browser: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => setTimeout(() => resolve(partialBrowser() as never), 5),
            {
              once: true,
            },
          );
        }),
      dns: dnsOk as never,
    }),
    ...over,
  });

  it('CONSENT-05 error/timeout (phase B cut); CONSENT-03 stays inconclusive (phase A ended by itself); SCAN-TIMEOUT names only the first; the other collectors keep their results', async () => {
    const r = await scan(base());
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
    const r = await scan(base({ failOn: 'none' }));
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

describe('no hand-over after the global timeout', () => {
  it('a collector that never returns: its own failure code and a warning, not "before the start page"', async () => {
    const lines: string[] = [];
    const r = await scan({
      url: START,
      dataDir: testDataDir({ ruleset: {} }),
      registry: new CheckRegistry([consent05]),
      network: { lookup: publicLookup },
      now: () => FIXED_NOW,
      log: createLogger('warn', (l) => lines.push(l)),
      timeoutMs: 80,
      abortGraceMs: 30,
      collectors: fakeCollectors({ browser: () => new Promise(() => {}) }),
    });
    expect(r.report.scan.status).toBe('failed');
    if (r.report.scan.status === 'failed') {
      expect(r.report.scan.failure.code).toBe('browser-no-handover');
      expect(r.report.scan.failure.message).not.toMatch(/bevor die Startseite/);
    }
    expect(r.report.summary.exitReasons).toContain('timeout');
    expect(lines.some((l) => /warn/.test(l) && /browser/.test(l) && /handed over no result/.test(l))).toBe(
      true,
    );
    expectValidReport(r.report);
  });

  it('counterexample: a collector that returns an empty result keeps "scan-timeout"', async () => {
    const r = await scan({
      url: START,
      dataDir: testDataDir({ ruleset: {} }),
      registry: new CheckRegistry([consent05]),
      network: { lookup: publicLookup },
      now: () => FIXED_NOW,
      log: createLogger('silent'),
      timeoutMs: 80,
      abortGraceMs: 300,
      collectors: fakeCollectors({
        browser: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              'abort',
              () => resolve({ status: 'partial', sections: {} } as never),
              {
                once: true,
              },
            );
          }),
      }),
    });
    if (r.report.scan.status === 'failed') expect(r.report.scan.failure.code).toBe('scan-timeout');
    else throw new Error('expected a failed report');
  });
});

// the failure texts of the orchestrator are data (data/texts), in the language of the scan.
describe('the failure message of a scan cut by the global timeout is a text of data/texts', () => {
  const failed = async (lang: 'de' | 'en', browser: Collectors['browser']) => {
    const r = await scan({
      url: START,
      lang,
      dataDir: testDataDir({ ruleset: {} }),
      registry: new CheckRegistry([consent05]),
      network: { lookup: publicLookup },
      now: () => FIXED_NOW,
      log: createLogger('silent'),
      timeoutMs: 1_200,
      abortGraceMs: 30,
      collectors: fakeCollectors({ browser }),
    });
    if (r.report.scan.status !== 'failed') throw new Error('expected a failed report');
    return r.report.scan.failure;
  };
  const GERMAN = /Zeitlimit|Startseite|Browser-Kollektor/;

  it.each(['de', 'en'] as const)(
    '%s: browser-no-handover is rendered from the texts with the seconds',
    async (lang) => {
      const f = await failed(lang, () => new Promise(() => {}));
      expect(f.code).toBe('browser-no-handover');
      expect(f.message).toBe(uiText(loadTexts(lang), 'failure.browser-no-handover', { seconds: 1 }));
      expect(f.message).toContain('1 s');
      if (lang === 'en') expect(f.message).not.toMatch(GERMAN);
      else expect(f.message).toMatch(/Globales Zeitlimit/);
    },
  );

  it.each(['de', 'en'] as const)(
    '%s: scan-timeout is rendered from the texts with the seconds',
    async (lang) => {
      const f = await failed(
        lang,
        (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              'abort',
              () => resolve({ status: 'partial', sections: {} } as never),
              {
                once: true,
              },
            );
          }),
      );
      expect(f.code).toBe('scan-timeout');
      expect(f.message).toBe(uiText(loadTexts(lang), 'failure.scan-timeout', { seconds: 1 }));
      if (lang === 'en') expect(f.message).not.toMatch(GERMAN);
    },
  );

  it('both languages have both texts and neither leaves a placeholder open', () => {
    for (const lang of ['de', 'en'] as const) {
      const texts = loadTexts(lang);
      for (const key of ['failure.scan-timeout', 'failure.browser-no-handover']) {
        expect(texts.ui[key], `${lang} ${key}`).toBeDefined();
        expect(uiText(texts, key, { seconds: 7 })).not.toMatch(/[{}]/);
        expect(uiText(texts, key, { seconds: 7 })).toContain('7');
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
    const base = { count: 1, addressClass: 'private', unresolved: 0, nonPublic: 1, hasLookupCodes: false };
    const plain = render(lang, base);
    expect(plain).not.toMatch(loaded);
    expect(render(lang, { ...base, recovered: 0 })).toBe(plain);
    expect(render(lang, { ...base, recovered: 1 })).toMatch(one);
    expect(render(lang, { ...base, recovered: 1 })).toMatch(loaded);
    expect(render(lang, { ...base, recovered: 2 })).toMatch(many);
    expect(render(lang, { ...base, recovered: 2 })).not.toMatch(/[{}#]/);
  });
});

describe('Nutzungshinweise', () => {
  it('en: the IP address is "disclosed to" the third parties, not "transmitted"', () => {
    const text = uiText(loadTexts('en'), 'usageNotes', { version: '1' });
    expect(text).not.toMatch(/transmits/i);
    expect(text).toMatch(/Phase C discloses the scanning machine's IP address to the third parties/);
  });

  it('de: stays the wording of the guide §6 (allowlist by ) — also in the README', () => {
    const de = uiText(loadTexts('de'), 'usageNotes', { version: '<version>' }).replace(/\s+/g, ' ');
    const phaseC =
      'Phase C übermittelt die IP-Adresse des prüfenden Rechners an die Drittanbieter, deren Ressourcen die Website nach der Annahme im Banner lädt.';
    expect(de).toContain(phaseC);
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Nutzungshinweise'), readme.indexOf('## Entwicklung'));
    const flat = section.replace(/`/g, '').replace(/\s+/g, ' ');
    expect(flat).toContain(phaseC);
    // The README paragraph is the de text of data/texts (modulo markdown backticks and typographic quotes).
    const plain = (t: string) => t.replace(/[`„“]/g, '').replace(/\s+/g, ' ');
    expect(plain(section)).toContain(plain(de));
  });
});

describe('trust store of the process', () => {
  it('scan: the snapshot environment records it', async () => {
    const run = async () =>
      (
        await scan({
          url: START,
          dataDir: testDataDir({ ruleset: {} }),
          registry: new CheckRegistry([]),
          network: { lookup: publicLookup },
          now: () => FIXED_NOW,
          log: createLogger('silent'),
          collectors: fakeCollectors(),
        })
      ).snapshot?.environment.trustStore;
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
