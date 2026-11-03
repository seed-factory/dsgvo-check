/** Loads the adapter data from test/data/cmp (collector side; CONSENT-04 gets the same through `ctx.data.cmp`). */
import { loadSection } from '../core/data/load.ts';
import { type AdapterData, adaptersSection, probeSection } from './adapters-data.ts';
import type { KnownCmpId } from './types.ts';

export const loadAdapterData = (dataDir?: string) => loadSection(adaptersSection, dataDir);

export const loadProbeData = (dataDir?: string) => loadSection(probeSection, dataDir);

export const adapterData = (id: KnownCmpId): AdapterData => loadAdapterData()[id];

/** Reader inputs the schema requires for their adapter (see READER_INPUTS in adapters-data.ts). */
export function readerInput(id: KnownCmpId, key: 'botUserAgent'): string;
export function readerInput(id: KnownCmpId, key: 'optionalGroups' | 'essentialEmbeddings'): string[];
export function readerInput(id: KnownCmpId, key: 'botUserAgent' | 'optionalGroups' | 'essentialEmbeddings') {
  return adapterData(id)[key] as string | string[];
}
