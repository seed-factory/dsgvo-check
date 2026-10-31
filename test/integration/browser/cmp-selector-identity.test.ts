/**
 * L2 (review R-cmp-1 of S-privacy-1): the click selector that the CMP probe records points at THE control, not only at
 * "one element". A class attribute is split by the whitespace of HTML (space, tab, LF, FF, CR), not by every character
 * that JavaScript `\s` knows: a token such as `nbq9nb<NBSP>@example.test` is ONE class token, it has an address and
 * is dropped as a whole. Before, its first half stayed as a class, matched the class of another control and gave
 * "Zustimmen" the selector of "Ablehnen": a click on the accept control would have pressed reject.
 * Every marker starts with `nbq9`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../utils/browser.ts';
import { type CollectRun, collect, persisted } from './helpers.ts';
import { page, type SiteDir, writeSite } from './site-dir.ts';

const BANNER = (a: string, b: string) => `
  <main><h1>Beispiel Kanzlei</h1></main>
  <style>
    html, body { height: 100%; margin: 0; }
    .consent { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #222; color: #fff; padding: 12px 24px; z-index: 50; box-sizing: border-box; }
    .consent button { margin-right: 8px; }
  </style>
  <div class="consent" role="dialog" aria-label="Cookies">
    <p style="margin:0">Diese Seite nutzt Cookies und Tracking von Drittanbietern.</p>
    ${a}
    ${b}
  </div>`;

/** The first control has a class token with a non-breaking space and an address; the second has the class of its first half. */
const NBSP = BANNER(
  `<button type="button" class="nbq9nb&nbsp;@example.test" onclick="window.clicked = 'accept'">Zustimmen</button>`,
  `<button type="button" class="nbq9nb" onclick="window.clicked = 'reject'">Ablehnen</button>`,
);
/** Counterexample: the same classes, separated by a real space: two tokens, the address one is dropped. */
const SPACE = BANNER(
  `<button type="button" class="nbq9nb nbq9sp@example.test" onclick="window.clicked = 'accept'">Zustimmen</button>`,
  `<button type="button" class="nbq9other" onclick="window.clicked = 'reject'">Ablehnen</button>`,
);

let server: FixtureServer;
let nbsp: SiteDir;
let space: SiteDir;
let browser: TestBrowser;
const runs: Record<string, CollectRun> = {};

beforeAll(async () => {
  nbsp = writeSite({ 'index.html': page(NBSP) });
  space = writeSite({ 'index.html': page(SPACE) });
  server = await startFixtureServer({
    hosts: { 'nbsp.example.test': nbsp.root, 'space.example.test': space.root },
  });
  runs.nbsp = await collect(server, { url: 'https://nbsp.example.test/', maxPages: 1 });
  runs.space = await collect(server, { url: 'https://space.example.test/', maxPages: 1 });
  browser = await launchTestBrowser(server);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  nbsp?.cleanup();
  space?.cleanup();
});

const selectorOf = (run: CollectRun, name: string): string =>
  (run.result.sections.cmp?.phases.flatMap((p) => p.facts) ?? [])
    .find((f) => f.firstLayer.bannerPresent)
    ?.firstLayer.buttons.find((b) => b.name === name)?.selector ?? '';

/** The recorded selector, used as the adapters use it: in a fresh page, exactly one match, a click. */
async function clickBySelector(host: string, selector: string): Promise<{ count: number; clicked: unknown }> {
  const p = await browser.context.newPage();
  try {
    await p.goto(`https://${host}/`, { waitUntil: 'load' });
    const loc = p.locator(selector);
    const count = await loc.count();
    if (count === 1) await loc.click();
    return {
      count,
      clicked: await p.evaluate(() => (globalThis as unknown as { clicked?: string }).clicked),
    };
  } finally {
    await p.close();
  }
}

describe('CMP click selector: it points at the control it was recorded for (R-cmp-1)', () => {
  it('a class token with a non-breaking space and an address is one token and is dropped as a whole', async () => {
    const accept = selectorOf(runs.nbsp as CollectRun, 'Zustimmen');
    const reject = selectorOf(runs.nbsp as CollectRun, 'Ablehnen');
    expect(accept).toBeTruthy();
    expect(accept).not.toBe(reject);
    expect(accept).not.toContain('nbq9');
    expect(await clickBySelector('nbsp.example.test', accept)).toEqual({ count: 1, clicked: 'accept' });
  });

  it('the control with the plain class keeps its short class selector and presses its own button', async () => {
    const reject = selectorOf(runs.nbsp as CollectRun, 'Ablehnen');
    expect(reject).toBe('button.nbq9nb');
    expect(await clickBySelector('nbsp.example.test', reject)).toEqual({ count: 1, clicked: 'reject' });
  });

  it('no local part of the address in what the collector persists', () => {
    expect(persisted(runs.nbsp as CollectRun).match(/[^"]{0,40}nbq9nb[^"]{0,40}@[^"]{0,40}/g) ?? []).toEqual(
      [],
    );
  });

  it('counterexample: a real space makes two tokens, the plain one still builds a selector, the address one never', async () => {
    const accept = selectorOf(runs.space as CollectRun, 'Zustimmen');
    expect(accept).toBe('button.nbq9nb');
    expect(persisted(runs.space as CollectRun)).not.toContain('nbq9sp');
    expect(await clickBySelector('space.example.test', accept)).toEqual({ count: 1, clicked: 'accept' });
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
