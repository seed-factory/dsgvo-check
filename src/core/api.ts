/**
 * The only core module checks should import (D05/D23 import boundary). Everything here is pure.
 */

export type {
  AnyCheck,
  Check,
  CheckContext,
  CheckModule,
  CheckOutcome,
  CheckRunResult,
  CheckVariant,
  EvidenceInput,
  Observation,
  RelatedRef,
} from './check.ts';
export { defineCheck, normalizeOutcome, variantGroupOf } from './check.ts';
export type { TlsHostRole } from './fingerprint.ts';
export { fingerprint, subjects, tlsHostRole } from './fingerprint.ts';
export { cspFrameAncestors, MAX_HEADER_VALUE } from './headers.ts';
export { maskEmails, maskMailto, redactText } from './redact.ts';
export type { Confidence, MessageParams, Severity } from './report-schema.ts';
export type * from './snapshot.ts';
export { isSameSite, registrableDomain, sanitizeUrl } from './url.ts';
