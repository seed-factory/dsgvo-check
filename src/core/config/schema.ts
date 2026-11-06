/**
 * Operator settings: one zod schema with the built-in defaults, the unit of every number in the field name (`Ms`,
 * `Bytes`, `Days`) and a description that ends up in `.env.example`. Every value is optional, so the scanner runs
 * without any configuration. Constants of protocols and limits that protect the scanned site or the privacy
 * guarantees stay in code (see the settings section of docs/architecture.md). A setting that must not be weaker than
 * the built-in value has its built-in value as minimum and the `floor` reason. The `message` of a check here is the id
 * of a text (`config.problem.<id>` in test/data/texts), see problems.ts: no wording lives in code.
 */
import { z } from 'zod';
import { REPORT_DETAILS, REPORT_FORMATS } from '../report/reporter.ts';
import { FailOnSchema, LangSchema, type MessageParams, SandboxModeSchema } from '../report/schema.ts';
import { envName } from './names.ts';
import { REASON } from './problems.ts';

const int = (def: number, description: string, min: number, max?: number, minReason?: string) => {
  let n = z
    .number()
    .int()
    .min(min, minReason ? { error: minReason } : undefined);
  if (max !== undefined) n = n.max(max);
  return n.default(def).meta({ description });
};

const ratio = (def: number, description: string) =>
  z.number().gt(0).max(1).default(def).meta({ description });

/** `host`, `host:port`, `[v6]` or `[v6]:port` as accepted by `dns.Resolver.setServers`. */
const DNS_SERVER = /^(?:\[[0-9a-f:.]+\]|[0-9a-f:.]+|[a-z0-9.-]+)(?::\d{1,5})?$/i;

const scan = z.strictObject({
  failOn: FailOnSchema.default('critical').meta({
    description: 'Severity from which the exit code is 1 (CLI: --fail-on).',
  }),
  maxPages: int(6, 'Pages the browser visits in phase A, start page included (CLI: --max-pages).', 1, 50),
  timeoutMs: int(480_000, 'Global time limit of one scan (CLI: --timeout, which also accepts 8m or 90s).', 1),
  proxy: z
    .string()
    .regex(/^http:\/\/\S+$/i, { error: REASON.proxyScheme })
    .nullable()
    .default(null)
    .meta({
      description:
        'HTTP proxy for browser, HTTP and TLS probes (CLI: --proxy). May hold credentials: keep it out of the process list.',
    }),
  abortGraceMs: int(
    10_000,
    'Time a collector gets after the global timeout to stop and hand over what it has. Must exceed the 5.5 s orderly browser shutdown.',
    6_000,
  ),
  reportWriteReserveMs: int(
    30_000,
    `Reserve on top of the global timeout for writing reports; the watchdog ends the process after timeout plus reserve. Must cover ${envName('scan', 'abortGraceMs')} plus ${envName('pdf', 'timeoutMs')}.`,
    1,
  ),
});

const browser = z.strictObject({
  sandbox: SandboxModeSchema.default('require').meta({
    description:
      'Chromium sandbox: require, off for hosts without user namespaces, or container (only inside the dsgvo-check image, where the container is the isolation; CLI: --sandbox).',
  }),
  launchTimeoutMs: int(60_000, 'Time limit for starting Chromium.', 1_000),
  navigationPauseMs: int(
    1_500,
    'Pause between two navigations of the browser.',
    1_500,
    undefined,
    REASON.floor,
  ),
  navigationTimeoutMs: int(30_000, 'Time limit of one navigation until the document is committed.', 1_000),
  loadTimeoutMs: int(15_000, 'Time limit for the load event after a navigation.', 1_000),
  retryDelayMs: int(
    3_000,
    'Pause before the single retry after a 5xx or 429 of the start page (a Retry-After header wins, capped at 30 s).',
    3_000,
    undefined,
    REASON.floor,
  ),
  deadlineReserveMs: int(
    20_000,
    'Time kept free before the global timeout: no new page is started once less is left.',
    0,
  ),
  cmpCallTimeoutMs: int(
    15_000,
    'Time limit of one call into the CMP subsystem (detect, extract, click).',
    1_000,
  ),
  quietWindowMs: int(2_000, 'A page counts as quiet after this long without a new request.', 0),
  maxInflight: int(1, 'Requests that may stay open while a page still counts as quiet.', 0, 100),
  phaseAMinDwellMs: int(6_000, 'Phase A: shortest stay on a page before it can count as quiet.', 0),
  phaseAHardCapMs: int(20_000, 'Phase A: longest stay on a page; quiet not reached is recorded.', 0),
  phaseBMinDwellMs: int(4_000, 'Phase B (reject): shortest stay on a page before it can count as quiet.', 0),
  phaseBHardCapMs: int(12_000, 'Phase B (reject): longest stay on a page; quiet not reached is recorded.', 0),
  phaseCMinDwellMs: int(4_000, 'Phase C (accept): shortest stay on a page before it can count as quiet.', 0),
  phaseCHardCapMs: int(12_000, 'Phase C (accept): longest stay on a page; quiet not reached is recorded.', 0),
  requestLimit: int(2_000, 'Requests recorded per scan; further ones are only counted.', 100, 100_000),
  maxControlPages: int(
    2,
    'Pages of phase A that phases B and C visit again after the reject or accept click (control pages); 0 visits only the start page.',
    0,
    5,
  ),
  maxSupplementaryPolicies: int(
    1,
    'Further privacy notices of the site (for example for course participants or applicants) that phase A reads after the privacy policy, best-ranked link first; they do not count against --max-pages. Other language versions are recorded, not read. 0 reads only the policy.',
    0,
    3,
  ),
  revealDwellMs: int(
    3_000,
    `Longest stay on a page after its viewport was enlarged to the document height, so that maps, videos and other content below the first screen load as they do for a visitor who scrolls; no scroll or input event is sent, and the first screen was measured before. Capped by the hard cap of the phase (${envName('browser', 'phaseAHardCapMs')} and the others). 0 leaves the viewport at the first screen.`,
    0,
    60_000,
  ),
  revealMaxHeightPx: int(
    10_000,
    `Tallest viewport, in CSS pixels, for showing the content below the first screen (${envName('browser', 'revealDwellMs')}); what lies further down stays unseen and the embed checks name the limitation.`,
    1_000,
    30_000,
  ),
  screenshotMaxBytes: int(
    204_800,
    `Largest banner screenshot kept. The HTML report embeds images up to ${envName('report', 'screenshotEmbedMaxBytes')}.`,
    10_240,
    2_097_152,
  ),
  screenshotMaxViewportShare: ratio(
    0.5,
    'Largest share of the viewport a banner may cover to be photographed; a larger container gets no image.',
  ),
  sourceFetchTimeoutMs: int(8_000, 'Time limit for fetching robots.txt and sitemaps.', 1_000),
  responseMetaTimeoutMs: int(
    5_000,
    'Time limit per response for reading its headers and server address.',
    100,
  ),
  storageReadTimeoutMs: int(1_000, 'Time limit per frame for reading cookies and Web Storage names.', 100),
  persistentCookieMinDays: int(
    1,
    'Cookies that expire sooner count as short-lived, like session cookies: CONSENT-02 lists only longer-lived ones as persistent entries. Known tracking identifiers are reported whatever their lifetime; 0 counts every cookie with an expiry date.',
    0,
    3_650,
  ),
});

const http = z.strictObject({
  minIntervalMs: int(
    500,
    'Smallest gap between two requests to one host, for the HTTP probes and robots.txt and sitemaps (500 = 2 requests per second).',
    500,
    undefined,
    REASON.floor,
  ),
  connectTimeoutMs: int(5_000, 'Time limit for connecting to a host.', 100),
  headersTimeoutMs: int(10_000, 'Time limit until the response headers arrive.', 100),
  bodyTimeoutMs: int(10_000, 'Time limit between two chunks of a response body.', 100),
  requestTimeoutMs: int(20_000, 'Time limit of one request from start to the end of the body.', 100),
  maxRedirects: int(5, 'Redirect hops followed per probe chain.', 1, 20),
});

const tls = z.strictObject({
  timeoutMs: int(10_000, 'Time limit of one TLS handshake.', 100),
  shortLivedDays: int(
    10,
    'Certificates valid for at most this many days are short-lived and never reported as expiring.',
    0,
  ),
  expiringDays: int(
    14,
    `TLS-02 expiring: reported when fewer days are left than this and less than ${envName('tls', 'expiringLifetimeShare')} of the lifetime.`,
    0,
  ),
  expiringLifetimeShare: ratio(
    0.25,
    'TLS-02 expiring: share of the certificate lifetime; it keeps short-lived certificates from being reported too early.',
  ),
  approachingDays: int(
    30,
    `TLS-02 expiry approaching: reported when fewer days are left than this and less than ${envName('tls', 'approachingLifetimeShare')} of the lifetime.`,
    0,
  ),
  approachingLifetimeShare: ratio(
    0.5,
    'TLS-02 expiry approaching: share of the certificate lifetime, as for the expiring window.',
  ),
});

const dns = z.strictObject({
  servers: z
    .array(z.string().regex(DNS_SERVER, { error: REASON.dnsServer }))
    .default([])
    .meta({
      description: 'Resolvers as comma-separated host or host:port; empty uses the system resolver.',
    }),
  timeoutMs: int(3_000, 'Time limit of one DNS attempt.', 100),
  retries: int(1, 'Further attempts after SERVFAIL or a timeout.', 0, 5),
  queryBudget: int(60, 'DNS queries per scan.', 1, 200),
  concurrency: int(4, 'DNS queries in flight at once.', 1, 16),
  maxTimeoutResults: int(
    3,
    'Queries that end in a timeout (after retries) before the resolver counts as unresponsive and the rest is skipped.',
    1,
    20,
  ),
});

const cmp = z.strictObject({
  blockingCoveredRatio: ratio(
    0.85,
    'Share of the viewport a banner must cover to count as blocking, besides overlay, scroll lock and inert content.',
  ),
  waitMs: int(
    5_000,
    `Time to wait for a CMP and its banner to appear (capped by ${envName('browser', 'cmpCallTimeoutMs')}).`,
    0,
  ),
  minCandidatePages: int(
    2,
    'Pages of phase A on which a banner the heuristic took, a banner-like box it did not take (or, in older snapshots, the same banner link) must show, when not on the start page, before CONSENT-03 stops concluding that there is no banner.',
    1,
    50,
  ),
});

const legal = z.strictObject({
  impressumMinGroups: int(
    3,
    'Kinds of provider details (register entry, VAT ID, representative, statement under § 5 DDG, person responsible for the content) one block of text must hold to count as the details of an Impressum.',
    2,
    5,
  ),
  policyClaimMinContexts: int(
    2,
    'Observations, as distinct pairs of page and browser phase, that must differ from a statement of the privacy policy before the difference counts as repeated.',
    2,
    20,
  ),
});

const report = z.strictObject({
  formats: z
    .array(z.enum(REPORT_FORMATS))
    .min(1)
    .default(['console', 'json'])
    .meta({
      description: `Report formats, comma-separated: ${REPORT_FORMATS.join(', ')} (CLI: --format, also of the report command, which writes html while this is not set).`,
    }),
  detail: z.enum(REPORT_DETAILS).default('full').meta({
    description:
      'Level of detail of report.html and report.pdf: full (findings with evidence) or brief (plain summary and action points). JSON, console and summary.md are not affected (CLI: --detail, also of the report command).',
  }),
  outDir: z.string().min(1).default('./dsgvo-check-report').meta({
    description: 'Directory for reports and artifacts (CLI: --out).',
  }),
  lang: LangSchema.default('de').meta({
    description: 'Language of the report texts (CLI: --lang, also of the report command).',
  }),
  summaryMaxFindings: int(50, 'Findings listed in summary.md (the Job Summary); more are counted.', 1, 1_000),
  summaryMaxBytes: int(524_288, 'Size above which summary.md is cut.', 10_240, 5_242_880),
  screenshotEmbedMaxBytes: int(2_097_152, 'Largest screenshot embedded into report.html.', 1_024, 16_777_216),
  maxEvidencePerFinding: int(20, 'Evidence items kept per finding; more are marked as truncated.', 1, 200),
});

const pdf = z.strictObject({
  timeoutMs: int(
    15_000,
    'Time limit for printing report.pdf; a longer print is dropped with a warning.',
    1_000,
  ),
});

export const ConfigSchema = z
  .strictObject({
    scan: scan.prefault({}),
    browser: browser.prefault({}),
    http: http.prefault({}),
    tls: tls.prefault({}),
    dns: dns.prefault({}),
    cmp: cmp.prefault({}),
    legal: legal.prefault({}),
    report: report.prefault({}),
    pdf: pdf.prefault({}),
  })
  .superRefine((c, ctx) => {
    const issue = (path: [string, string], message: string, params: MessageParams) =>
      ctx.addIssue({ code: 'custom', path, message, params });

    for (const p of ['A', 'B', 'C'] as const) {
      const min = c.browser[`phase${p}MinDwellMs`];
      if (c.browser[`phase${p}HardCapMs`] < min) {
        issue(['browser', `phase${p}HardCapMs`], REASON.dwellOrder, {
          other: envName('browser', `phase${p}MinDwellMs`),
          value: min,
        });
      }
    }

    if (c.tls.expiringDays > c.tls.approachingDays) {
      issue(['tls', 'expiringDays'], REASON.tlsDaysOrder, {
        other: envName('tls', 'approachingDays'),
        value: c.tls.approachingDays,
      });
    }

    if (c.tls.expiringLifetimeShare > c.tls.approachingLifetimeShare) {
      issue(['tls', 'expiringLifetimeShare'], REASON.tlsShareOrder, {
        other: envName('tls', 'approachingLifetimeShare'),
        value: c.tls.approachingLifetimeShare,
      });
    }

    // The reserve for writing reports must outlast the grace period of the collectors and the PDF print.
    const needed = c.scan.abortGraceMs + c.pdf.timeoutMs;
    if (c.scan.reportWriteReserveMs < needed) {
      issue(['scan', 'reportWriteReserveMs'], REASON.reportReserve, {
        first: envName('scan', 'abortGraceMs'),
        second: envName('pdf', 'timeoutMs'),
        value: needed,
      });
    }
  });

export type Config = z.output<typeof ConfigSchema>;
/** Any subset of the settings, as callers of `scan()` pass it. */
export type ConfigInput = z.input<typeof ConfigSchema>;

export const SECTIONS = { scan, browser, http, tls, dns, cmp, legal, report, pdf } as const;
export type SectionName = keyof typeof SECTIONS;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** A fresh copy of the built-in defaults. */
export const defaultConfig = (): Config => ConfigSchema.parse({});

/** Built-in defaults, read-only: a scan works on its own copy. */
export const DEFAULT_CONFIG: Readonly<Config> = deepFreeze(defaultConfig());
