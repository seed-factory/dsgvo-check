/** The check layer's explicit registry. The core receives this list; it never imports checks itself. */
import type { AnyCheck } from '../core/check.ts';
import { CheckRegistry } from '../core/registry.ts';
import { browserChecks } from './browser/index.ts';
import { dnsChecks } from './dns/index.ts';
import { httpChecks } from './http/index.ts';

export const allChecks: readonly AnyCheck[] = [...browserChecks, ...httpChecks, ...dnsChecks];

export function createRegistry(): CheckRegistry {
  return new CheckRegistry(allChecks);
}
