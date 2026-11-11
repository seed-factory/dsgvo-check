/**
 * HDR-02 `version-header`: product headers of the main documents (start page, Impressum, Datenschutz) that name a
 * software version. Reads only the product/version pairs the collector stored next to the redacted value; one
 * observation per (header, product, version), pages united. Whether the version has known vulnerabilities is not judged.
 */

import {
  defineCheck,
  type EvidenceInput,
  type HeaderRecord,
  type Observation,
  PRODUCT_HEADERS,
  type ProductVersion,
  subjects,
} from '../../core/api.ts';
import type { DocumentResponse } from '../../core/snapshot/http.ts';
import { headerDocumentCoverage, headerStartDocument, headerStartFailure } from './shared.ts';

const ID = 'HDR-02';

/** Header names as servers usually write them, for the texts. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  server: 'Server',
  'x-powered-by': 'X-Powered-By',
  'x-generator': 'X-Generator',
  'x-redirect-by': 'X-Redirect-By',
  'x-aspnet-version': 'X-AspNet-Version',
  'x-aspnetmvc-version': 'X-AspNetMvc-Version',
};

/** A response that arrived and is the site's own: any status counts, the header is sent with error pages too. */
const evaluable = (doc: DocumentResponse): boolean => !doc.error && doc.status !== null;

/** The value as the header sent it: the version alone where the header name implies the product. */
function shownValue(name: string, pair: ProductVersion): string {
  return PRODUCT_HEADERS.get(name) === pair.product ? pair.version : `${pair.product}/${pair.version}`;
}

/** One observation per (header, product, version); a repeat on another page adds the page and its evidence. */
function addPair(byPair: Map<string, Observation>, page: string, name: string, pair: ProductVersion): void {
  const evidence: EvidenceInput = {
    type: 'header',
    phase: 'http',
    page,
    url: page,
    name,
    present: true,
    value: shownValue(name, pair),
  };
  const subject = subjects.versionHeader(name, pair.product, pair.version);
  const existing = byPair.get(subject);
  if (existing) {
    if (existing.pages.includes(page)) return;
    existing.pages.push(page);
    existing.evidence.push(evidence);
    existing.params.count = existing.pages.length;
    return;
  }

  byPair.set(subject, {
    checkId: ID,
    variant: 'version-header',
    confidence: 'high',
    subject,
    phases: ['http'],
    pages: [page],
    evidence: [evidence],
    params: {
      url: page,
      count: 1,
      header: DISPLAY_NAMES[name] ?? name,
      product: pair.product,
      version: pair.version,
    },
  });
}

/** Product headers of a response; `stored` is false when one of them was kept by name only (older snapshot). */
function productHeaders(headers: readonly HeaderRecord[]): { records: HeaderRecord[]; stored: boolean } {
  const records = headers.filter((h) => PRODUCT_HEADERS.has(h.name.toLowerCase()));
  return { records, stored: records.every((h) => Array.isArray(h.productVersions)) };
}

export const hdr02 = defineCheck({
  id: ID,
  module: 'http',
  requires: ['http'],
  variants: [{ variant: 'version-header' }],
  run(slice) {
    const docs = slice.http.documents;
    const unusable = headerStartFailure(headerStartDocument(docs));
    if (unusable) return unusable;

    const { evaluated, limitations } = headerDocumentCoverage(docs, evaluable);

    const byPair = new Map<string, Observation>();
    let notStored = false;
    for (const doc of evaluated) {
      const { records, stored } = productHeaders(doc.headers);
      if (!stored) notStored = true;
      for (const h of records) {
        for (const pair of h.productVersions ?? []) addPair(byPair, doc.finalUrl, h.name.toLowerCase(), pair);
      }
    }

    const observations = [...byPair.values()];
    const coverage = { planned: docs.length, evaluated: evaluated.length };
    // An older snapshot kept product headers by name only: an absent version there is unknown, not absent.
    if (notStored && observations.length === 0) {
      return { status: 'inconclusive', reason: 'values-not-stored', observations, coverage };
    }
    if (notStored) limitations.push('values-not-stored');
    if (slice.http.throttled) limitations.push('throttled');

    return {
      status: limitations.length > 0 ? 'partial' : 'completed',
      ...(limitations.length > 0 ? { limitations: [...new Set(limitations)] } : {}),
      observations,
      coverage,
    };
  },
});
