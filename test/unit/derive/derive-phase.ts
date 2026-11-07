/** derive over a snapshot of www.example.de whose browser recorded the given phases, most often one phase A. */
import type { PhaseRecord } from '../../../src/core/snapshot/browser.ts';
import type { TargetInfo } from '../../../src/core/snapshot/index.ts';
import { type DeriveOptions, derive } from '../../../src/derive/index.ts';
import {
  makeBrowser,
  makePhase,
  makeRequest,
  makeSnapshot,
  makeTarget,
} from '../../utils/snapshot-builder.ts';

export const snap = (phases: PhaseRecord[], target: TargetInfo = makeTarget('https://www.example.de/')) =>
  makeSnapshot({ target, browser: makeBrowser({ phases }) });

/** derive over one phase A with these requests, cookies, storage or pages. */
export const deriveA = (phase: Partial<PhaseRecord>, opts?: DeriveOptions, target?: TargetInfo) =>
  derive(snap([makePhase('A', phase)], target), opts);

type RequestExtra = Omit<Parameters<typeof makeRequest>[0], 'url'>;

/** Requests of one phase A page, derived; `extra` sets the collector facts (identifier names, resource type). */
export const requestsOf = (...items: Array<[string, RequestExtra?]>) =>
  deriveA({ requests: items.map(([url, extra = {}], i) => makeRequest({ id: `r${i}`, url, ...extra })) })
    .requests;
