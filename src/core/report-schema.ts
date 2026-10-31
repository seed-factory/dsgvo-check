import { z } from 'zod';

/**
 * Report contract (consensus 5.1–5.6). Published schema: schema/report.schema.json (JSON Schema 2020-12).
 * Rules: objects are open in the published schema (emitted with io "input", no additionalProperties:false);
 * zod parsing strips unknown keys, so use safeParse only for validation. Closed enums are `severity`, `confidence`,
 * check `status` and `scan.status`. Changing them is a major schema bump.
 */
export const SCHEMA_VERSION = '0.2.0';

export const SeveritySchema = z.enum(['critical', 'warning', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const CheckStatusSchema = z.enum([
  'completed',
  'partial',
  'inconclusive',
  'not_applicable',
  'skipped',
  'error',
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const ScanStatusSchema = z.enum(['complete', 'partial', 'failed']);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const FailOnSchema = z.enum(['critical', 'warning', 'none']);
export type FailOn = z.infer<typeof FailOnSchema>;

/** Open set: A, A-prime, B, C, M (browser phases), http, tls, dns. New values are minor. */
export const PhaseSchema = z
  .string()
  .min(1)
  .meta({ description: 'Observation phase: A, B, C, http, tls, dns, …' });

const CheckIdSchema = z.string().regex(/^[A-Z]+-\d{2}$/);
const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoDateTime = z.string().min(1).meta({ description: 'UTC timestamp, ISO 8601' });
const ParamValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ParamsSchema = z.record(z.string(), ParamValueSchema);
export type MessageParams = z.infer<typeof ParamsSchema>;

export const ExitReasonSchema = z
  .string()
  .regex(
    /^(threshold|check-error:[A-Z]+-\d{2}|unreachable|blocked|timeout|sandbox-unavailable|invalid-input|internal-error|report-write-failed|strict:inconclusive:[A-Z]+-\d{2}|strict:sandbox-off|strict:egress-unverified)$/,
  );

// ---------------------------------------------------------------- evidence (5.3)

const evidenceBase = {
  id: z.string().min(1),
  phase: PhaseSchema.optional(),
  page: z.string().optional(),
};

/** 5.3 `features.identifier.kind` (D05; persistent kinds are stored-match, persistent-param, user-supplied). */
export const IdentifierKindSchema = z.enum([
  'stored-match',
  'persistent-param',
  'user-supplied',
  'per-load',
  'none',
]);

/** 5.3 time and context ids shared by request, cookie and storage evidence. */
const observationIds = {
  tMs: z
    .number()
    .optional()
    .meta({ description: 'ms since scan.startedAt on one monotonic scale for all phases and collectors' }),
  navigationId: z.string().optional(),
  actionId: z.string().optional().meta({ description: 'The B/C click the observation followed' }),
};

const RequestEvidence = z.object({
  ...evidenceBase,
  type: z.literal('request'),
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  initiator: z.object({ type: z.string().optional(), url: z.string().optional() }).optional(),
  ...observationIds,
  frameId: z.string().optional(),
  frameUrl: z.string().optional(),
  parentRequestId: z.string().optional().meta({ description: 'Request this one was redirected from' }),
  /** Did the request leave the browser? Independent of `result` (5.3). */
  delivery: z.enum(['attempted', 'blocked-by-browser', 'sent']),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('response'), status: z.number().int() }),
    z.object({ kind: z.literal('failed'), errorText: z.string() }),
    z.object({ kind: z.literal('aborted') }),
    z.object({ kind: z.literal('none') }),
  ]),
  provenance: z.enum(['network', 'service-worker', 'http-cache', 'memory-cache']).optional(),
  /** Safe features extracted by the collector before redaction (D05); never parameter values. */
  features: z.object({
    identifier: z.object({ kind: IdentifierKindSchema, param: z.string().optional() }),
    matchesStoredIdentifier: z.boolean(),
    eventType: z.string().optional(),
    consentSignal: z
      .object({
        gcs: z.string().optional(),
        gcd: z.string().optional(),
        npa: z.string().optional(),
        dma: z.string().optional(),
        adStorage: z.enum(['granted', 'denied']).nullable().optional(),
        analyticsStorage: z.enum(['granted', 'denied']).nullable().optional(),
      })
      .optional(),
    parserVersion: z.string(),
    observationSource: z.enum(['playwright', 'cdp', 'proxy-log']),
  }),
  thirdPartyETLD1: z.string().nullable().optional(),
  serviceId: z.string().optional(),
  connectedIp: z
    .object({ value: z.string(), origin: z.enum(['resolvedLocally', 'upstream', 'unknown']) })
    .optional(),
});

const CookieEvidence = z.object({
  ...evidenceBase,
  type: z.literal('cookie'),
  name: z.string(),
  domain: z.string().meta({ description: 'Cookie domain, or "first-party"' }),
  path: z.string(),
  partitionKey: z.string().nullable().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.string().optional(),
  lifetime: z.object({ kind: z.enum(['session', 'persistent']), days: z.number().optional() }).optional(),
  length: z.number().int().optional(),
  setter: z.enum(['http-response', 'script', 'unknown']).optional(),
  setterHost: z.string().optional(),
  state: z.enum(['attempted', 'accepted', 'rejected', 'sent']),
  ...observationIds,
});

const StorageEvidence = z.object({
  ...evidenceBase,
  type: z.literal('storage'),
  storageType: z.enum(['localStorage', 'sessionStorage', 'indexedDB']),
  origin: z.string(),
  key: z.string(),
  length: z.number().int().optional(),
  firstParty: z.boolean().optional(),
  ...observationIds,
});

const HeaderEvidence = z.object({
  ...evidenceBase,
  type: z.literal('header'),
  url: z.string(),
  name: z.string(),
  present: z.boolean(),
  value: z.string().nullable().optional(),
});

const DnsEvidence = z.object({
  ...evidenceBase,
  type: z.literal('dns'),
  qname: z.string(),
  qtype: z.string(),
  rcode: z.enum(['NOERROR', 'NXDOMAIN', 'NODATA', 'SERVFAIL', 'TIMEOUT', 'REFUSED', 'ERROR']),
  records: z.array(z.string()),
  resolver: z.string().optional(),
  treeWalk: z.array(z.string()).optional(),
});

const TlsEvidence = z.object({
  ...evidenceBase,
  type: z.literal('tls'),
  host: z.string(),
  port: z.number().int().optional(),
  ip: z.string().nullable().optional(),
  family: z.number().int().nullable().optional(),
  protocol: z.string().nullable().optional(),
  cipher: z.string().nullable().optional(),
  issuer: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  san: z.array(z.string()).optional(),
  notBefore: z.string().nullable().optional(),
  notAfter: z.string().nullable().optional(),
  /** Certificate lifetime L = notAfter − notBefore in days (D19 relative expiry thresholds). */
  lifetimeDays: z.number().nullable().optional(),
  chainComplete: z.boolean().nullable().optional(),
  /** Own `X509Certificate.checkHost/checkIP` result; null when no certificate. */
  hostnameMatches: z.boolean().nullable().optional(),
  authorizationError: z.string().nullable().optional(),
  trustStore: z.string().optional(),
});

const CmpEvidence = z.object({
  ...evidenceBase,
  type: z.literal('cmp'),
  cmpId: z.string().nullable(),
  version: z.string().nullable().optional(),
  recognitionConfidence: ConfidenceSchema,
  buttons: z
    .array(
      z.object({
        role: z.string().optional(),
        name: z.string(),
        kind: z.string(),
        kindConfidence: ConfidenceSchema.optional(),
        /** Role by the CMP's own markup/config, independent of the label (5.3 `vendorRole`); null = none. */
        vendorRole: z.string().nullable().optional(),
        box: z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .nullable()
          .optional(),
        visibleAtFirstScreen: z.boolean().optional(),
        actionableAtFirstScreen: z.boolean().optional(),
        contrast: z.number().nullable().optional(),
      }),
    )
    .optional(),
  blocking: z
    .object({
      overlay: z.boolean(),
      scrollLock: z.boolean(),
      inert: z.boolean(),
      coveredRatio: z.number().nullable(),
      method: z.array(z.string()).optional(),
    })
    .optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  click: z.object({ kind: z.string(), name: z.string().optional() }).nullable().optional(),
});

const ConsentStateEvidence = z.object({
  ...evidenceBase,
  type: z.literal('consent-state'),
  source: z.enum(['api', 'cookie', 'tcf']),
  ready: z.enum(['stub', 'loading', 'ready']),
  categories: z.record(z.string(), z.enum(['denied', 'granted', 'partial', 'unknown'])),
  origin: z.enum(['default', 'stored', 'action', 'special-branch']),
  scope: z.string().optional(),
});

const DocumentEvidence = z.object({
  ...evidenceBase,
  type: z.literal('document'),
  url: z.string(),
  kind: z.string(),
  lang: z.string().nullable().optional(),
  parts: z.array(z.object({ origin: z.string(), section: z.string().optional() })).optional(),
  complete: z.boolean(),
  errors: z.array(z.string()).optional(),
  sha256: z.string().optional(),
  /**
   * Completeness manifest of the processed document (D15): counters and one flag only, no text. Lets a negative
   * search ("not named in …") state how much of the document was read.
   */
  manifest: z
    .object({
      partCount: z.number().int().optional(),
      textLength: z.number().int().optional(),
      expandablesFound: z.number().int().optional(),
      expandablesOpened: z.number().int().optional(),
      framesIncluded: z.number().int().optional(),
      framesFound: z.number().int().optional(),
      framesRead: z.number().int().optional(),
      linkedPages: z.number().int().optional(),
      truncated: z.boolean().optional(),
    })
    .optional(),
});

const TextMatchEvidence = z.object({
  ...evidenceBase,
  type: z.literal('text-match'),
  documentId: z.string(),
  section: z.string().nullable().optional(),
  quote: z.string().max(200),
  matchLevel: z.enum(['named', 'company', 'domain', 'category', 'none']),
  negation: z.enum(['none', 'negated', 'ambiguous']).optional(),
});

const ScreenshotEvidence = z.object({
  ...evidenceBase,
  type: z.literal('screenshot'),
  path: z.string(),
  sha256: z.string(),
  kind: z.string().optional(),
});

const PageEvidence = z.object({
  ...evidenceBase,
  type: z.literal('page'),
  url: z.string(),
  status: z.number().int().nullable().optional(),
  role: z.string().optional(),
  evaluable: z.boolean().optional(),
  reason: z.string().optional(),
});

const RedirectChainEvidence = z.object({
  ...evidenceBase,
  type: z.literal('redirect-chain'),
  startUrl: z.string(),
  hops: z.array(
    z.object({ url: z.string(), status: z.number().int().nullable(), location: z.string().optional() }),
  ),
  outcome: z.string(),
});

const LinkEvidence = z.object({
  ...evidenceBase,
  type: z.literal('link'),
  href: z.string(),
  text: z.string(),
  target: z.string().optional(),
  status: z.number().int().nullable().optional(),
});

export const KNOWN_EVIDENCE_TYPES = [
  'request',
  'cookie',
  'storage',
  'header',
  'dns',
  'tls',
  'cmp',
  'consent-state',
  'document',
  'text-match',
  'screenshot',
  'page',
  'redirect-chain',
  'link',
] as const;
export type KnownEvidenceType = (typeof KNOWN_EVIDENCE_TYPES)[number];

/** Any evidence type not in KNOWN_EVIDENCE_TYPES (open enum: consumers ignore unknown types). */
const OtherEvidence = z.object({
  ...evidenceBase,
  type: z
    .string()
    .regex(new RegExp(`^(?!(?:${KNOWN_EVIDENCE_TYPES.join('|')})$)[a-z][a-z0-9-]*$`))
    .meta({ description: 'Evidence type not known to this schema version' }),
});

export const EvidenceSchema = z.union([
  RequestEvidence,
  CookieEvidence,
  StorageEvidence,
  HeaderEvidence,
  DnsEvidence,
  TlsEvidence,
  CmpEvidence,
  ConsentStateEvidence,
  DocumentEvidence,
  TextMatchEvidence,
  ScreenshotEvidence,
  PageEvidence,
  RedirectChainEvidence,
  LinkEvidence,
  OtherEvidence,
]);
export type Evidence = z.infer<typeof EvidenceSchema>;
export type RequestEvidence = z.infer<typeof RequestEvidence>;
export type CookieEvidence = z.infer<typeof CookieEvidence>;
export type StorageEvidence = z.infer<typeof StorageEvidence>;
export type HeaderEvidence = z.infer<typeof HeaderEvidence>;
export type DnsEvidence = z.infer<typeof DnsEvidence>;
export type TlsEvidence = z.infer<typeof TlsEvidence>;
export type CmpEvidence = z.infer<typeof CmpEvidence>;
export type ConsentStateEvidence = z.infer<typeof ConsentStateEvidence>;
export type DocumentEvidence = z.infer<typeof DocumentEvidence>;
export type TextMatchEvidence = z.infer<typeof TextMatchEvidence>;
export type ScreenshotEvidence = z.infer<typeof ScreenshotEvidence>;
export type PageEvidence = z.infer<typeof PageEvidence>;
export type RedirectChainEvidence = z.infer<typeof RedirectChainEvidence>;
export type LinkEvidence = z.infer<typeof LinkEvidence>;

// ---------------------------------------------------------------- findings, checks, diagnostics

const PartySchema = z.object({ name: z.string(), country: z.string().nullable() });

export const FindingSchema = z.object({
  checkId: CheckIdSchema,
  variant: z.string().min(1),
  variantGroup: z.string().min(1),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  crmCode: z
    .string()
    .nullable()
    .meta({ description: 'interne Taxonomie des Auftraggebers, keine rechtliche Einordnung' }),
  fingerprint: FingerprintSchema,
  subject: z.string().min(1),
  serviceId: z.string().optional(),
  phases: z.array(PhaseSchema),
  pages: z.array(z.string()),
  trigger: z.string().optional(),
  replicated: z.boolean().optional(),
  evidenceIds: z.array(z.string()).max(20),
  evidenceTruncated: z.boolean().optional(),
  messageId: z.string().min(1),
  params: ParamsSchema,
  legalNoteId: z.string().nullable(),
  related: z.array(
    z.object({ checkId: CheckIdSchema, fingerprint: FingerprintSchema, relation: z.string().optional() }),
  ),
  classification: z.object({ source: z.string(), datasetVersion: z.string().nullable() }),
  provider: PartySchema.optional(),
  parent: PartySchema.optional(),
  dpfEntity: z
    .object({
      name: z.string(),
      listed: z.boolean().nullable(),
      checkedAt: z.string().nullable(),
      source: z.string().nullable(),
    })
    .optional(),
  suppression: z
    .object({
      reason: z.string(),
      expires: z.string(),
      owner: z.string().optional(),
      expired: z.boolean(),
    })
    .optional(),
  baselineStatus: z.enum(['new', 'unchanged', 'severity-increased']).optional(),
  text: z
    .object({ lang: z.string(), title: z.string(), body: z.string(), draft: z.boolean() })
    .optional()
    .meta({ description: 'Rendered message (convenience copy of messageId + params)' }),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CheckResultSchema = z.object({
  id: CheckIdSchema,
  module: z.string().optional(),
  status: CheckStatusSchema,
  reason: z.string().nullable(),
  limitations: z.array(z.string()),
  coverage: z
    .object({
      planned: z.number().int().optional(),
      observed: z.number().int().optional(),
      evaluated: z.number().int().optional(),
      note: z.string().optional(),
    })
    .nullable(),
  durationMs: z.number().nonnegative(),
  maxSeverity: SeveritySchema.optional(),
  gating: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const DiagnosticSchema = z.object({
  code: z.string().regex(/^SCAN-[A-Z0-9-]+$/),
  affects: z.array(CheckIdSchema),
  evidenceIds: z.array(z.string()),
  messageId: z.string().optional(),
  params: ParamsSchema.optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

// ---------------------------------------------------------------- scan

const EgressSchema = z.object({
  mode: z.enum(['direct', 'proxy']),
  region: z.enum(['unknown', 'asserted']),
  assertedRegion: z.enum(['eea', 'de']).optional(),
  source: z.string().meta({ description: 'e.g. "laut Nutzerangabe (--assume-region)"' }),
});

export const EnvironmentSchema = z.object({
  userAgent: z.object({ http: z.string(), browser: z.string().nullable() }),
  browser: z
    .object({
      engine: z.string(),
      version: z.string().nullable(),
      channel: z.string().nullable(),
      headless: z.enum(['new', 'shell']).nullable(),
    })
    .nullable(),
  sandbox: z.object({ mode: z.enum(['require', 'off']), active: z.boolean().nullable() }),
  profile: z.string().nullable(),
  viewport: z.object({ width: z.number(), height: z.number() }).nullable(),
  locale: z.string(),
  timezone: z.string(),
  egress: EgressSchema,
  disabledChromiumFeatures: z.array(z.string()),
  quic: z.enum(['disabled', 'enabled']),
  knownGaps: z.array(z.string()),
  requestsIssued: z.object({
    navigations: z.number().int(),
    probes: z.number().int(),
    dns: z.number().int(),
    tls: z.number().int(),
  }),
  node: z.string(),
  platform: z.string(),
});
export type ScanEnvironment = z.infer<typeof EnvironmentSchema>;

export const CoverageSchema = z.object({
  pages: z.array(
    z.object({
      url: z.string(),
      role: z.string(),
      planned: z.boolean(),
      observed: z.boolean(),
      evaluated: z.boolean(),
      phases: z.array(PhaseSchema),
      reason: z.string().optional(),
    }),
  ),
  collectors: z.record(
    z.string(),
    z.object({ status: z.string(), reason: z.string().optional(), durationMs: z.number().optional() }),
  ),
  browserRequests: z
    .object({ limit: z.number().int(), issued: z.number().int(), truncated: z.boolean() })
    .optional(),
});
export type ScanCoverage = z.infer<typeof CoverageSchema>;

export const ScanOptionsSchema = z.object({
  failOn: FailOnSchema,
  strict: z.boolean(),
  lang: z.enum(['de', 'en']),
  formats: z.array(z.string()),
  maxPages: z.number().int(),
  timeoutMs: z.number().int(),
  sandbox: z.enum(['require', 'off']),
  screenshots: z.boolean(),
  checks: z.array(z.string()).nullable(),
  proxy: z.boolean(),
  assumeRegion: z.enum(['eea', 'de']).nullable(),
  fromSnapshot: z.boolean(),
  overrides: z.array(z.object({ rule: z.string(), severity: SeveritySchema })),
});
export type ReportScanOptions = z.infer<typeof ScanOptionsSchema>;

const FailureSchema = z.object({ code: z.string(), message: z.string() });

const ScanCompleteSchema = z.object({
  status: z.enum(['complete', 'partial']),
  target: z.string(),
  finalUrl: z.string().nullable(),
  startedAt: IsoDateTime,
  durationMs: z.number().nonnegative(),
  failure: FailureSchema.optional(),
  environment: EnvironmentSchema,
  coverage: CoverageSchema,
  options: ScanOptionsSchema.optional(),
});

const ScanFailedSchema = z.object({
  status: z.literal('failed'),
  target: z.string(),
  startedAt: IsoDateTime,
  failure: FailureSchema,
  finalUrl: z.string().nullable().optional(),
  durationMs: z.number().nonnegative().optional(),
  environment: EnvironmentSchema.optional(),
  coverage: CoverageSchema.optional(),
  options: ScanOptionsSchema.optional(),
});

// ---------------------------------------------------------------- top level

const ToolSchema = z.object({ name: z.literal('dsgvo-check'), version: z.string() });

const RulesetInfoSchema = z.object({
  version: z.string().meta({ description: 'CalVer' }),
  rechtsstand: z.string(),
  profile: z.literal('de-2026'),
  draft: z.boolean().optional(),
});

const DatasetSchema = z.object({
  name: z.string(),
  version: z.string().nullable(),
  date: z.string().nullable().optional(),
  sha256: z.string().nullable().optional(),
  license: z.string(),
  /** Attribution text shown in the HTML footer "Datensätze und Attribution" (5.8). */
  attribution: z.string().nullable().optional(),
  fetchedAt: z.string().nullable().optional(),
});

const LegalContextSchema = z.object({
  rechtsstand: z.string().optional(),
  notes: z
    .array(
      z.object({
        id: z.string(),
        status: z.string(),
        reviewedAt: z.string().nullable().optional(),
        reviewBy: z.string().nullable().optional(),
        draft: z.boolean().optional(),
      }),
    )
    .optional(),
});

const CountsSchema = z.object({
  critical: z.number().int(),
  warning: z.number().int(),
  info: z.number().int(),
  suppressed: z.number().int(),
  checkErrors: z.number().int(),
  inconclusive: z.number().int(),
});

const SummarySchema = z.object({
  counts: CountsSchema,
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  exitReasons: z.array(ExitReasonSchema),
});

const MinimalSummarySchema = z.object({
  counts: CountsSchema.optional(),
  exitCode: z.literal(2),
  exitReasons: z.array(ExitReasonSchema).min(1),
});

const DisclaimerSchema = z.object({
  messageId: z.string(),
  lang: z.string(),
  text: z.string().min(1),
  draft: z.boolean(),
});

export const FullReportSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.string(),
  tool: ToolSchema,
  ruleset: RulesetInfoSchema,
  datasets: z.array(DatasetSchema),
  scan: ScanCompleteSchema,
  checks: z.array(CheckResultSchema),
  findings: z.array(FindingSchema),
  diagnostics: z.array(DiagnosticSchema),
  evidence: z.array(EvidenceSchema),
  legalContext: LegalContextSchema,
  summary: SummarySchema,
  disclaimer: DisclaimerSchema,
});

/** Minimal report when the scan did not take place (5.1). Optional parts are kept if gathered before the failure. */
export const FailedReportSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.string(),
  tool: ToolSchema,
  ruleset: RulesetInfoSchema.optional(),
  datasets: z.array(DatasetSchema).optional(),
  scan: ScanFailedSchema,
  checks: z.array(CheckResultSchema).optional(),
  findings: z.array(FindingSchema).optional(),
  diagnostics: z.array(DiagnosticSchema).optional(),
  evidence: z.array(EvidenceSchema).optional(),
  legalContext: LegalContextSchema.optional(),
  summary: MinimalSummarySchema,
  disclaimer: DisclaimerSchema,
});

export const ReportSchema = z.union([FullReportSchema, FailedReportSchema]).meta({
  title: 'dsgvo-check report',
  description: `dsgvo-check JSON report, schemaVersion ${SCHEMA_VERSION}. Consumers must ignore unknown fields and unknown evidence types.`,
});

export type FullReport = z.infer<typeof FullReportSchema>;
export type FailedReport = z.infer<typeof FailedReportSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Counts = z.infer<typeof CountsSchema>;
export type Disclaimer = z.infer<typeof DisclaimerSchema>;
export type RulesetInfo = z.infer<typeof RulesetInfoSchema>;
export type DatasetInfo = z.infer<typeof DatasetSchema>;
export type LegalContext = z.infer<typeof LegalContextSchema>;

export const REPORT_SCHEMA_ID = `https://github.com/seed-factory/dsgvo-check/schema/report/${SCHEMA_VERSION}.json`;

/** JSON Schema 2020-12 of the report (published as schema/report.schema.json). */
export function reportJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReportSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  });
  return { ...schema, $id: REPORT_SCHEMA_ID };
}
