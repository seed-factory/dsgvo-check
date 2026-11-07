/** Click selectors omit class tokens containing addresses while retaining the intended button identity. */
import { describe, expect, it } from 'vitest';
import { persisted } from '../helpers.ts';
import { page, useSite } from '../site-dir.ts';

const INDEX = page(`
  <main><h1>Beispiel Kanzlei</h1></main>
  <style>
    html, body { height: 100%; margin: 0; }
    .consent { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #222; color: #fff; padding: 12px 24px; z-index: 50; box-sizing: border-box; }
    .consent button { margin-right: 8px; }
  </style>
  <div class="consent" role="dialog" aria-label="Cookies">
    <p style="margin:0">Diese Seite nutzt Cookies und Tracking von Drittanbietern.</p>
    <button type="button" class="contact-zq7cls@example.test" onclick="window.clicked = 'accept'">Alle akzeptieren</button>
    <button type="button" class="refuse-btn" onclick="window.clicked = 'reject'">Ablehnen</button>
    <button type="button" class="cta zq7mix@example.test" onclick="window.clicked = 'settings'">Einstellungen</button>
  </div>`);

const site = useSite({ 'index.html': INDEX }, { collect: { maxPages: 1 }, browser: true });

const buttons = () =>
  (site.run.result.sections.cmp?.phases.flatMap((p) => p.facts) ?? []).find((f) => f.firstLayer.bannerPresent)
    ?.firstLayer.buttons ?? [];
const byName = (name: string) => buttons().find((b) => b.name === name);

/** The recorded selector of a control, used the way the adapters use it: in a fresh page, exactly one match, a click. */
async function clickBySelector(selector: string): Promise<{ count: number; clicked: unknown }> {
  const p = await site.browser.context.newPage();
  try {
    await p.goto('https://www.example.test/', { waitUntil: 'load' });
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

describe('CMP click selector: a class token with an address', () => {
  it('the scenario is real: the banner is found and the controls are recorded with selectors', () => {
    expect(buttons().map((b) => b.name)).toEqual(
      expect.arrayContaining(['Alle akzeptieren', 'Ablehnen', 'Einstellungen']),
    );
    for (const name of ['Alle akzeptieren', 'Ablehnen', 'Einstellungen'])
      expect(byName(name)?.selector, name).toBeTruthy();
  });

  it('no local part of an address in a class token anywhere in what the collector persists', () => {
    // The excerpts around a marker, not the whole snapshot, so that a failure stays readable.
    expect(persisted(site.run).match(/[^"]{0,40}zq7[^"]{0,40}/g) ?? []).toEqual([]);
  });

  it('the control whose only unique selector would be its address class gets a structural selector that still clicks', async () => {
    const selector = byName('Alle akzeptieren')?.selector ?? '';
    expect(selector).not.toContain('@');
    expect(selector).toContain(':nth-child(');
    expect(await clickBySelector(selector)).toEqual({ count: 1, clicked: 'accept' });
  });

  it('a control with a plain class token next to an address token is still found, without the address', async () => {
    const selector = byName('Einstellungen')?.selector ?? '';
    expect(selector).not.toContain('zq7');
    expect(await clickBySelector(selector)).toEqual({ count: 1, clicked: 'settings' });
  });

  it('counterexample: a unique plain class token is still used for the selector', async () => {
    const selector = byName('Ablehnen')?.selector ?? '';
    expect(selector).toBe('button.refuse-btn');
    expect(await clickBySelector(selector)).toEqual({ count: 1, clicked: 'reject' });
  });

  it('touches only declared hosts', () => {
    expect(site.server.unexpected).toEqual([]);
  });
});
