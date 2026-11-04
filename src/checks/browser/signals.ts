/** What a check reads as a consent-relevant signal: persistent identifiers, CMP facts, bot and geo signals. */
import type { BotSignal, CmpFacts, CmpSection, GeoSignal } from '../../cmp/types.ts';
import type { BrowserPhase, CheckOutcome } from '../../core/api.ts';
import type { ClassifiedRequest } from '../../derive/types.ts';

/**
 * A hit carries a persistent identifier: stored tracking data or a user/click id holds even under Consent Mode
 * `denied`; a catalog identifier param counts only when the hit is not a denied (cookieless) ping.
 */
export function persistentIdentifier(c: ClassifiedRequest): boolean {
  const kind = c.identifierKind ?? 'none';
  if (kind === 'stored-match' || kind === 'sent-cookie' || kind === 'user-supplied') return true;
  return kind === 'persistent-param' && c.cookieless !== true;
}

export function allCmpFacts(cmp: CmpSection): CmpFacts[] {
  return cmp.phases.flatMap((p) => p.facts);
}

/** A consent banner was found on some page: a recognised CMP or a banner candidate in the DOM, visible or not. */
export function bannerFound(cmp: CmpSection): boolean {
  return allCmpFacts(cmp).some((f) => f.detection.method !== 'none' || f.firstLayer.bannerPresent);
}

/**
 * The `bannerFound` param of texts before an interaction. Found or not stay booleans, so a stored report renders as
 * before; `other` in their selects is the mixed case and the banner that was not evaluated.
 */
export type BannerState = boolean | 'not-observed';

/**
 * Texts that speak of "the interaction with the banner" need a banner, and say that none was found only when CMP
 * facts were recorded. Without any (extraction failed or timed out on every page) the banner was not evaluated, as
 * CONSENT-03 and CONSENT-04 report it inconclusive then.
 */
export function bannerState(cmp: CmpSection): BannerState {
  return allCmpFacts(cmp).length === 0 ? 'not-observed' : bannerFound(cmp);
}

export interface ConsentSignals {
  bot: BotSignal[];
  geo: GeoSignal[];
}

/** Direct bot and geo signals reported by CMP adapters in the given phases. */
export function consentSignals(cmp: CmpSection, phases: readonly BrowserPhase[]): ConsentSignals {
  const bot: BotSignal[] = [];
  const geo: GeoSignal[] = [];
  for (const p of cmp.phases) {
    if (!phases.includes(p.phase)) continue;
    for (const f of p.facts) {
      bot.push(...f.botSignals);
      geo.push(...f.geoSignals);
    }
  }
  return { bot, geo };
}

/** A direct bot or geo signal makes the consent evaluation inconclusive; null when there is none. */
export function signalOutcome(checkId: string, s: ConsentSignals): CheckOutcome | null {
  if (s.bot.length > 0) {
    return {
      status: 'inconclusive',
      reason: 'bot-mode',
      observations: [],
      diagnostics: [
        { code: 'SCAN-BOTMODE', affects: [checkId], params: { signal: s.bot[0]?.signal ?? null } },
      ],
    };
  }
  if (s.geo.length > 0) {
    return {
      status: 'inconclusive',
      reason: 'geo',
      observations: [],
      diagnostics: [{ code: 'SCAN-GEO', affects: [checkId], params: { signal: s.geo[0]?.signal ?? null } }],
    };
  }
  return null;
}
