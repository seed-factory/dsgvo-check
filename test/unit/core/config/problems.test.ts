/** The reasons a setting is refused are ids and parameters; the wording lives in test/data/texts. */
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  describeProblems,
  formatProblem,
  parseConfigInput,
  resolveConfig,
} from '../../../../src/core/config/load.ts';
import { type ProblemReason, REASON_IDS, reasonOf } from '../../../../src/core/config/problems.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { templateParams } from '../../../../src/core/data/messages.ts';

const LANGS = ['de', 'en'] as const;

/** One refusal for every id a problem can carry. */
const CASES: ReadonlyArray<[string, () => unknown]> = [
  ['integer', () => resolveConfig({ env: { DSGVO_CHECK_SCAN_MAX_PAGES: 'x' } })],
  ['number', () => resolveConfig({ env: { DSGVO_CHECK_TLS_EXPIRING_LIFETIME_SHARE: 'x' } })],
  ['min', () => parseConfigInput({ scan: { maxPages: 0 } })],
  ['above', () => parseConfigInput({ cmp: { blockingCoveredRatio: 0 } })],
  ['max', () => parseConfigInput({ scan: { maxPages: 51 } })],
  ['floor', () => parseConfigInput({ http: { minIntervalMs: 100 } })],
  ['items-min', () => parseConfigInput({ report: { formats: [] } })],
  ['length-min', () => parseConfigInput({ report: { outDir: '' } })],
  ['option', () => parseConfigInput({ scan: { failOn: 'error' } })],
  ['type', () => parseConfigInput({ scan: { maxPages: 'x' } })],
  ['unknown-keys', () => parseConfigInput({ browser: { unknown: 1 } })],
  ['proxy-scheme', () => parseConfigInput({ scan: { proxy: 'socks5://p' } })],
  ['dns-server', () => parseConfigInput({ dns: { servers: ['a b'] } })],
  ['dkim-selector', () => parseConfigInput({ dns: { dkimSelectors: ['example.de/'] } })],
  ['dwell-order', () => parseConfigInput({ browser: { phaseAMinDwellMs: 30_000 } })],
  ['tls-days-order', () => parseConfigInput({ tls: { expiringDays: 31 } })],
  ['tls-share-order', () => parseConfigInput({ tls: { expiringLifetimeShare: 0.6 } })],
  ['report-reserve', () => parseConfigInput({ scan: { reportWriteReserveMs: 1 } })],
  ['unreadable', () => refuse({ id: 'unreadable', params: { code: 'EISDIR' } })],
  // The fallback for an issue that no text is written for.
  [
    'invalid',
    () => refuse(reasonOf({ code: 'not_multiple_of', divisor: 2, input: 3, path: [], message: 'x' })),
  ],
];

function refuse(reason: ProblemReason): never {
  throw new ConfigError([{ variable: 'SOME_SETTING', value: null, source: 'config', reason }]);
}

function problemsOf(run: () => unknown) {
  try {
    run();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected the settings to be refused');
}

/** The parameter names that each reason id carries across all the cases. */
function carriedParams(): Map<string, Set<string>> {
  const carried = new Map<string, Set<string>>();
  for (const [, run] of CASES) {
    for (const p of problemsOf(run)) {
      const keys = carried.get(p.reason.id) ?? new Set<string>();
      for (const k of Object.keys(p.reason.params)) keys.add(k);
      carried.set(p.reason.id, keys);
    }
  }
  return carried;
}

describe('texts of the reasons', () => {
  it.each(LANGS)('%s has a text for every id, using only parameters the reason carries', (lang) => {
    const texts = loadTexts(lang);
    const carried = carriedParams();

    for (const id of REASON_IDS) {
      const text = texts.ui[`config.problem.${id}`]?.text;
      expect(text, `${lang} config.problem.${id}`).toBeDefined();
      for (const name of templateParams(text as string)) {
        expect(carried.get(id)?.has(name), `${lang} config.problem.${id}: {${name}}`).toBe(true);
      }
    }

    for (const source of ['environment', 'config', 'default']) {
      expect(texts.ui[`config.source.${source}`], `${lang} ${source}`).toBeDefined();
    }
  });

  it('every id is reached by one of the cases', () => {
    const reached = new Set(CASES.flatMap(([, run]) => problemsOf(run).map((p) => p.reason.id)));

    expect([...reached].sort()).toEqual([...REASON_IDS].sort());
  });

  it.each(LANGS)('%s renders every reason without a placeholder or a missing key', (lang) => {
    const texts = loadTexts(lang);
    for (const [, run] of CASES) {
      for (const p of problemsOf(run)) {
        const line = formatProblem(p, texts);
        expect(line, line).not.toMatch(/\{\w|config\.(problem|source)\./);
      }
    }
  });
});

describe('formatProblem', () => {
  const [floor] = problemsOf(() =>
    resolveConfig({ env: { DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS: '1000' } }),
  );

  it('words a problem in the language asked for: variable, value, source and reason', () => {
    expect(formatProblem(floor as never, loadTexts('en'))).toBe(
      'DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS=1000 (environment): must be at least 1500: values may only be made stricter, the scan stays passive',
    );
    expect(formatProblem(floor as never, loadTexts('de'))).toBe(
      'DSGVO_CHECK_BROWSER_NAVIGATION_PAUSE_MS=1000 (Umgebung): muss mindestens 1500 sein: nur strengere Werte sind erlaubt, der Scan bleibt passiv',
    );
  });

  it('shows the path of a .env file as the source and leaves out the value of a secret', () => {
    const problems = problemsOf(() =>
      resolveConfig({
        env: {},
        file: { path: '/work/.env', values: { DSGVO_CHECK_PROXY: 'https://u:secret@p.example' } },
      }),
    );
    const line = formatProblem(problems[0] as never, loadTexts('en'));
    expect(line).toBe('DSGVO_CHECK_PROXY (/work/.env): only http:// proxies (HTTP CONNECT) are supported');
  });

  it('describeProblems joins them with semicolons, in the language of the scan', () => {
    const problems = problemsOf(() =>
      resolveConfig({ env: { DSGVO_CHECK_SCAN_MAX_PAGES: 'x', DSGVO_CHECK_HTTP_MIN_INTERVAL_MS: '1' } }),
    );
    expect(describeProblems(problems, 'en')).toBe(
      'DSGVO_CHECK_SCAN_MAX_PAGES=x (environment): expected an integer; DSGVO_CHECK_HTTP_MIN_INTERVAL_MS=1 (environment): must be at least 500: values may only be made stricter, the scan stays passive',
    );
    expect(describeProblems(problems, 'de')).toContain('(Umgebung): erwartet eine ganze Zahl;');
  });

  it('falls back to the variable names when the texts cannot be loaded', () => {
    const problems = problemsOf(() => resolveConfig({ env: { DSGVO_CHECK_SCAN_MAX_PAGES: 'x' } }));
    expect(describeProblems(problems, 'en', '/nonexistent-data-dir')).toBe('DSGVO_CHECK_SCAN_MAX_PAGES');
  });
});
