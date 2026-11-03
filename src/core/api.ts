/** The only core module checks should import (import boundary); everything here is pure. */

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
} from './evaluation/check.ts';
export { defineCheck, normalizeOutcome, variantGroupOf } from './evaluation/check.ts';
export type { TlsHostRole } from './evaluation/fingerprint.ts';
export { fingerprint, subjects, tlsHostRole } from './evaluation/fingerprint.ts';
export { cspFrameAncestors, MAX_HEADER_VALUE } from './redaction/headers.ts';
export { maskEmails, maskMailto, redactText } from './redaction/redact.ts';
export type { Confidence, MessageParams, Severity } from './report/schema.ts';
export { isCookieHeld, isHttpHref } from './snapshot/browser.ts';
export type * from './snapshot/index.ts';
export { isSameSite, parseUrl, registrableDomain, sanitizeUrl } from './url/url.ts';
