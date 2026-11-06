/**
 * Browser-check snapshot fixtures built in memory (dns: dns/fixtures.ts, http: JSON in test/fixtures/snapshots):
 * `SCENARIOS` has a violation, clean and inconclusive case per check, `VARIANT_SCENARIOS` one per further variant.
 */

import type { RawFixture } from '../../../../utils/snapshot-builder.ts';
import { fixtureBody } from '../helpers.ts';
import * as consent01 from './consent-01.ts';
import * as consent02 from './consent-02.ts';
import * as consent03 from './consent-03.ts';
import * as consent04 from './consent-04.ts';
import * as consent05 from './consent-05.ts';
import * as embed01 from './embed-01.ts';
import * as embed02 from './embed-02.ts';
import * as embed03 from './embed-03.ts';
import * as legal01 from './legal-01.ts';
import * as legal02 from './legal-02.ts';
import * as priv01 from './priv-01.ts';
import * as priv02 from './priv-02.ts';
import type { Scenario } from './shared.ts';
import * as track01 from './track-01.ts';

export type { Scenario } from './shared.ts';

export const SCENARIOS: Record<string, Scenario[]> = {
  'CONSENT-01': consent01.scenarios,
  'CONSENT-02': consent02.scenarios,
  'CONSENT-03': consent03.scenarios,
  'CONSENT-04': consent04.scenarios,
  'CONSENT-05': consent05.scenarios,
  'TRACK-01': track01.scenarios,
  'EMBED-01': embed01.scenarios,
  'EMBED-02': embed02.scenarios,
  'EMBED-03': embed03.scenarios,
  'LEGAL-01': legal01.scenarios,
  'LEGAL-02': legal02.scenarios,
  'PRIV-01': priv01.scenarios,
  'PRIV-02': priv02.scenarios,
};

export const VARIANT_SCENARIOS: Record<string, Scenario[]> = {
  'CONSENT-01': consent01.variantScenarios,
  'CONSENT-02': consent02.variantScenarios,
  'CONSENT-03': consent03.variantScenarios,
  'CONSENT-04': consent04.variantScenarios,
  'CONSENT-05': consent05.variantScenarios,
  'EMBED-01': embed01.variantScenarios,
  'LEGAL-01': legal01.variantScenarios,
  'LEGAL-02': legal02.variantScenarios,
  'PRIV-01': priv01.variantScenarios,
  'PRIV-02': priv02.variantScenarios,
};

/** The fixture of a scenario as the loader reads it (a JSON round trip, so it holds only what a file could). */
export function scenarioFixture(s: Scenario): RawFixture {
  return JSON.parse(
    JSON.stringify({ $description: s.description, $expect: s.expect, ...fixtureBody(s.build()) }),
  );
}

/** Every scenario of a browser check: the base cases and the variant cases. */
export function scenariosOf(checkId: string): Scenario[] {
  return [...(SCENARIOS[checkId] ?? []), ...(VARIANT_SCENARIOS[checkId] ?? [])];
}
