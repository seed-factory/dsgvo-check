/** HTTP/TLS checks registry. Add one import + one array entry per check. */
import type { AnyCheck } from '../../core/evaluation/check.ts';
import { hdr01 } from './hdr-01.ts';
import { hdr02 } from './hdr-02.ts';
import { tls01 } from './tls-01.ts';
import { tls02 } from './tls-02.ts';

export const httpChecks: readonly AnyCheck[] = [hdr01, hdr02, tls01, tls02];
