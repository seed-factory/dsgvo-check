/**
 * The Wix selectors of test/data/cmp/adapters.yaml and the own Wix simulator against markup captured from the vendor's
 * banner with its settings layer open (test/fixtures/cmp/wix/settings-layer.html). The elements a selector means are
 * found there by role and label, not by the hook, so a hook that only the simulator renders fails here; the scanner's
 * own path from the first layer to the save control runs on the captured markup; and the simulator must render the
 * layer with the same hooks, roles, labels and switch states, so its tests stand for the vendor's banner.
 */
import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { adapterData } from '../../../../src/cmp/adapters-file.ts';
import {
  adapters,
  chooseSettingsOpener,
  chooseSettingsSave,
  loadLexicon,
  waitForBanner,
} from '../../../../src/cmp/index.ts';
import type { ClickTarget, CmpAdapter, CmpButton } from '../../../../src/cmp/types.ts';
import { DEFAULT_CLASSIFY } from '../../../utils/classify.ts';
import { CMP_WAIT_MS, recognized, useCmpServer } from '../helpers.ts';

const CAPTURED_URL = 'https://www.wix.test/captured-settings-layer.html';
const CAPTURED = readFileSync(
  new URL('../../../fixtures/cmp/wix/settings-layer.html', import.meta.url),
  'utf8',
);

/** The first-layer reject control: real, but the captured site's first layer has none. */
const DECLINE_HOOK = 'consent-banner-decline-all-button';

const data = adapterData('wix');
const layerData = data.settingsLayer!;
const wix = adapters.find((a) => a.id === 'wix') as CmpAdapter;

const asTarget = (b: CmpButton): ClickTarget => ({
  name: b.name,
  role: b.role,
  ...(b.selector ? { selector: b.selector } : {}),
  kindConfidence: b.kindConfidence,
  kind: b.kind,
});

/** Positions in document order of the elements a locator finds. */
const positions = (locator: Locator): Promise<number[]> =>
  locator.evaluateAll((els) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> } })
      .document;
    const all = Array.from(doc.querySelectorAll('*'));
    return els.map((e) => all.indexOf(e));
  });

/** Every data-hook value a selector of the Wix data names. */
function hooksOfData(): string[] {
  const selectors = [
    ...data.detect.dom,
    ...data.banner.containers,
    ...data.banner.vendorRoles.map((v) => v.selector),
    ...layerData.containers,
    layerData.groups,
    ...layerData.vendorRoles.map((v) => v.selector),
  ];
  const hooks = selectors.flatMap((s) => [...s.matchAll(/data-hook="([^"]+)"/g)].map((m) => m[1]!));
  return [...new Set(hooks)];
}

/**
 * The element and its descendants that carry a hook or a role or are a control or a heading, one line each, indented
 * by nesting: tag, hook, role, the label of a button, the text of a heading, type and state of an input, and whether it
 * shows (an element without size, fully transparent or invisible does not).
 */
const outline = (root: Locator): Promise<string[]> =>
  root.evaluate((top) => {
    interface El {
      tagName: string;
      children: ArrayLike<El>;
      textContent: string | null;
      type?: string;
      checked?: boolean;
      disabled?: boolean;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { width: number; height: number };
    }
    const w = globalThis as unknown as {
      getComputedStyle(e: El): { opacity: string; visibility: string; display: string };
    };
    const shows = (e: El): boolean => {
      const r = e.getBoundingClientRect();
      const s = w.getComputedStyle(e);
      return r.width >= 1 && r.height >= 1 && Number(s.opacity) > 0 && s.visibility === 'visible';
    };
    const lines: string[] = [];
    const walk = (e: El, depth: number): void => {
      const tag = e.tagName.toLowerCase();
      const hook = e.getAttribute('data-hook');
      const role = e.getAttribute('role');
      let inner = depth;
      const heading = /^h[1-6]$/.test(tag);
      if (hook || role || heading || tag === 'button' || tag === 'input') {
        const parts = [tag];
        if (hook) parts.push(`hook=${hook}`);
        if (role) parts.push(`role=${role}`);
        if (tag === 'button') parts.push(`label=${e.getAttribute('aria-label') ?? e.textContent?.trim()}`);
        if (heading) parts.push(`text=${e.textContent?.trim()}`);
        if (tag === 'input') parts.push(`type=${e.type}`, `checked=${e.checked}`, `disabled=${e.disabled}`);
        parts.push(shows(e) ? 'shown' : 'not-shown');
        lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
        inner = depth + 1;
      }
      for (const c of Array.from(e.children)) walk(c, inner);
    };
    walk(top as unknown as El, 0);
    return lines;
  });

/** Count, role and label of what each first-layer vendor selector finds. */
const firstLayerControls = (page: Page) =>
  Promise.all(
    data.banner.vendorRoles.map(async (v) => {
      const found = page.locator(v.selector);
      const labels = await found.evaluateAll((els) =>
        els.map((e) => {
          const el = e as {
            getAttribute(n: string): string | null;
            textContent: string | null;
            tagName: string;
          };
          const role = el.getAttribute('role') ?? (el.tagName.toLowerCase() === 'button' ? 'button' : null);
          return `${role}:${el.getAttribute('aria-label') ?? el.textContent?.trim()}`;
        }),
      );
      return [v.role, labels] as const;
    }),
  );

describe('Wix selectors against the markup captured from the vendor banner', () => {
  const env = useCmpServer(['cmp/wix']);

  async function captured(): Promise<Page> {
    const { page } = await env.open('about:blank');
    await page.route(CAPTURED_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: CAPTURED }),
    );
    await page.goto(CAPTURED_URL, { waitUntil: 'load' });
    return page;
  }

  it('each selector finds exactly the element it means: the banner, its controls, the settings layer, its four switches and its save', async () => {
    const page = await captured();
    const region = page.getByRole('region');
    const layer = page.getByRole('dialog');
    const control = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
    const intended: Record<string, Locator> = {
      settings: control(region, 'Cookie-Einstellungen'),
      accept: control(region, 'Zustimmen'),
      close: control(region, 'Schließen'),
      save: control(layer, 'Auswahl bestätigen'),
    };
    const cases: Array<[string, string, Locator]> = [
      ...data.detect.dom.map((s): [string, string, Locator] => ['detection', s, region]),
      ...data.banner.containers.map((s): [string, string, Locator] => ['banner container', s, region]),
      ...data.banner.vendorRoles
        .filter((v) => !v.selector.includes(DECLINE_HOOK))
        .map((v): [string, string, Locator] => [`first-layer ${v.role}`, v.selector, intended[v.role]!]),
      ...layerData.containers.map((s): [string, string, Locator] => ['settings container', s, layer]),
      ['group switches', layerData.groups, layer.getByRole('checkbox')],
      ...layerData.vendorRoles.map((v): [string, string, Locator] => [
        `settings ${v.role}`,
        v.selector,
        intended[v.role]!,
      ]),
    ];

    for (const [what, selector, element] of cases) {
      const meant = await positions(element);
      expect(meant.length, what).toBeGreaterThan(0);
      expect(await positions(page.locator(selector)), `${what}: ${selector}`).toEqual(meant);
    }
    expect(await layer.getByRole('checkbox').count()).toBe(4);
    // The first layer of the captured site has no reject: its selector finds nothing there, and nothing else.
    const decline = data.banner.vendorRoles.filter((v) => v.selector.includes(DECLINE_HOOK));
    expect(decline.map((v) => v.role)).toEqual(['reject']);
    expect(await page.locator(decline[0]!.selector).count()).toBe(0);
  });

  it('every hook the Wix data names is rendered by the vendor: none is only the simulator’s', async () => {
    const page = await captured();

    const missing: string[] = [];
    for (const hook of hooksOfData()) {
      if (hook !== DECLINE_HOOK && (await page.locator(`[data-hook="${hook}"]`).count()) === 0)
        missing.push(hook);
    }

    expect(hooksOfData()).toContain(DECLINE_HOOK);
    expect(missing).toEqual([]);
  });

  it('the scanner’s path on the captured markup: the vendor settings control opens the layer; the layer, not the banner open behind it, is measured; the visually hidden switches are read with their state; "Auswahl bestätigen" is the save', async () => {
    const page = await captured();
    // The capture is the page after the click: the layer is hidden until the opener is clicked, as the vendor shows it.
    await page.evaluate(() => {
      interface El {
        style: { display: string };
        textContent: string | null;
        addEventListener(type: string, fn: () => void): void;
      }
      const doc = (
        globalThis as unknown as {
          document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
        }
      ).document;
      const layer = doc.querySelector('[role="dialog"]')!;
      const opener = Array.from(doc.querySelectorAll('[role="region"] button')).find(
        (b) => b.textContent?.trim() === 'Cookie-Einstellungen',
      )!;
      layer.style.display = 'none';
      opener.addEventListener('click', () => {
        layer.style.display = '';
      });
    });

    const facts = await wix.extract(page, 'first-screen', { phase: 'B' });
    expect(facts.firstLayer.buttons.map((b) => [b.name, b.kind, b.vendorRole])).toEqual([
      ['Cookie-Einstellungen', 'settings', 'settings'],
      ['Zustimmen', 'accept', 'accept'],
      ['Schließen', 'close', 'close'],
    ]);
    // Recognition rests on the vendor's script and API, which the capture does not hold; live they recognised Wix.
    const recognisedLive = {
      ...facts,
      detection: { ...facts.detection, cmpId: 'wix', method: 'adapter', recognitionConfidence: 'high' },
    } as const;
    const opener = chooseSettingsOpener(recognisedLive, loadLexicon(), DEFAULT_CLASSIFY);
    expect(opener?.target?.name).toBe('Cookie-Einstellungen');

    const layer = await wix.openSettings!(page, asTarget(opener!.target!), { timeoutMs: CMP_WAIT_MS });

    expect(layer).toMatchObject({
      opened: true,
      containerUnambiguous: true,
      buttonsTruncated: false,
      essentialGroups: 1,
      groups: [
        { checked: true, disabled: true },
        { checked: false, disabled: false },
        { checked: false, disabled: false },
        { checked: false, disabled: false },
      ],
    });
    expect(layer.buttons.map((b) => [b.name, b.vendorRole])).toEqual([
      ['Einstellungen schließen', null],
      ['Auswahl bestätigen', 'save'],
    ]);
    const save = chooseSettingsSave(layer, loadLexicon());
    expect(save.target?.name).toBe('Auswahl bestätigen');
    expect(await positions(page.locator(save.target!.selector!))).toEqual(
      await positions(page.getByRole('button', { name: 'Auswahl bestätigen' })),
    );
    // The switches the layer was read from are visually hidden inside shown toggles, and the banner stays open behind
    // the layer.
    const lines = await outline(page.getByRole('dialog'));
    expect(lines.filter((l) => l.includes('type=checkbox'))).toEqual(
      Array(4).fill(expect.stringMatching(/hook=consent-banner-section-toggle-input .* not-shown$/)),
    );
    expect(lines.filter((l) => /hook=consent-banner-section-toggle shown$/.test(l))).toHaveLength(4);
    expect((await wix.firstLayer(page)).bannerVisible).toBe(true);
  });

  it('the simulator renders the layer with the hooks, roles, nesting, labels and switch states of the vendor, the first layer with its controls and still open', async () => {
    const vendor = await captured();
    const { page: sim } = await env.open('https://www.wix.test/no-decline.html');
    const adapter = await recognized(sim, 'wix');
    expect(await waitForBanner(sim, adapter, { timeoutMs: CMP_WAIT_MS })).toBe(true);
    expect(await firstLayerControls(sim)).toEqual(await firstLayerControls(vendor));

    const opener = data.banner.vendorRoles.find((v) => v.role === 'settings')!;
    await sim.locator(opener.selector).click();
    await sim.getByRole('dialog').waitFor({ state: 'visible', timeout: CMP_WAIT_MS });

    const vendorLayer = await outline(vendor.getByRole('dialog'));
    expect(vendorLayer.length).toBeGreaterThan(10);
    // As the vendor's, the panel fades in a moment after the layer shows.
    await expect.poll(() => outline(sim.getByRole('dialog')), { timeout: CMP_WAIT_MS }).toEqual(vendorLayer);
    expect(await outline(sim.getByRole('region'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^div hook=consent-banner-root role=region shown$/)]),
    );
    expect((await adapter.firstLayer(sim)).bannerVisible).toBe(true);
  });
});
