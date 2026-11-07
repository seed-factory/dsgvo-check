/**
 * EMBED-01, -02 and -03 take the moment of their loads from the same reject facts (src/checks/browser/reject-moment.ts),
 * so each of them runs the same moment rows with its own kind of load.
 */
import { expect } from 'vitest';
import type { CmpSection } from '../../../../../src/cmp/types.ts';
import type { Observation } from '../../../../../src/core/evaluation/check.ts';
import type { PhaseRecord, RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { named } from '../../../../utils/named-rows.ts';
import { CONTACT, click, page, phase, rejectCmp, START } from '../helpers.ts';

export const AFTER_CLICK = { phase: 'B', afterClick: true } as const;

/**
 * Phase B of a reject on the start page: the start page, its reload and `control` as the control page. The control
 * page takes its role from its URL, as in `consentPages`: Kontakt is the `contact` page, any other URL (the history
 * page of EMBED-03) a `nav` page.
 */
export const rejectPhase = (control: string, requests: RequestRecord[]) =>
  phase('B', {
    click: click('reject'),
    reloaded: true,
    pages: [
      page(START, 'start', 'B'),
      page(START, 'start', 'B', { reload: true }),
      page(control, control === CONTACT ? 'contact' : 'nav', 'B'),
    ],
    requests,
  });

export interface MomentParams {
  moment: string;
  rejectConfirmed: boolean | null;
  afterRejectPageCount: number;
  afterReject: boolean;
}
const BEFORE: MomentParams = {
  moment: 'before-interaction',
  rejectConfirmed: null,
  afterRejectPageCount: 0,
  afterReject: false,
};
const beforeAndAfter = (rejectConfirmed: boolean, afterRejectPageCount = 1): MomentParams => ({
  moment: 'before-and-after-reject',
  rejectConfirmed,
  afterRejectPageCount,
  afterReject: true,
});

export interface MomentCase {
  name: string;
  phases: PhaseRecord[];
  cmp: CmpSection;
  /** The params of the one finding; null: no finding. */
  want: MomentParams | null;
}

/**
 * The moment rows of one check, each with its name, for `it.each(…)('%s', …)`. `load(id, p)` is a load of the check on
 * its own default page, `phaseA` phase A with the given loads, `control` the control page of phase B.
 */
export function momentCases(o: {
  load: (id: string, p?: Partial<RequestRecord>) => RequestRecord;
  phaseA: (requests?: RequestRecord[]) => PhaseRecord;
  control: string;
}): Array<[string, MomentCase]> {
  const { load, phaseA, control } = o;
  const confirmed = rejectCmp({ confirmed: true, pages: { [control]: 'in-effect' } });
  const bannerAgain = rejectCmp({ confirmed: true, pages: { [control]: 'banner-again' } });
  const onControl = { ...AFTER_CLICK, pageUrl: control };
  return named([
    {
      name: 'loads before the interaction only',
      phases: [phaseA([load('a')])],
      cmp: confirmed,
      want: BEFORE,
    },
    {
      name: 'loads before the interaction and again after the confirmed reject',
      phases: [phaseA([load('a')]), rejectPhase(control, [load('b', onControl)])],
      cmp: confirmed,
      want: beforeAndAfter(true),
    },
    {
      name: 'loads only after the confirmed reject',
      phases: [phaseA(), rejectPhase(control, [load('b', onControl)])],
      cmp: confirmed,
      want: { moment: 'after-reject', rejectConfirmed: true, afterRejectPageCount: 1, afterReject: true },
    },
    {
      name: 'counterexample: phase B before its click is no load after the reject',
      phases: [phaseA(), rejectPhase(control, [load('b', { phase: 'B', afterClick: false })])],
      cmp: confirmed,
      want: BEFORE,
    },
    {
      name: 'the reject was clicked, but the CMP state did not confirm it',
      phases: [phaseA([load('a')]), rejectPhase(control, [load('b', AFTER_CLICK)])],
      cmp: rejectCmp({ confirmed: false }),
      want: beforeAndAfter(false),
    },
    {
      name: 'counterexample: a failed attempt after the reject is no load',
      phases: [
        phaseA([load('a')]),
        rejectPhase(control, [load('b', { ...AFTER_CLICK, state: 'failed', status: undefined })]),
      ],
      cmp: confirmed,
      want: BEFORE,
    },
    {
      name: 'a page that shows the banner again after the reject is not counted',
      phases: [
        phaseA([load('a')]),
        rejectPhase(control, [load('b', { ...AFTER_CLICK, pageUrl: START }), load('c', onControl)]),
      ],
      cmp: bannerAgain,
      want: beforeAndAfter(true),
    },
    {
      name: 'loads after the reject only on a page that shows the banner again do not confirm the reject',
      phases: [phaseA([load('a')]), rejectPhase(control, [load('c', onControl)])],
      cmp: bannerAgain,
      want: beforeAndAfter(false, 0),
    },
    {
      name: 'counterexample: loads only after the accept',
      phases: [
        phaseA(),
        phase('C', { click: click('accept'), requests: [load('c', { phase: 'C', afterClick: true })] }),
      ],
      cmp: confirmed,
      want: null,
    },
  ]);
}

/** The one finding of `variant` carries the moment params of the row, or there is no finding. */
export function expectMoment(found: Observation[], variant: string, want: MomentParams | null) {
  if (want) expect(found).toMatchObject([{ variant, params: want }]);
  else expect(found).toEqual([]);
}
