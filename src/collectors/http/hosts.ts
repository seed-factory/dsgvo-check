/** Host variants probed by the HTTP and TLS collectors (pure; shared without an import cycle). */
import type { HostVariant } from './types.ts';

export interface HostTarget {
  hostVariant: HostVariant;
  host: string;
}

/** Target host plus www/apex of its registrable domain (deduplicated; IP targets have no variants). */
export function hostVariants(host: string, etld1: string | null): HostTarget[] {
  const out: HostTarget[] = [{ hostVariant: 'target', host }];
  if (!etld1) return out;
  const www = `www.${etld1}`;
  if (www !== host) out.push({ hostVariant: 'www', host: www });
  if (etld1 !== host) out.push({ hostVariant: 'apex', host: etld1 });
  return out;
}
