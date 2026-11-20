import type { PhaseRecord } from '../core/snapshot/browser.ts';
import { parseUrl, registrableDomain } from '../core/url/url.ts';
import type { InteractionTiming } from './types.ts';

/** Registrable domains (and bare hosts for IP targets) of the site itself. */
export class FirstPartyScope {
  readonly etld1s: Set<string>;
  readonly hosts: Set<string>;
  constructor(hosts: readonly string[]) {
    this.hosts = new Set(hosts.map((h) => h.toLowerCase()));
    this.etld1s = new Set();
    for (const h of this.hosts) {
      const d = registrableDomain(h);
      if (d) this.etld1s.add(d);
    }
  }
  has(host: string): boolean {
    const h = host.toLowerCase().replace(/^\./, '');
    if (this.hosts.has(h)) return true;
    const d = registrableDomain(h);
    return d !== null && this.etld1s.has(d);
  }
}

export function timingOf(
  phase: Pick<PhaseRecord, 'phase' | 'click'>,
  afterClick: boolean,
): InteractionTiming {
  if (phase.phase === 'A' || !afterClick) return 'before-interaction';
  const action = phase.click?.action ?? (phase.phase === 'C' ? 'accept' : 'reject');
  return action === 'accept' ? 'after-accept' : 'after-reject';
}

export function parseHttpUrl(raw: string): URL | null {
  return parseUrl(raw, undefined, true);
}
