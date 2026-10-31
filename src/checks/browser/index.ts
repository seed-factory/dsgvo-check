/** Browser checks registry (owner: M3). Add one import + one array entry per check. */
import type { AnyCheck } from '../../core/check.ts';
import { consent01 } from './consent-01.ts';
import { consent02 } from './consent-02.ts';
import { consent03 } from './consent-03.ts';
import { consent04 } from './consent-04.ts';
import { consent05 } from './consent-05.ts';
import { embed01 } from './embed-01.ts';
import { embed02 } from './embed-02.ts';
import { legal01 } from './legal-01.ts';
import { priv01 } from './priv-01.ts';
import { track01 } from './track-01.ts';

export const browserChecks: readonly AnyCheck[] = [
  consent01,
  consent02,
  consent03,
  consent04,
  consent05,
  track01,
  embed01,
  embed02,
  legal01,
  priv01,
];
