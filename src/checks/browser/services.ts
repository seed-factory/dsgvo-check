/** Catalog lookups for a service id and the observation fields that carry its attribution. */
import type { Observation } from '../../core/api.ts';
import type { DerivedSection, ServiceCategory, ServiceInfo } from '../../derive/types.ts';

export const TRACKING_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  'analytics',
  'ads',
  'session-recording',
]);

export function serviceInfo(derived: DerivedSection, serviceId: string | null): ServiceInfo | null {
  return serviceId ? (derived.catalog[serviceId] ?? null) : null;
}

/** Display name: catalog name, else the third party's registrable domain. */
export function serviceName(
  derived: DerivedSection,
  serviceId: string | null,
  etld1?: string | null,
): string {
  return serviceInfo(derived, serviceId)?.name ?? etld1 ?? 'unknown';
}

/** Observation fields carrying the catalog attribution (never a finding about a transfer). */
export function serviceFields(
  derived: DerivedSection,
  serviceId: string | null,
): Pick<Observation, 'serviceId' | 'provider' | 'parent' | 'dpfEntity' | 'classification'> {
  const info = serviceInfo(derived, serviceId);
  const out: Pick<Observation, 'serviceId' | 'provider' | 'parent' | 'dpfEntity' | 'classification'> = {
    classification: info
      ? { source: 'catalog', datasetVersion: derived.catalogVersion }
      : { source: 'none', datasetVersion: derived.catalogVersion },
  };
  if (!info) return out;
  out.serviceId = info.serviceId;
  if (info.provider) out.provider = info.provider;
  if (info.parent) out.parent = info.parent;
  if (info.dpfEntity) out.dpfEntity = info.dpfEntity;
  return out;
}
