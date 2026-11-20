/**
 * Pure decisions for a reject through the settings layer (no page access): when the first layer of a recognised banner
 * offers no reject, which control opens the settings, and whether the shown choice may be saved as the reject. Switches
 * are never toggled: the layer is saved only when every group the visitor can change is already off.
 */
import { type ClassifyOptions, classifyFirstLayer } from './classify.ts';
import { classifyButton } from './lexicon.ts';
import type {
  CmpButton,
  CmpFacts,
  CmpLexicon,
  FirstLayerVariant,
  SettingsChoice,
  SettingsLayerFacts,
} from './types.ts';

/** First-layer variants without any reject control: only their banners are rejected in the settings layer. */
const NO_REJECT_VARIANTS: ReadonlySet<FirstLayerVariant> = new Set([
  'nonblocking-no-reject',
  'blocking-no-reject',
  'no-choice-at-first-layer',
]);

const clickable = (b: CmpButton): boolean => b.actionableAtFirstScreen && !!b.selector;

/**
 * The settings control to open in phase B: exactly one actionable first-layer control that the vendor marks as settings
 * and whose label says settings. Null when the first layer does not qualify: it has a reject (also one that is not
 * actionable or only a link), the banner is not recognised at `high`, or the table gives no verdict about it.
 */
export function chooseSettingsOpener(
  facts: CmpFacts,
  lexicon: CmpLexicon,
  options: ClassifyOptions,
): SettingsChoice | null {
  const cls = classifyFirstLayer(facts, lexicon, options);
  if (!NO_REJECT_VARIANTS.has(cls.variant) || cls.confidence !== 'high') return null;

  const openers = (cls.buttons ?? []).filter(
    (b) => b.layer === 1 && b.vendorRole === 'settings' && b.kind === 'settings' && clickable(b),
  );
  const [only] = openers;
  return only && openers.length === 1
    ? { target: only }
    : { target: null, reason: 'settings-control-not-found' };
}

/**
 * The control that saves the settings layer as the reject: only when the layer showed in one container, every switch
 * is readable, every switch the visitor can change is off, no more locked switches are on than the vendor's essential
 * groups (a locked switch may also hold an optional group on), and exactly one actionable control carries the vendor's
 * reject role (else its save role) with a label that is a reject or a save, never an accept.
 */
export function chooseSettingsSave(layer: SettingsLayerFacts, lexicon: CmpLexicon): SettingsChoice {
  if (!layer.opened) return { target: null, reason: 'settings-not-opened' };
  if (!layer.containerUnambiguous || layer.buttonsTruncated) {
    return { target: null, reason: 'settings-layer-ambiguous' };
  }

  const changeable = layer.groups.filter((g) => !g.disabled);
  if (changeable.length === 0 || layer.groups.some((g) => g.checked === null)) {
    return { target: null, reason: 'settings-groups-unreadable' };
  }
  const lockedOn = layer.groups.filter((g) => g.disabled && g.checked === true).length;
  if (changeable.some((g) => g.checked === true) || lockedOn > layer.essentialGroups) {
    return { target: null, reason: 'preselected-groups' };
  }

  const controls = layer.buttons
    .map((b) => ({ ...b, ...classifyButton(b, lexicon) }))
    .filter(
      (b) =>
        (b.vendorRole === 'reject' || b.vendorRole === 'save') &&
        (b.kind === 'reject' || b.kind === 'save') &&
        clickable(b),
    );
  const rejects = controls.filter((b) => b.vendorRole === 'reject');
  const candidates = rejects.length > 0 ? rejects : controls;
  const [only] = candidates;
  return only && candidates.length === 1
    ? { target: only }
    : { target: null, reason: 'settings-save-not-found' };
}
