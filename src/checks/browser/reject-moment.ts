/**
 * When loads of an embed or a font service were observed relative to the reject of phase B: before the interaction,
 * after the reject, or both; whether the CMP state confirms the reject; on how many pages the reject was in effect. The
 * findings state it in their title and text and show the reject proof with the requests after it.
 */
import type { CmpSection } from '../../cmp/types.ts';
import type { EvidenceInput } from '../../core/api.ts';
import type { BrowserSection, RequestRecord } from '../../core/snapshot/browser.ts';
import type { ClassifiedRequest } from '../../derive/types.ts';
import { MAX_EVIDENCE, type RequestItem, requestEvidenceByMoment } from './evidence.ts';
import { sortedUniq } from './lists.ts';
import { confirmedReject, decisionInEffect, stateEvidence } from './signals.ts';
import { phaseRecord } from './snapshot.ts';

export type LoadMoment = 'before-interaction' | 'after-reject' | 'before-and-after-reject';

/** Where phase B pressed its reject: a first-layer control, or the save control of the settings layer. */
export type RejectPath = 'first-layer' | 'settings';

/** What phase B says about its reject, independent of the loads of one finding. */
export interface RejectFacts {
  /** The state our click set and the state read back after the reload; empty when the CMP state does not confirm it. */
  proof: EvidenceInput[];
  /** Whether the reject is in effect on a page of phase B by the CMP facts recorded there (`decisionInEffect`). */
  inEffect: (pageUrl: string) => boolean;
  path: RejectPath;
}

/** The path of the reject click of phase B; a click recorded before the settings layer existed is a first-layer one. */
export function rejectPath(cmp: CmpSection): RejectPath {
  return cmp.phases.find((p) => p.phase === 'B')?.click?.path === 'settings' ? 'settings' : 'first-layer';
}

export function rejectFacts(browser: BrowserSection, cmp: CmpSection): RejectFacts {
  const cmpB = cmp.phases.find((p) => p.phase === 'B');
  const phaseB = phaseRecord(browser, 'B');
  const confirmed = confirmedReject(cmpB);
  const proof = confirmed
    ? [
        stateEvidence(confirmed.action, phaseB?.click?.pageUrl ?? null),
        stateEvidence(confirmed.stored, phaseB?.pages.find((p) => p.reload)?.finalUrl ?? null),
      ]
    : [];
  const facts = cmpB?.facts ?? [];
  return {
    proof,
    inEffect: (pageUrl) =>
      decisionInEffect(
        facts.filter((f) => f.pageUrl === pageUrl),
        'B',
      ),
    path: rejectPath(cmp),
  };
}

/** Params of a finding about loads before the interaction and after the reject. */
export interface MomentParams {
  moment: LoadMoment;
  /**
   * Null without a load after the reject. True when the CMP state confirms the reject and it is in effect on a page
   * with such a load; a reject that is not in effect where the load happened (the banner shows again) is no reject
   * there, so it does not count as confirmed for this load.
   */
  rejectConfirmed: boolean | null;
  /** Pages with a load after the reject where the reject is in effect. */
  afterRejectPageCount: number;
  /** A load after the reject click, confirmed or not; kept so reports keep the param they always had. */
  afterReject: boolean;
  /** Where the reject was pressed; null without a load after the reject. */
  rejectPath: RejectPath | null;
}

/**
 * The moment of the loads by their timing: requests of phase B before its click are before the interaction, as the
 * visitor has not answered the banner yet. Callers leave out phase C and failed requests.
 */
export function loadMoment(
  loads: readonly ClassifiedRequest[],
  records: ReadonlyMap<string, RequestRecord>,
  reject: RejectFacts,
): MomentParams {
  const after = loads.filter((c) => c.timing === 'after-reject');
  const before = loads.some((c) => c.timing === 'before-interaction');
  const afterPages = sortedUniq(after.flatMap((c) => records.get(c.requestId)?.pageUrl ?? []));
  const inEffect = afterPages.filter(reject.inEffect).length;

  if (after.length === 0) {
    return {
      moment: 'before-interaction',
      rejectConfirmed: null,
      afterRejectPageCount: 0,
      afterReject: false,
      rejectPath: null,
    };
  }
  return {
    moment: before ? 'before-and-after-reject' : 'after-reject',
    rejectConfirmed: reject.proof.length > 0 && inEffect > 0,
    afterRejectPageCount: inEffect,
    afterReject: true,
    rejectPath: reject.path,
  };
}

/** The reject proof a finding shows: only for loads after a reject that counts as confirmed. */
export function rejectProof(m: MomentParams, reject: RejectFacts): EvidenceInput[] {
  return m.rejectConfirmed ? reject.proof : [];
}

/**
 * Request evidence that keeps places for the requests after the reject, so repeats of the same URLs before the
 * interaction do not crowd them out, followed by the reject proof; at most `MAX_EVIDENCE` items together.
 */
export function momentEvidence(
  items: Iterable<RequestItem>,
  proof: readonly EvidenceInput[],
): EvidenceInput[] {
  return [...requestEvidenceByMoment(items, { max: MAX_EVIDENCE - proof.length }), ...proof];
}
