/** The core never imports src/checks; the check list is passed in from src/checks/index.ts. */

import { SNAPSHOT_SECTION_KEYS } from '../snapshot/index.ts';
import type { AnyCheck } from './check.ts';

const ID_RE = /^[A-Z]+-\d{2}$/;
const VARIANT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export class CheckRegistry {
  readonly #checks = new Map<string, AnyCheck>();

  constructor(checks: readonly AnyCheck[] = []) {
    for (const c of checks) this.register(c);
  }

  register(check: AnyCheck): void {
    if (!ID_RE.test(check.id)) throw new RegistryError(`invalid check id "${check.id}"`);
    if (this.#checks.has(check.id)) throw new RegistryError(`duplicate check id "${check.id}"`);
    if (check.variants.length === 0) throw new RegistryError(`${check.id}: no variants`);

    const seen = new Set<string>();
    for (const v of check.variants) {
      if (!VARIANT_RE.test(v.variant)) throw new RegistryError(`${check.id}: invalid variant "${v.variant}"`);
      if (seen.has(v.variant)) throw new RegistryError(`${check.id}: duplicate variant "${v.variant}"`);
      seen.add(v.variant);
    }

    for (const key of check.requires) {
      if (!SNAPSHOT_SECTION_KEYS.includes(key))
        throw new RegistryError(`${check.id}: unknown section "${key}"`);
    }

    this.#checks.set(check.id, check);
  }

  get(id: string): AnyCheck | undefined {
    return this.#checks.get(id);
  }

  has(id: string): boolean {
    return this.#checks.has(id);
  }

  /** Checks sorted by id (stable order for reports). */
  all(): AnyCheck[] {
    return [...this.#checks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  ids(): string[] {
    return this.all().map((c) => c.id);
  }
}
