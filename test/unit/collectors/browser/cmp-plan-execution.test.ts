/** The CMP bridge executes the click target selected by core without a second decision. */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type {
  ActOptions,
  ClickOutcome,
  ClickTarget,
  CmpAdapter,
  SettingsLayerFacts,
  VerifyOptions,
} from '../../../../src/cmp/types.ts';
import { type CmpApi, CmpBridge } from '../../../../src/collectors/browser/cmp-bridge.ts';
import type { ClickPlan } from '../../../../src/core/snapshot/browser.ts';
import type { CollectorError } from '../../../../src/core/snapshot/common.ts';
import { DEFAULT_CLASSIFY } from '../../../utils/classify.ts';

const page = {} as Page;
const api = {} as CmpApi;
const planTarget: NonNullable<ClickPlan['target']> = {
  cmpId: 'cookiebot',
  name: 'Ablehnen',
  role: 'button',
  selector: '#reject',
  kindConfidence: 'high',
};

/** An adapter that records how it was called; `withAct` decides whether it offers `act` besides reject/accept. */
function fakeAdapter(withAct: boolean) {
  const calls: Array<{ via: string; action: string; target?: ClickTarget | null; opts?: ActOptions }> = [];
  const outcome = (action: 'reject' | 'accept'): ClickOutcome => ({ action, clicked: true, button: null });

  const adapter = {
    id: 'cookiebot',
    reject: async (_p: Page, opts?: ActOptions) => {
      calls.push({ via: 'reject', action: 'reject', ...(opts ? { opts } : {}) });
      return outcome('reject');
    },
    accept: async (_p: Page, opts?: ActOptions) => {
      calls.push({ via: 'accept', action: 'accept', ...(opts ? { opts } : {}) });
      return outcome('accept');
    },
    ...(withAct
      ? {
          act: async (_p: Page, action: 'reject' | 'accept', target: ClickTarget | null) => {
            calls.push({ via: 'act', action, target });
            return outcome(action);
          },
        }
      : {}),
  } as unknown as CmpAdapter;

  return { adapter, calls };
}

describe('CmpBridge.act executes the plan.click target', () => {
  it('passes the core decision to adapter.act; the adapter gets no facts to decide on', async () => {
    const { adapter, calls } = fakeAdapter(true);
    const errors: CollectorError[] = [];

    const out = await new CmpBridge(api, 1_000, errors, 'B', DEFAULT_CLASSIFY).act(
      page,
      adapter,
      'reject',
      planTarget,
      'u',
    );

    expect(out?.clicked).toBe(true);
    expect(calls).toEqual([
      {
        via: 'act',
        action: 'reject',
        target: {
          name: 'Ablehnen',
          role: 'button',
          selector: '#reject',
          kindConfidence: 'high',
          kind: 'reject',
        },
      },
    ]);
  });

  it('without act: reject/accept get `{ target }`; a null target is passed on as null (nothing is clicked)', async () => {
    const { adapter, calls } = fakeAdapter(false);
    const bridge = new CmpBridge(api, 1_000, [], 'C', DEFAULT_CLASSIFY);

    await bridge.act(page, adapter, 'accept', { ...planTarget, name: 'Alle akzeptieren' }, 'u');
    await bridge.act(page, adapter, 'reject', null, 'u');

    const targetOf = (o?: ActOptions) => (o && 'target' in o ? (o.target?.name ?? null) : 'absent');
    expect(calls.map((c) => [c.via, targetOf(c.opts)])).toEqual([
      ['accept', 'Alle akzeptieren'],
      ['reject', null],
    ]);
    // the adapter decides nothing: it is handed no facts
    expect(calls.filter((c) => !c.opts || 'facts' in c.opts)).toEqual([]);
  });
});

describe('CmpBridge.verify', () => {
  // The collector reloads on its own; a CMP that records the answer of a click late (Shopware's accept) is awaited
  // no longer than the scan waits for a CMP and its banner.
  it('reads the state without a reload, waiting at most the given time for the answer', async () => {
    const seen: VerifyOptions[] = [];
    const adapter = {
      id: 'shopware',
      verify: async (_p: Page, action: 'reject' | 'accept', opts?: VerifyOptions) => {
        seen.push(opts ?? {});
        return { action, verified: true, method: [], stateAfter: [], persistedAfterReload: null };
      },
    } as unknown as CmpAdapter;

    await new CmpBridge(api, 1_000, [], 'C', DEFAULT_CLASSIFY).verify(page, adapter, 'accept', 'u', 750);

    expect(seen).toEqual([{ reload: false, timeoutMs: 750 }]);
  });
});

describe('CmpBridge and the settings layer', () => {
  const settingsLayer = (name: string): SettingsLayerFacts => ({
    takenAt: '2026-11-07T10:00:00.000Z',
    opened: true,
    buttons: [
      {
        role: 'button',
        name,
        tag: 'button',
        kind: 'save',
        kindConfidence: 'high',
        layer: 1,
        box: null,
        visibleAtFirstScreen: true,
        actionableAtFirstScreen: true,
        contrast: null,
        selector: '#save',
        vendorRole: 'save',
      },
    ],
    containerUnambiguous: true,
    buttonsTruncated: false,
    groups: [{ checked: false, disabled: false }],
    essentialGroups: 1,
  });

  it("clicks core's settings control as a settings target and redacts the control names of the layer", async () => {
    const opened: ClickTarget[] = [];
    const adapter = {
      id: 'wix',
      openSettings: async (_p: Page, opener: ClickTarget, opts?: { timeoutMs?: number }) => {
        opened.push({ ...opener, ...(opts?.timeoutMs ? { name: `${opener.name}@${opts.timeoutMs}` } : {}) });
        return settingsLayer('Speichern für info@kunde.example.test');
      },
    } as unknown as CmpAdapter;
    const bridge = new CmpBridge(api, 1_000, [], 'B', DEFAULT_CLASSIFY);

    const layer = await bridge.openSettings(
      page,
      adapter,
      { ...planTarget, name: 'Cookie-Einstellungen' },
      'u',
      400,
    );

    expect(opened).toEqual([
      {
        name: 'Cookie-Einstellungen@400',
        role: 'button',
        selector: '#reject',
        kindConfidence: 'high',
        kind: 'settings',
      },
    ]);
    expect(layer?.buttons.map((b) => b.name)).toEqual(['Speichern für [redacted]@kunde.example.test']);
  });

  it('an adapter without a settings layer and an API without the settings decisions open and choose nothing', async () => {
    const bridge = new CmpBridge(api, 1_000, [], 'B', DEFAULT_CLASSIFY);
    const adapter = { id: 'cookiebot' } as unknown as CmpAdapter;

    expect(await bridge.openSettings(page, adapter, planTarget, 'u', 400)).toBeNull();
    expect(await bridge.settingsOpener({} as never, 'u')).toBeNull();
    expect(await bridge.settingsSave(settingsLayer('Speichern'), 'u')).toBeNull();
  });

  it('a settings call that throws is recorded once as an error of the phase, not thrown', async () => {
    const errors: CollectorError[] = [];
    const adapter = {
      id: 'wix',
      openSettings: async () => {
        throw new Error('page closed');
      },
    } as unknown as CmpAdapter;

    const layer = await new CmpBridge(api, 1_000, errors, 'B', DEFAULT_CLASSIFY).openSettings(
      page,
      adapter,
      planTarget,
      'https://www.example.test/',
      400,
    );

    expect(layer).toBeNull();
    expect(errors).toEqual([
      { code: 'cmp-settings-failed', message: 'page closed', phase: 'B', url: 'https://www.example.test/' },
    ]);
  });
});
