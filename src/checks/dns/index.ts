/** DNS/mail checks registry. Add one import + one array entry per check. */
import type { AnyCheck } from '../../core/evaluation/check.ts';
import { mail01 } from './mail-01.ts';
import { mail02 } from './mail-02.ts';
import { mail03 } from './mail-03.ts';

export const dnsChecks: readonly AnyCheck[] = [mail01, mail02, mail03];
