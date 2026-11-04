/**
 * Factories for snapshot sections, a deterministic CheckContext and fixture loading. Every factory takes a partial
 * override; nested arrays are replaced, not merged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CmpFacts, CmpSection } from '../../src/cmp/types.ts';
import { defaultConfig } from '../../src/core/config/schema.ts';
import { checkThresholds } from '../../src/core/config/thresholds.ts';
import { loadDataDir, loadRouting } from '../../src/core/data/load.ts';
import type { ExecutedCheck } from '../../src/core/evaluation/assess.ts';
import type { AnyCheck, CheckContext, CheckOutcome, Observation } from '../../src/core/evaluation/check.ts';
import { executeCheck } from '../../src/core/evaluation/execute.ts';
import type { CheckStatus } from '../../src/core/report/schema.ts';
import type {
  BrowserPlan,
  BrowserSection,
  CookieRecord,
  DocumentRecord,
  DomFacts,
  LinkFact,
  PageVisit,
  PhaseRecord,
  RequestRecord,
  StorageRecord,
} from '../../src/core/snapshot/browser.ts';
import type { DnsQueryRecord, DnsSection } from '../../src/core/snapshot/dns.ts';
import type { DocumentResponse, HttpHop, HttpSection, RedirectChain } from '../../src/core/snapshot/http.ts';
import { SNAPSHOT_VERSION, type Snapshot, type TargetInfo } from '../../src/core/snapshot/index.ts';
import type { CertificateInfo, TlsEndpoint, TlsSection } from '../../src/core/snapshot/tls.ts';
import { parseTarget } from '../../src/core/url/url.ts';
import { derive } from '../../src/derive/index.ts';
import type { DerivedSection } from '../../src/derive/types.ts';

export const FIXED_NOW = new Date('2026-10-30T12:00:00.000Z');
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SNAPSHOT_FIXTURES_DIR = path.join(REPO_ROOT, 'test/fixtures/snapshots');

export function makeTarget(url = 'https://www.example.de/', finalUrl: string | null = url): TargetInfo {
  const t = parseTarget(url);
  return { ...t, finalUrl, finalHost: finalUrl ? new URL(finalUrl).hostname : null };
}

/** Full snapshot with defaults; pass sections you need. `collection` defaults to `ok` for every given section. */
export function makeSnapshot(partial: Partial<Snapshot> = {}): Snapshot {
  const target = partial.target ?? makeTarget();

  const collection: Snapshot['collection'] = {};
  if (partial.browser || partial.documents || partial.cmp)
    collection.browser = { status: 'ok', durationMs: 0 };
  if (partial.http) collection.http = { status: 'ok', durationMs: 0 };
  if (partial.tls) collection.tls = { status: 'ok', durationMs: 0 };
  if (partial.dns) collection.dns = { status: 'ok', durationMs: 0 };

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    tool: { name: 'dsgvo-check', version: '0.0.0-test' },
    createdAt: FIXED_NOW.toISOString(),
    options: { maxPages: 6, screenshots: false, assumeRegion: null, proxy: false },
    environment: {
      egress: { mode: 'direct', region: 'unknown', source: 'nicht festgestellt' },
      sandbox: { mode: 'require', active: true },
      userAgent: { http: 'dsgvo-check/test', browser: 'Mozilla/5.0 Chrome/156.0.0.0 dsgvo-check/test' },
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
      node: 'v24.0.0',
      platform: 'test',
    },
    plan: { browser: null, probes: [] },
    diagnostics: [],
    ...partial,
    target,
    collection: { ...collection, ...partial.collection },
  };
}

/** Snapshot plus `derived` computed by the real derive (as the orchestrator does when `browser` exists). */
export function withDerived(snapshot: Snapshot, derived?: Partial<DerivedSection>): Snapshot {
  const base = snapshot.browser ? derive(snapshot) : makeDerived({}, snapshot.target);
  return { ...snapshot, derived: { ...base, ...derived } };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

export function makeRequest(p: Partial<RequestRecord> & { url: string }): RequestRecord {
  const host = new URL(p.url).hostname;
  return {
    id: p.id ?? nextId(p.phase ?? 'A'),
    phase: 'A',
    pageUrl: 'https://www.example.de/',
    isNavigation: false,
    isMainFrame: true,
    host,
    method: 'GET',
    resourceType: 'script',
    tStartMs: 100,
    tRef: 'navigation',
    afterClick: false,
    state: 'completed',
    status: 200,
    identifierPresent: false,
    ...p,
  };
}

export function makeCookie(p: Partial<CookieRecord> & { name: string }): CookieRecord {
  return {
    domain: 'www.example.de',
    firstParty: true,
    path: '/',
    partitionKey: null,
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
    lifetime: { kind: 'persistent', days: 365 },
    length: 20,
    setter: 'script',
    state: 'accepted',
    phase: 'A',
    pageUrl: 'https://www.example.de/',
    afterClick: false,
    ...p,
  };
}

export function makeStorage(p: Partial<StorageRecord> & { key: string }): StorageRecord {
  return {
    storageType: 'localStorage',
    origin: 'https://www.example.de',
    firstParty: true,
    length: 10,
    phase: 'A',
    pageUrl: 'https://www.example.de/',
    afterClick: false,
    ...p,
  };
}

export function makeLink(p: Partial<LinkFact> & { text: string }): LinkFact {
  return {
    href: null,
    hrefKind: 'https',
    region: 'footer',
    visible: true,
    inShadowDom: false,
    ...p,
  };
}

export function makeDom(p: Partial<DomFacts> = {}): DomFacts {
  return { links: [], forms: [], iframes: [], linkRels: [], scripts: [], ...p };
}

export function makePage(p: Partial<PageVisit> & { url: string }): PageVisit {
  return {
    finalUrl: p.url,
    role: 'start',
    order: 0,
    phase: 'A',
    firstVisit: p.role === undefined || p.role === 'start',
    navigation: {
      status: 200,
      ok: true,
      redirectChain: [],
      startedAt: FIXED_NOW.toISOString(),
      quietReached: true,
      dwellMs: 6000,
    },
    responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
    setCookieNames: [],
    challenge: { detected: false, signals: [] },
    evaluable: true,
    dom: makeDom(),
    ...p,
  };
}

export function makePhase(phase: PhaseRecord['phase'], p: Partial<PhaseRecord> = {}): PhaseRecord {
  return {
    phase,
    status: 'completed',
    startedAt: FIXED_NOW.toISOString(),
    durationMs: 1000,
    profile: 'persistent-tmp',
    pages: [],
    requests: [],
    cookies: [],
    storage: [],
    errors: [],
    ...p,
  };
}

export function makeBrowser(p: Partial<BrowserSection> = {}): BrowserSection {
  return {
    engine: {
      name: 'chromium',
      channel: 'chromium',
      version: '156.0.8078.4',
      headless: 'new',
      userAgent: 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36 dsgvo-check/test',
      sandbox: true,
      disabledFeatures: [],
    },
    viewport: { width: 1366, height: 768 },
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    phases: [],
    requestCap: { limit: 2000, issued: 0, truncated: false },
    screenshots: [],
    knownGaps: [],
    errors: [],
    ...p,
  };
}

export function makeBrowserPlan(p: Partial<BrowserPlan> = {}): BrowserPlan {
  return { pages: [], controlPages: [], click: {}, ...p };
}

export function makeDocument(p: Partial<DocumentRecord> & { kind: DocumentRecord['kind'] }): DocumentRecord {
  const url = p.url ?? `https://www.example.de/${p.kind === 'privacy' ? 'datenschutz' : 'impressum'}`;
  return {
    id: p.id ?? `doc-${p.kind}`,
    url,
    finalUrl: url,
    status: 200,
    foundVia: 'link',
    linkedFrom: [],
    phase: 'B',
    format: 'html',
    lang: 'de',
    parts: [],
    manifest: { expandablesFound: 0, expandablesOpened: 0, framesIncluded: 0, linkedPages: 0, textLength: 0 },
    complete: true,
    errors: [],
    sha256: null,
    ...p,
  };
}

export function makeCmpFacts(p: Partial<CmpFacts> = {}): CmpFacts {
  return {
    phase: 'B',
    pageUrl: 'https://www.example.de/',
    moment: 'first-screen',
    takenAt: FIXED_NOW.toISOString(),
    viewport: { width: 1366, height: 768 },
    detection: {
      cmpId: null,
      method: 'none',
      version: null,
      versionSupported: null,
      recognitionConfidence: 'low',
      signals: [],
    },
    firstLayer: {
      bannerPresent: false,
      bannerVisible: false,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
    },
    blocking: { overlay: false, scrollLock: false, inert: false, coveredRatio: null, method: [] },
    state: [],
    geoSignals: [],
    botSignals: [],
    config: {},
    ...p,
  };
}

export function makeCmp(p: Partial<CmpSection> = {}): CmpSection {
  return { phases: [], ...p };
}

export function makeHop(p: Partial<HttpHop> & { url: string }): HttpHop {
  return {
    status: 200,
    headers: [],
    setCookieNames: [],
    durationMs: 20,
    requestedAt: FIXED_NOW.toISOString(),
    ...p,
  };
}

export function makeChain(p: Partial<RedirectChain> & { startUrl: string }): RedirectChain {
  const u = new URL(p.startUrl);
  return {
    id: p.id ?? nextId('chain'),
    hostVariant: 'target',
    host: u.hostname,
    scheme: u.protocol === 'https:' ? 'https' : 'http',
    hops: [],
    final: null,
    outcome: 'ok',
    ...p,
  };
}

export function makeDocumentResponse(p: Partial<DocumentResponse> & { url: string }): DocumentResponse {
  return {
    role: 'start',
    finalUrl: p.url,
    status: 200,
    headers: [],
    setCookieNames: [],
    metaHttpEquiv: [],
    ...p,
  };
}

export function makeHttp(p: Partial<HttpSection> = {}): HttpSection {
  return {
    userAgent: 'dsgvo-check/test',
    chains: [],
    documents: [],
    requestsIssued: 0,
    throttled: false,
    errors: [],
    ...p,
  };
}

export function makeCert(p: Partial<CertificateInfo> = {}): CertificateInfo {
  return {
    subject: 'CN=www.example.de',
    issuer: 'CN=dsgvo-check Test CA',
    subjectAltNames: ['DNS:www.example.de', 'DNS:example.de'],
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z',
    serialNumber: '01',
    fingerprint256: '00',
    isCa: false,
    selfSigned: false,
    ...p,
  };
}

export function makeTlsEndpoint(p: Partial<TlsEndpoint> = {}): TlsEndpoint {
  const host = p.host ?? 'www.example.de';
  return {
    id: p.id ?? nextId('tls'),
    hostVariant: 'target',
    host,
    port: 443,
    servername: host,
    ip: '203.0.113.10',
    family: 4,
    outcome: 'handshake',
    protocol: 'TLSv1.3',
    cipher: 'TLS_AES_128_GCM_SHA256',
    authorized: true,
    authorizationError: null,
    hostnameMatches: true,
    chainComplete: true,
    trustStore: 'node-bundled',
    chain: [makeCert()],
    observedAt: FIXED_NOW.toISOString(),
    ...p,
  };
}

export function makeTls(p: Partial<TlsSection> = {}): TlsSection {
  return { endpoints: [], errors: [], ...p };
}

export function makeDnsQuery(p: Partial<DnsQueryRecord> & { qname: string }): DnsQueryRecord {
  return {
    id: p.id ?? nextId('dns'),
    type: 'TXT',
    rcode: 'NOERROR',
    answers: [],
    attempts: 1,
    durationMs: 5,
    queriedAt: FIXED_NOW.toISOString(),
    purpose: 'other',
    ...p,
  };
}

export function makeDns(p: Partial<DnsSection> = {}): DnsSection {
  return {
    resolver: { kind: 'system', servers: [] },
    domain: 'example.de',
    queries: [],
    budget: { limit: 60, used: 0 },
    errors: [],
    ...p,
  };
}

export function makeDerived(
  p: Partial<DerivedSection> = {},
  target: TargetInfo = makeTarget(),
): DerivedSection {
  const host = target.finalHost ?? target.host;
  return {
    catalogVersion: null,
    datasets: [],
    target: { host, etld1: target.etld1 },
    requests: [],
    cookies: [],
    storage: [],
    services: [],
    catalog: {},
    ...p,
  };
}

let routingCache: Record<string, string> | null = null;

/** Deterministic context (fixed clock, de, real routing.yaml, data dirs loaded from test/data/ on demand). */
export function checkContext(p: Partial<CheckContext> & { dataDirs?: readonly string[] } = {}): CheckContext {
  routingCache ??= loadRouting();
  const data: Record<string, unknown> = { ...p.data };
  for (const name of p.dataDirs ?? []) data[name] ??= loadDataDir(name);

  return {
    now: FIXED_NOW,
    lang: 'de',
    routing: routingCache,
    options: { strict: false, assumeRegion: null, fromSnapshot: false },
    thresholds: checkThresholds(defaultConfig()),
    ...p,
    data,
  };
}

/** Run a check like the orchestrator does (missing sections / exceptions mapped to statuses). */
export function runCheck(check: AnyCheck, snapshot: Snapshot, ctx?: Partial<CheckContext>): ExecutedCheck {
  return executeCheck(check, snapshot, checkContext({ ...ctx, dataDirs: check.data ?? [] }));
}

/** Observations of a completed run (throws when the check did not produce an outcome). */
export function observationsOf(result: ExecutedCheck): Observation[] {
  if (!result.outcome) throw new Error(`check produced no outcome: ${result.status} ${result.reason ?? ''}`);
  return result.outcome.observations;
}

export function variantsOf(result: ExecutedCheck): string[] {
  return [...new Set((result.outcome?.observations ?? []).map((o) => o.variant))].sort();
}

/** Expected result stored in a fixture file under `$expect`. */
export interface FixtureExpect {
  status: CheckStatus;
  /** Sorted unique variants emitted. Default []. */
  variants?: string[];
  reason?: string;
}

export interface SnapshotFixture {
  file: string;
  name: string;
  kind: 'violation' | 'clean' | 'inconclusive' | 'error' | 'other';
  snapshot: Snapshot;
  expect: FixtureExpect | null;
  description?: string;
}

const FIXTURE_KINDS = ['violation', 'clean', 'inconclusive', 'error'] as const;

export function fixtureDir(module: string, checkId: string): string {
  return path.join(SNAPSHOT_FIXTURES_DIR, module, checkId);
}

export function fixtureFiles(module: string, checkId: string): string[] {
  try {
    return readdirSync(fixtureDir(module, checkId))
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Fixture file = partial Snapshot JSON (missing parts filled by makeSnapshot) plus optional
 * `$expect: {status, variants?, reason?}` and `$description`. `derived` is recomputed unless given.
 */
export function loadFixture(module: string, checkId: string, file: string): SnapshotFixture {
  const full = path.join(fixtureDir(module, checkId), file);
  return fixtureFrom(file, JSON.parse(readFileSync(full, 'utf8')) as RawFixture, full);
}

/** Fixture content as stored: a partial Snapshot plus `$expect` and `$description`. */
export type RawFixture = Partial<Snapshot> & { $expect?: FixtureExpect; $description?: string };

/** A fixture from its parsed content; `file` names it in messages (a path, or the scenario source). */
export function fixtureFrom(name: string, raw: RawFixture, file: string): SnapshotFixture {
  const { $expect, $description, ...partial } = raw;
  let snapshot = makeSnapshot(partial);
  if (!partial.derived && snapshot.browser) snapshot = withDerived(snapshot);

  const kind = FIXTURE_KINDS.find((k) => name.startsWith(k)) ?? 'other';
  return {
    file,
    name,
    kind,
    snapshot,
    expect: $expect ?? null,
    ...($description ? { description: $description } : {}),
  };
}

export function loadFixtures(module: string, checkId: string): SnapshotFixture[] {
  return fixtureFiles(module, checkId).map((f) => loadFixture(module, checkId, f));
}

export type { CheckOutcome };
