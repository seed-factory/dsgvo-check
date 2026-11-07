/**
 * A CMP that keeps its dialog closed for browsers its own crawler test takes for bots (CCM19's `isBotBrowser`): the
 * test is vendor data, matched against the page's User-Agent only for a dialog the CMP did not open, and gives a bot
 * signal that names it. The User-Agent itself never reaches the facts. The scanner's own User-Agent is no crawler for
 * these tests, except for one that takes every link for a bot.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adaptersSection, type DialogBotUserAgent } from '../../../src/cmp/adapters-data.ts';
import {
  dialogBotSignal,
  matchesBotUserAgent,
  withDialogBotSignal,
} from '../../../src/cmp/bot-user-agent.ts';
import { adapters } from '../../../src/cmp/index.ts';
import { BOT_USER_AGENT_SIGNAL, type CmpFacts, KNOWN_CMP_IDS } from '../../../src/cmp/types.ts';
import { DEFAULT_DATA_DIR, loadDataDir } from '../../../src/core/data/load.ts';
import { browserUserAgent } from '../../../src/core/runtime/user-agent.ts';
import { makeCmpFacts } from '../../utils/snapshot-builder.ts';

const data = adaptersSection.parse(loadDataDir('cmp'));
const ccm19 = data.ccm19.dialogBotUserAgent as DialogBotUserAgent;

/** A normal desktop Chrome, as a visitor's browser sends it. */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
/** The scanner's own browser User-Agent: the Chrome UA plus the honest token with the repository link. */
const SCANNER_UA = browserUserAgent(CHROME_UA);
/** A token in the form search engine crawlers use: the link right after the bracket, with `+`. */
const CRAWLER_FORM_UA = `${CHROME_UA} site-audit/1.0 (+https://example.test/about)`;
/** Chrome User-Agents as `browser.version()` gives them on the platforms the scanner runs on. */
const RAW_CHROME_UAS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  CHROME_UA,
];

/** `isBotBrowser` of the vendor script app.js of CCM19, verbatim. */
const VENDOR_SOURCE = String.raw`(bot\b|BOT\b|Bot\b|BingPreview| \(\+http)|[a-z]-Google\b`;

const closedDialog = (
  p: Partial<CmpFacts['firstLayer']> = {},
  detection: Partial<CmpFacts['detection']> = {},
) =>
  makeCmpFacts({
    detection: {
      cmpId: 'ccm19',
      method: 'adapter',
      version: null,
      versionSupported: null,
      recognitionConfidence: 'high',
      signals: ['global:CCM', 'dom:#ccm-widget'],
      ...detection,
    },
    firstLayer: {
      bannerPresent: true,
      bannerVisible: false,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
      dialogNotOpened: true,
      ...p,
    },
  });

describe('the crawler test of a CMP in the adapter data', () => {
  it('only CCM19 has one, copied verbatim from the vendor script and case-sensitive like it', () => {
    expect(KNOWN_CMP_IDS.filter((id) => data[id].dialogBotUserAgent !== undefined)).toEqual(['ccm19']);
    expect(ccm19).toMatchObject({ pattern: VENDOR_SOURCE, flags: '' });
    expect(ccm19.label).toMatch(/isBotBrowser/);
    expect(adapters.find((a) => a.id === 'ccm19')?.dialogBotUserAgent).toEqual(ccm19);
    expect(adapters.filter((a) => a.dialogBotUserAgent !== undefined).map((a) => a.id)).toEqual(['ccm19']);
  });

  it('the CCM19 simulator keeps its widget closed by the same pattern', () => {
    const app = readFileSync(
      path.join(DEFAULT_DATA_DIR, '../fixture-server/sites/cmp/ccm19/ccm/app.js'),
      'utf8',
    );
    const literal = /isBotBrowser\(\)\s*\{\s*return\s*\/(.+)\/([a-z]*)\.test\(navigator\.userAgent\)/.exec(
      app,
    );

    expect(literal?.slice(1)).toEqual([ccm19.pattern, ccm19.flags]);
  });
});

describe("the scanner's own User-Agent against every crawler test of the adapter data", () => {
  /** Whether the scanner's User-Agent matches; a crawler test added to the data has to be listed here. */
  const SCANNER_MATCHES: Record<string, boolean> = {
    'borlabs:botUserAgent': false,
    'ccm19:dialogBotUserAgent': false,
    // Takes every "http" and "check" for a bot: a User-Agent with the tool's name and link cannot avoid it.
    'real-cookie-banner:botUserAgent': true,
  };
  // The Borlabs and Real Cookie Banner readers apply `botUserAgent` case-insensitively, as their vendors do.
  const crawlerTests = KNOWN_CMP_IDS.flatMap((id) => [
    ...(data[id].botUserAgent
      ? [[`${id}:botUserAgent`, new RegExp(data[id].botUserAgent, 'i')] as const]
      : []),
    ...(data[id].dialogBotUserAgent
      ? [
          [
            `${id}:dialogBotUserAgent`,
            new RegExp(data[id].dialogBotUserAgent.pattern, data[id].dialogBotUserAgent.flags),
          ] as const,
        ]
      : []),
  ]);

  it('every crawler test of the data is listed', () => {
    expect(crawlerTests.map(([key]) => key).sort()).toEqual(Object.keys(SCANNER_MATCHES).sort());
  });

  it.each(crawlerTests)('%s', (key, test) => {
    for (const raw of RAW_CHROME_UAS) {
      expect({ raw, matches: test.test(browserUserAgent(raw)) }).toEqual({
        raw,
        matches: SCANNER_MATCHES[key],
      });
    }
  });
});

describe('a User-Agent against the crawler test', () => {
  it.each([
    ['the scanner, with its honest token and repository link', SCANNER_UA, false],
    ['the scanner of another release', browserUserAgent(CHROME_UA, '9.9.9'), false],
    ['a token in the crawler form, the link right after the bracket with "+"', CRAWLER_FORM_UA, true],
    ['a plain desktop Chrome', CHROME_UA, false],
    ['a headless Chrome without the token', CHROME_UA.replace('Chrome/', 'HeadlessChrome/'), false],
    [
      'a search engine crawler',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      true,
    ],
    ['a link preview', 'Mozilla/5.0 (Windows NT 10.0) BingPreview/1.0b', true],
    ['a Google fetcher', 'Mozilla/5.0 (compatible) Feedfetcher-Google', true],
    // Case-sensitive like the vendor: an upper-case letter before "-Google" is no crawler there.
    ['a token the case-sensitive pattern does not cover', 'Mozilla/5.0 X-Google', false],
  ])('%s → %s', (_name, userAgent, matches) => {
    expect(matchesBotUserAgent(ccm19, userAgent)).toBe(matches);
  });

  it('the flags of the data are the ones applied', () => {
    expect(matchesBotUserAgent({ ...ccm19, flags: 'i' }, 'Mozilla/5.0 X-Google')).toBe(true);
  });

  it('without a test, or without a User-Agent, nothing matches', () => {
    expect(matchesBotUserAgent(undefined, CRAWLER_FORM_UA)).toBe(false);
    expect(matchesBotUserAgent(ccm19, null)).toBe(false);
    expect(matchesBotUserAgent(ccm19, '')).toBe(false);
  });
});

describe('the bot signal of a dialog the CMP did not open', () => {
  const signal = { cmpId: 'ccm19', signal: BOT_USER_AGENT_SIGNAL, detail: ccm19.label };

  it.each([
    ['closed dialog, a crawler User-Agent', closedDialog(), ccm19, CRAWLER_FORM_UA, signal],
    ['counterexample: closed dialog, a plain Chrome', closedDialog(), ccm19, CHROME_UA, null],
    ['counterexample: closed dialog, the scanner User-Agent', closedDialog(), ccm19, SCANNER_UA, null],
    [
      'counterexample: closed dialog, an adapter without a crawler test',
      closedDialog(),
      undefined,
      CRAWLER_FORM_UA,
      null,
    ],
    [
      'clean: the dialog opened for a crawler User-Agent',
      closedDialog({ bannerVisible: true, dialogNotOpened: undefined }),
      ccm19,
      CRAWLER_FORM_UA,
      null,
    ],
    ['closed dialog, the User-Agent could not be read', closedDialog(), ccm19, null, null],
    [
      'closed dialog of a CMP only the heuristic found',
      closedDialog({}, { method: 'heuristic', cmpId: null }),
      ccm19,
      CRAWLER_FORM_UA,
      null,
    ],
  ] as const)('%s', (_case, facts, rule, userAgent, expected) => {
    expect(dialogBotSignal('ccm19', rule, facts, userAgent)).toEqual(expected);
  });
});

describe('the facts of a CMP after its first screen', () => {
  const page = (userAgent: string | Error) => {
    const evaluate = vi.fn(async () => {
      if (userAgent instanceof Error) throw userAgent;
      return userAgent;
    });
    return { page: { evaluate } as never, evaluate };
  };

  it('a closed dialog and a matching page User-Agent: the bot signal is added, the User-Agent is not stored', async () => {
    const { page: p, evaluate } = page(CRAWLER_FORM_UA);
    const out = await withDialogBotSignal(p, { id: 'ccm19', dialogBotUserAgent: ccm19 }, closedDialog());

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(out.botSignals).toEqual([{ cmpId: 'ccm19', signal: BOT_USER_AGENT_SIGNAL, detail: ccm19.label }]);
    expect(JSON.stringify(out)).not.toContain('site-audit/');
  });

  it.each([
    ['an adapter without a crawler test', undefined, closedDialog()],
    ['a dialog the CMP opened', ccm19, closedDialog({ bannerVisible: true, dialogNotOpened: undefined })],
  ])('%s: the page User-Agent is not even read', async (_case, rule, facts) => {
    const { page: p, evaluate } = page(CRAWLER_FORM_UA);
    const out = await withDialogBotSignal(p, { id: 'ccm19', dialogBotUserAgent: rule }, facts);

    expect(evaluate).not.toHaveBeenCalled();
    expect(out).toBe(facts);
  });

  it.each([
    ['a plain Chrome', CHROME_UA],
    ['the scanner', SCANNER_UA],
    ['a page that cannot be read', new Error('Execution context was destroyed')],
  ])('counterexample: %s keeps the facts as they are', async (_case, userAgent) => {
    const facts = closedDialog();
    const out = await withDialogBotSignal(
      page(userAgent).page,
      { id: 'ccm19', dialogBotUserAgent: ccm19 },
      facts,
    );

    expect(out).toEqual(facts);
    expect(out.botSignals).toEqual([]);
  });
});
