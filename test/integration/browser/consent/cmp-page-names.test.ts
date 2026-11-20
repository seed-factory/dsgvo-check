/**
 * The CMP probe builds click selectors and button facts from the page's markup. With the real collector: ids, class
 * tokens and attribute values with a query, a URL, an address or an ID-like run, also behind invisible or look-alike
 * characters and separators, an ancestor id with a query, a role that is no role and a tag that is no tag name reach
 * neither the snapshot nor the click selectors, and every control still gets a selector that clicks it. Markers start
 * with `zq7`; the hex ids and the tokens cut into short parts are markers too.
 */
import { describe, expect, it } from 'vitest';
import { persisted } from '../helpers.ts';
import { page, useSite } from '../site-dir.ts';

const HEX_ID = '9f86d081884c7d659a2feaa0c55ad015';
const HEX_CLASS = '5f4dcc3b5aa765d61d8327deb882cf99';
/** Base64-like tokens cut by `-` and `_` into short parts; markers too. */
const SPLIT_ID = 'x9Kq-Lm3P-zR7t-Wb2N-vC5s-Df8G-hJ1k-Qa4E';
const SPLIT_TESTID = 'Kd8sLq-Mz3pRt-Wx7vNb-Qa2cEf';
const SPLIT_CLASS = 'Token_aB3d_9Kx2_mQ7z_P4wR_t8Yn';

const click = (what: string) => `onclick="window.clicked = '${what}'; return false;"`;

const INDEX = page(`
  <main><h1>Beispiel Kanzlei</h1></main>
  <style>
    html, body { height: 100%; margin: 0; }
    .consent { position: fixed; left: 0; right: 0; bottom: 0; height: 180px; background: #222; color: #fff; padding: 12px 24px; z-index: 50; box-sizing: border-box; }
    .consent button, .consent a, .consent x-a { margin-right: 8px; color: #fff; display: inline-block; }
  </style>
  <div class="consent" role="dialog" aria-label="Cookies">
    <p style="margin:0">Diese Seite nutzt Cookies und Tracking von Drittanbietern.</p>
    <div id="wrap?sid=zq7anc&amp;x=1">
      <button type="button" aria-label="Alle akzeptieren https://x.test/?sid=zq7lbl" ${click('accept')}>Alle akzeptieren</button>
      <button type="button" name="https://x.test/?uid=zq7name" ${click('reject')}>Ablehnen</button>
      <button type="button" id="cid-${HEX_ID}" ${click('settings')}>Einstellungen</button>
      <button type="button" class="btn uid-${HEX_CLASS}" ${click('save')}>Auswahl speichern</button>
      <button type="button" class="?token=zq7cls" ${click('more')}>Mehr erfahren</button>
      <button type="button" role="?cid=zq7role" data-testid="later?sid=zq7tid" ${click('later')}>Später</button>
      <x-a?token=zq7tok role="button" tabindex="0" ${click('custom')}>Optionen</x-a?token=zq7tok>
    </div>
    <div>
      <button type="button" class="refuse-btn" ${click('necessary')}>Nur notwendige</button>
      <button type="button" data-testid="uc-more-button" ${click('details')}>Details</button>
      <button type="button" aria-label="Schließen" ${click('close')}>×</button>
      <a href="#" data-cookie-refuse ${click('refuse')}>Weiter ohne Zustimmung</a>
    </div>
    <div>
      <button type="button" class="zq7-9f86d081884c7d6\u200b59a2feaa0c55ad0" ${click('partner')}>Partner</button>
      <button type="button" id="zq7\u202egnp.exe" ${click('statistics')}>Statistik</button>
      <button type="button" data-testid="max.mustermann\uff20zq7mail.test" ${click('comfort')}>Komfort</button>
      <button type="button" name="erika.zq7(at)example.test" ${click('media')}>Medien</button>
      <button type="button" data-role="zq7-ip-203.0.113.42" ${click('language')}>Sprache</button>
      <button type="button" class="zq7-\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18" ${click('region')}>Region</button>
      <button type="button" data-action-type="zq7-\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668" ${click('contact')}>Kontakt</button>
      <button type="button" id="CybotCookiebotBannerCloseButtonE2E" ${click('vendor')}>Anbieter</button>
    </div>
    <div>
      <button type="button" id="${SPLIT_ID}" ${click('session')}>Sitzung</button>
      <button type="button" data-testid="${SPLIT_TESTID}" ${click('profile')}>Profil</button>
      <button type="button" class="${SPLIT_CLASS}" ${click('device')}>Gerät</button>
      <button type="button" class="ch2-open-settings-btn" ${click('vendor-settings')}>Dienste</button>
    </div>
  </div>`);

const site = useSite({ 'index.html': INDEX }, { collect: { maxPages: 1 }, browser: true });

const buttons = () =>
  (site.run.result.sections.cmp?.phases.flatMap((p) => p.facts) ?? []).find((f) => f.firstLayer.bannerPresent)
    ?.firstLayer.buttons ?? [];
const byName = (name: string) => buttons().find((b) => b.name.startsWith(name));

/** The recorded selector, used as the adapters use it: in a fresh page, exactly one match, a click. */
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

const CONTROLS: Array<[name: string, clicked: string]> = [
  ['Alle akzeptieren', 'accept'],
  ['Ablehnen', 'reject'],
  ['Einstellungen', 'settings'],
  ['Auswahl speichern', 'save'],
  ['Mehr erfahren', 'more'],
  ['Später', 'later'],
  ['Optionen', 'custom'],
  ['Nur notwendige', 'necessary'],
  ['Details', 'details'],
  ['Schließen', 'close'],
  ['Weiter ohne Zustimmung', 'refuse'],
  ['Partner', 'partner'],
  ['Statistik', 'statistics'],
  ['Komfort', 'comfort'],
  ['Medien', 'media'],
  ['Sprache', 'language'],
  ['Region', 'region'],
  ['Kontakt', 'contact'],
  ['Anbieter', 'vendor'],
  ['Sitzung', 'session'],
  ['Profil', 'profile'],
  ['Gerät', 'device'],
  ['Dienste', 'vendor-settings'],
];

describe('CMP probe: names from the page in the snapshot and the click selectors', () => {
  it('the scenario is real: the banner is found and every control is recorded with a selector', () => {
    for (const [name] of CONTROLS) expect(byName(name)?.selector, name).toBeTruthy();
  });

  it('no marker anywhere in what the collector persists', () => {
    const text = persisted(site.run);
    expect(text.match(/[^"]{0,40}zq7[^"]{0,40}/g) ?? []).toEqual([]);
    expect(text).not.toContain(HEX_ID);
    expect(text).not.toContain(HEX_CLASS);
    for (const token of [SPLIT_ID, SPLIT_TESTID, SPLIT_CLASS]) expect(text).not.toContain(token);
  });

  it('a role that is no role is the implicit role, a tag that is no tag name is `unknown`', () => {
    expect(byName('Später')).toMatchObject({ role: 'button', tag: 'button' });
    expect(byName('Optionen')).toMatchObject({ role: 'button', tag: 'unknown' });
  });

  it.each(CONTROLS)('the selector of "%s" clicks that control', async (name, clicked) => {
    expect(await clickBySelector(byName(name)?.selector ?? '')).toEqual({ count: 1, clicked });
  });

  it('a structural path does not start at an ancestor id that is no name, and an element without a tag name is `*`', () => {
    expect(byName('Alle akzeptieren')?.selector).toMatch(/^html:nth-child\(1\) > /);
    expect(byName('Optionen')?.selector).toMatch(/ > \*:nth-child\(7\)$/);
  });

  it.each([
    ['a plain class token next to an ID-like one', 'Auswahl speichern', 'button.btn'],
    ['a plain class', 'Nur notwendige', 'button.refuse-btn'],
    ['a vendor test hook', 'Details', 'button[data-testid="uc-more-button"]'],
    ['a one-word label', 'Schließen', 'button[aria-label="Schließen"]'],
    ['a presence attribute', 'Weiter ohne Zustimmung', 'a[data-cookie-refuse=""]'],
    ['a vendor id of CamelCase words with a short suffix', 'Anbieter', '#CybotCookiebotBannerCloseButtonE2E'],
    ['a vendor class with a short group first', 'Dienste', 'button.ch2-open-settings-btn'],
  ])('counterexample: %s still builds the selector', (_case, name, selector) => {
    expect(byName(name)?.selector).toBe(selector);
  });

  it('a value that is no name behind invisible or look-alike characters or separators gives a structural path', () => {
    for (const name of [
      'Partner',
      'Statistik',
      'Komfort',
      'Medien',
      'Sprache',
      'Region',
      'Kontakt',
      'Sitzung',
      'Profil',
      'Gerät',
    ])
      expect(byName(name)?.selector, name).toMatch(/ > button:nth-child\(\d\)$/);
  });

  it('touches only declared hosts', () => {
    expect(site.server.unexpected).toEqual([]);
  });
});
