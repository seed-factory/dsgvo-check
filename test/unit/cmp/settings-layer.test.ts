/**
 * The pure decisions of a reject through the settings layer: only a recognised first layer without any reject opens
 * the settings, only through the vendor's settings control, and the layer is saved only when every changeable group is
 * already off and exactly one vendor save or reject control can be pressed. Switches are never toggled.
 */
import { describe, expect, it } from 'vitest';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import { chooseSettingsOpener, chooseSettingsSave } from '../../../src/cmp/settings-layer.ts';
import type { CmpButton, CmpDetection, CmpFacts, SettingsLayerFacts } from '../../../src/cmp/types.ts';
import { DEFAULT_CLASSIFY } from '../../utils/classify.ts';
import { makeCmpFacts } from '../../utils/snapshot-builder.ts';

const lexicon = loadLexicon();

function btn(name: string, p: Partial<CmpButton> = {}): CmpButton {
  return {
    role: 'button',
    name,
    tag: 'button',
    kind: 'other',
    kindConfidence: 'low',
    layer: 1,
    box: { x: 100, y: 700, width: 160, height: 40 },
    visibleAtFirstScreen: true,
    actionableAtFirstScreen: true,
    contrast: 7,
    selector: `[data-hook="${name.replace(/\W+/g, '-')}"]`,
    vendorRole: null,
    ...p,
  };
}

const wix: CmpDetection = {
  cmpId: 'wix',
  method: 'adapter',
  version: null,
  versionSupported: null,
  recognitionConfidence: 'high',
  signals: ['dom:[data-hook="consent-banner-root"]', 'script:static.parastorage.com'],
};

const settings = (p: Partial<CmpButton> = {}) =>
  btn('Cookie-Einstellungen', { vendorRole: 'settings', ...p });
const accept = btn('Zustimmen', { vendorRole: 'accept' });

function firstScreen(buttons: CmpButton[], detection: Partial<CmpDetection> = {}): CmpFacts {
  return makeCmpFacts({
    detection: { ...wix, ...detection },
    firstLayer: { bannerPresent: true, bannerVisible: true, buttons, purAbo: false, closeMeansAccept: null },
    blocking: { overlay: false, scrollLock: false, inert: false, coveredRatio: 0.15, method: [] },
  });
}

const opener = (buttons: CmpButton[], detection: Partial<CmpDetection> = {}) =>
  chooseSettingsOpener(firstScreen(buttons, detection), lexicon, DEFAULT_CLASSIFY);

describe('chooseSettingsOpener: only a recognised first layer without any reject opens the settings', () => {
  it('a bar with only "Cookie-Einstellungen" and "Zustimmen": the vendor settings control is the opener', () => {
    expect(opener([settings(), accept])).toEqual({
      target: expect.objectContaining({ name: 'Cookie-Einstellungen' }),
    });
  });

  it.each([
    ['a first-layer reject', [btn('Alle ablehnen', { vendorRole: 'reject' }), settings(), accept]],
    [
      'a reject that is not actionable',
      [btn('Alle ablehnen', { vendorRole: 'reject', actionableAtFirstScreen: false }), settings(), accept],
    ],
    ['a reject offered only as a link', [btn('Ablehnen', { role: 'link', tag: 'a' }), settings(), accept]],
    [
      'an unclassified first-layer control (no verdict)',
      [btn('Mehr dazu?', { kind: 'other' }), settings(), accept],
    ],
  ])('counterexample: %s → the first layer does not qualify, nothing is opened', (_, buttons) => {
    expect(opener(buttons)).toBeNull();
  });

  it.each([
    ['recognised below high', { recognitionConfidence: 'medium' as const }],
    ['found by the heuristic only', { method: 'heuristic' as const, cmpId: 'heuristic' }],
  ])('counterexample: a banner %s is never opened', (_, detection) => {
    expect(opener([settings(), accept], detection)).toBeNull();
  });

  it.each([
    ['labelled settings but without the vendor role', [btn('Cookie-Einstellungen'), accept]],
    [
      'with the vendor role but labelled as an accept',
      [btn('Alle akzeptieren', { vendorRole: 'settings' }), accept],
    ],
    ['not actionable', [settings({ actionableAtFirstScreen: false }), accept]],
    ['without a selector', [settings({ selector: undefined }), accept]],
    ['twice', [settings(), settings({ selector: '#second' }), accept]],
    ['absent (only "Zustimmen" and ×)', [accept, btn('Schließen', { vendorRole: 'close' })]],
  ])('a settings control %s: no opener, reason settings-control-not-found', (_, buttons) => {
    expect(opener(buttons)).toEqual({ target: null, reason: 'settings-control-not-found' });
  });
});

const off = { checked: false, disabled: false };
const on = { checked: true, disabled: false };
const essential = { checked: true, disabled: true };
const save = (p: Partial<CmpButton> = {}) => btn('Speichern', { vendorRole: 'save', ...p });

function layer(p: Partial<SettingsLayerFacts> = {}): SettingsLayerFacts {
  return {
    takenAt: '2026-11-07T10:00:00.000Z',
    opened: true,
    buttons: [save()],
    containerUnambiguous: true,
    buttonsTruncated: false,
    groups: [essential, off, off, off],
    essentialGroups: 1,
    ...p,
  };
}

describe('chooseSettingsSave: the layer is saved as the reject only as shown, every changeable group off', () => {
  it('every optional group off, one vendor save control: it is pressed; the always-on essential group is not read', () => {
    expect(chooseSettingsSave(layer(), lexicon)).toEqual({
      target: expect.objectContaining({ name: 'Speichern' }),
    });
  });

  it('a locked switch that is off holds nothing on: the layer is saved', () => {
    const lockedOff = { checked: false, disabled: true };
    expect(chooseSettingsSave(layer({ groups: [essential, lockedOff, off] }), lexicon).target?.name).toBe(
      'Speichern',
    );
  });

  it('a vendor reject control in the layer goes before its save control', () => {
    const reject = btn('Alle ablehnen', { vendorRole: 'reject' });
    expect(chooseSettingsSave(layer({ buttons: [save(), reject] }), lexicon).target?.name).toBe(
      'Alle ablehnen',
    );
  });

  it.each([
    ['one optional group pre-checked', { groups: [essential, off, on, off] }, 'preselected-groups'],
    ['every optional group pre-checked', { groups: [essential, on, on, on] }, 'preselected-groups'],
    [
      'a switch whose state cannot be read',
      { groups: [essential, off, { checked: null, disabled: false }] },
      'settings-groups-unreadable',
    ],
    ['no switch the visitor can change', { groups: [essential] }, 'settings-groups-unreadable'],
    ['no switch at all', { groups: [] }, 'settings-groups-unreadable'],
    [
      'a locked switch whose state cannot be read',
      { groups: [essential, { checked: null, disabled: true }, off] },
      'settings-groups-unreadable',
    ],
    [
      'an optional group on and locked beside the essential one',
      { groups: [essential, essential, off] },
      'preselected-groups',
    ],
    [
      'a locked switch on where the vendor shows no essential one',
      { groups: [essential, off], essentialGroups: 0 },
      'preselected-groups',
    ],
    ['a layer that did not show', { opened: false, buttons: [], groups: [] }, 'settings-not-opened'],
    ['two containers of the layer', { containerUnambiguous: false }, 'settings-layer-ambiguous'],
    ['controls cut by the probe', { buttonsTruncated: true }, 'settings-layer-ambiguous'],
    [
      'two vendor save controls',
      { buttons: [save(), save({ selector: '#again' })] },
      'settings-save-not-found',
    ],
    [
      'a save control that is not actionable',
      { buttons: [save({ actionableAtFirstScreen: false })] },
      'settings-save-not-found',
    ],
    [
      'a save role on an accept label',
      { buttons: [btn('Alle akzeptieren', { vendorRole: 'save' })] },
      'settings-save-not-found',
    ],
    ['a save label without the vendor role', { buttons: [btn('Speichern')] }, 'settings-save-not-found'],
    ['no control at all', { buttons: [] }, 'settings-save-not-found'],
  ] as const)('counterexample: %s → nothing is pressed (%s)', (_, p, reason) => {
    expect(chooseSettingsSave(layer(p as Partial<SettingsLayerFacts>), lexicon)).toEqual({
      target: null,
      reason,
    });
  });
});
