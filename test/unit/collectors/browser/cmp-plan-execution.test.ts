/**
 * The CMP bridge executes the click target selected by core, without making a second decision.
 */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { ActOptions, ClickOutcome, ClickTarget, CmpAdapter } from '../../../../src/cmp/types.ts';
import { type CmpApi, CmpBridge } from '../../../../src/collectors/browser/cmp-bridge.ts';
import type { ClickPlan } from '../../../../src/core/snapshot-browser.ts';
import type { CollectorError } from '../../../../src/core/snapshot-common.ts';

const page = {} as Page;
const api = {} as CmpApi;
const planTarget: NonNullable<ClickPlan['target']> = {
  cmpId: 'cookiebot',
  name: 'Ablehnen',
  role: 'button',
  selector: '#reject',
  kindConfidence: 'high',
};

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
    const out = await new CmpBridge(api, 1_000, errors, 'B').act(page, adapter, 'reject', planTarget, 'u');
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
    const bridge = new CmpBridge(api, 1_000, [], 'C');
    await bridge.act(page, adapter, 'accept', { ...planTarget, name: 'Alle akzeptieren' }, 'u');
    await bridge.act(page, adapter, 'reject', null, 'u');
    const targetOf = (o?: ActOptions) => (o && 'target' in o ? (o.target?.name ?? null) : 'absent');
    expect(calls.map((c) => [c.via, targetOf(c.opts)])).toEqual([
      ['accept', 'Alle akzeptieren'],
      ['reject', null],
    ]);
    expect(calls.every((c) => c.opts && !('facts' in c.opts))).toBe(true);
  });
});
