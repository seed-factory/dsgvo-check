/**
 * HTTP collector. Passive probes for TLS-01 and HDR-01:
 * - manual redirect chains (≤ 5 redirects, no HSTS cache, no cookies) for http:// and https:// of the target host,
 *   its www and its apex variant;
 * - main documents for headers: the start page (target chain) and Impressum / Datenschutz when the start page links
 *   to them on the same site (the browser plan is not available yet: http runs before the browser);
 * - meta / JS redirect and form heuristics on http pages (body prefix ≤ 64 KiB; bodies are never stored);
 * - a target URL with an explicit port: the start document comes from exactly that origin, which also decides
 *   reachability; the standard-port chains stay TLS-01 probes;
 * - the start page ends on a host outside target/www/apex: TLS handshakes with that host and its www/apex for
 *   TLS-02 (`finalTls`).
 * Pacing ≤ 2 requests/s per host; 429/503 per host with Retry-After pause and one retry; UA = token with
 * repository link.
 */

import { startFinalHost } from '../../checks/http/shared.ts';
import type { CollectorContext, HttpCollector } from '../../core/collector.ts';
import { errorMessage } from '../../core/errors.ts';
import { storedHeaderRecord } from '../../core/headers.ts';
import type { CollectorError, DiagnosticInput } from '../../core/snapshot.ts';
import type { HeaderRecord } from '../../core/snapshot-common.ts';
import { isSameSite, registrableDomain, sanitizeUrl } from '../../core/url.ts';
import { DEFAULT_TLS_TIMEOUT_MS, probeTlsEndpoint } from '../tls/probe.ts';
import type { TlsEndpoint } from '../tls/types.ts';
import {
  type ChainOutcome,
  type FetchResult,
  HttpClient,
  type HttpClientOptions,
  outcomeOf,
  ProbeError,
} from './client.ts';
import { type HostTarget, hostVariants } from './hosts.ts';
import { detectClientRedirect, detectForm, extractMeta, findLegalLinks, HEURISTIC_BYTES } from './html.ts';
import type {
  DocumentResponse,
  HostVariant,
  HttpHop,
  HttpSection,
  ProbeRecord,
  RedirectChain,
} from './types.ts';

export const MAX_REDIRECTS = 5;
/** Body read limit for the documents (link discovery on the start page); heuristics use the first 64 KiB. */
const DOCUMENT_READ_BYTES = 512 * 1024;

export interface HttpCollectorOptions {
  /** Pacing per host (default 500 ms = 2 requests/s). Tests may lower it. */
  minIntervalMs?: number;
  timeouts?: HttpClientOptions['timeouts'];
  /** Cap of the Retry-After pause (default 30 s). Tests may lower it. */
  maxRetryAfterMs?: number;
  /** Handshake budget for the final-host TLS probe. */
  tlsTimeoutMs?: number;
}

export { type HostTarget, hostVariants } from './hosts.ts';

function isHtml(contentType: string | null, body: Buffer): boolean {
  if (contentType) return /html|xml/i.test(contentType);
  return /^\s*</.test(body.subarray(0, 256).toString('latin1'));
}

const isRedirectStatus = (s: number) => [301, 302, 303, 307, 308].includes(s);

interface ChainRun {
  chain: RedirectChain;
  /** Final response (body prefix kept in memory only). */
  last: FetchResult | null;
}

function toHop(r: FetchResult): HttpHop {
  const html = isHtml(r.contentType, r.body);
  const hop: HttpHop = {
    url: sanitizeUrl(r.url),
    status: r.status,
    headers: r.headers,
    setCookieNames: r.setCookieNames,
    connectedIp: r.conn?.ip ?? null,
    bodyBytes: r.bodyBytes,
    bodyTruncated: r.bodyTruncated,
    bodyKind: r.bodyBytes === 0 ? 'empty' : html ? 'html' : 'other',
    durationMs: r.durationMs,
    requestedAt: r.requestedAt,
  };
  if (r.location) hop.location = sanitizeUrl(r.location);
  if (r.url.startsWith('https:')) {
    hop.tlsProtocol = r.conn?.protocol ?? null;
    hop.tlsAuthorized = r.conn?.authorized ?? null;
    hop.tlsAuthorizationError = r.conn?.authorizationError ?? null;
  }
  if (r.url.startsWith('http:') && r.status >= 200 && r.status < 300 && html) {
    const prefix = r.body.subarray(0, HEURISTIC_BYTES).toString('utf8');
    const client = detectClientRedirect(prefix, r.url);
    if (client) hop.clientRedirect = { kind: client.kind, url: client.url ? sanitizeUrl(client.url) : null };
    hop.hasForm = detectForm(prefix);
  }
  return hop;
}

function errorOf(err: unknown, url: string): CollectorError {
  const code = err instanceof ProbeError ? err.code : 'error';
  const outcome = outcomeOf(code);
  return {
    code: outcome === 'timeout' ? 'timeout' : code,
    message: errorMessage(err).slice(0, 300),
    phase: 'http',
    url: sanitizeUrl(url),
  };
}

async function followChain(
  client: HttpClient,
  startUrl: string,
  hostVariant: HostVariant,
  id: string,
): Promise<ChainRun> {
  const u = new URL(startUrl);
  const chain: RedirectChain = {
    id,
    hostVariant,
    host: u.hostname,
    scheme: u.protocol === 'https:' ? 'https' : 'http',
    startUrl: sanitizeUrl(startUrl),
    hops: [],
    final: null,
    outcome: 'ok',
  };
  let url = startUrl;
  let last: FetchResult | null = null;
  for (let i = 0; ; i++) {
    let r: FetchResult;
    try {
      r = await client.get(url, DOCUMENT_READ_BYTES);
    } catch (err) {
      chain.outcome = outcomeOf(err instanceof ProbeError ? err.code : 'error') as ChainOutcome;
      chain.error = errorOf(err, url);
      return { chain, last: null };
    }
    const hop = toHop(r);
    chain.hops.push(hop);
    last = r;
    if (isRedirectStatus(r.status) && r.location) {
      const next = new URL(r.location);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        chain.outcome = 'error';
        chain.error = { code: 'unsupported-redirect', message: next.protocol, phase: 'http', url: hop.url };
        return { chain, last: null };
      }
      if (i >= MAX_REDIRECTS) {
        chain.outcome = 'redirect-limit';
        return { chain, last: null };
      }
      url = next.href;
      continue;
    }
    chain.final = hop;
    return { chain, last };
  }
}

/**
 * A `<meta http-equiv>` as stored (AGENTS rule 2): reduced like the response header of the same name, which
 * keeps the URLs sanitized, a value outside the allowlist `[redacted]` (a `set-cookie` meta never keeps its value).
 * A meta CSP has no effect on `frame-ancestors`, so the derived fact is not stored with it.
 */
function storedMeta(meta: HeaderRecord, base: string): HeaderRecord {
  const { frameAncestors: _fact, ...record } = storedHeaderRecord(meta.name, meta.value, base, sanitizeUrl);
  return record;
}

/** The shape of a stored `<meta http-equiv>` name: a header name (HDR-01 reads `content-security-policy`). */
const META_NAME = /^[a-z][a-z0-9._-]{0,39}$/;
/** Limit for ordinary records; CSP remains available to the security-header check regardless of document order. */
const MAX_META_HTTP_EQUIV = 32;

/**
 * The `<meta http-equiv>` records of the start document as stored. The name is untrusted text of the page,
 * and `storedMeta` edits only the value: a name of 30 000 characters, or one with an address in it, went into the
 * snapshot as written, and so did every one of 1 500 distinct short names. A name that has not the shape of a header
 * name is not stored. The first 32 valid records are stored in document order.
 */
export function storedMetaHttpEquiv(records: readonly HeaderRecord[], base: string): HeaderRecord[] {
  const out: HeaderRecord[] = [];
  for (const record of records) {
    if (!META_NAME.test(record.name.toLowerCase())) continue;
    out.push(storedMeta(record, base));
    if (out.length === MAX_META_HTTP_EQUIV) break;
  }
  return out;
}

/**
 * The Referrer-Policy keywords (W3C Referrer Policy §3) HDR-01 recognises (`effectiveReferrerPolicy`; a unit test pins
 * the two lists together). The old `<meta name="referrer">` values (`never`, `default`, `always`,
 * `origin-when-crossorigin`) are not among them: the check does not read them, so they are not stored.
 */
const REFERRER_KEYWORDS: ReadonlySet<string> = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);
/** The policy in force is the last recognised keyword, so a longer list keeps its last ones. */
const MAX_REFERRER_KEYWORDS = 8;

/**
 * The referrer policy of a `<meta name="referrer">` as stored: its Referrer-Policy keywords as written, comma
 * separated, the last eight at most, nothing else the tag may say. A tag is untrusted text of any size: every token
 * that looked like a word (`a, a, a, …`) used to be kept, which grew a 64 KiB tag into a 96 KiB snapshot value.
 */
export function storedMetaReferrer(content: string | null): string | null {
  const text = content ?? '';
  const kept: string[] = [];
  for (let from = 0; from <= text.length; ) {
    const comma = text.indexOf(',', from);
    const end = comma < 0 ? text.length : comma;
    const token = text.slice(from, end).trim();
    if (REFERRER_KEYWORDS.has(token.toLowerCase())) {
      kept.push(token);
      if (kept.length > MAX_REFERRER_KEYWORDS) kept.shift();
    }
    from = end + 1;
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

function documentFrom(
  role: DocumentResponse['role'],
  run: ChainRun,
  foundVia: 'target' | 'link',
): DocumentResponse {
  const lastHop = run.chain.hops.at(-1) ?? null;
  const final = run.chain.final;
  const doc: DocumentResponse = {
    role,
    url: run.chain.startUrl,
    finalUrl: (final ?? lastHop)?.url ?? run.chain.startUrl,
    status: (final ?? lastHop)?.status ?? null,
    headers: final?.headers ?? [],
    setCookieNames: final?.setCookieNames ?? [],
    metaHttpEquiv: [],
    metaReferrer: null,
    chainId: run.chain.id,
    foundVia,
  };
  if (final) {
    doc.tlsAuthorized = final.tlsAuthorized ?? null;
    doc.tlsAuthorizationError = final.tlsAuthorizationError ?? null;
  }
  if (run.last && isHtml(run.last.contentType, run.last.body)) {
    const meta = extractMeta(run.last.body.subarray(0, HEURISTIC_BYTES).toString('utf8'));
    doc.metaHttpEquiv = storedMetaHttpEquiv(meta.httpEquiv, run.last?.url ?? run.chain.startUrl);
    doc.metaReferrer = storedMetaReferrer(meta.referrer);
  }
  if (!final) {
    doc.error = run.chain.error ?? {
      code: run.chain.outcome,
      message: `chain ended with ${run.chain.outcome}`,
      phase: 'http',
      url: run.chain.startUrl,
    };
  }
  return doc;
}

/** Standard-port probe (80 / 443) of a host variant; the target keeps its path. */
function startUrlFor(ctx: CollectorContext, t: HostTarget, scheme: 'http' | 'https'): string {
  if (t.hostVariant === 'target') {
    const u = new URL(ctx.target.url);
    u.protocol = `${scheme}:`;
    u.port = '';
    return u.href;
  }
  return `${scheme}://${t.host}/`;
}

/** Explicit non-default port of the target URL, else null. */
function explicitPort(url: string): number | null {
  const port = new URL(url).port;
  return port ? Number(port) : null;
}

const unreachable = (c: RedirectChain | undefined) =>
  !c || (c.hops.length === 0 && ['connection-refused', 'dns-error', 'timeout'].includes(c.outcome));

/**
 * The start page ended on a host outside target/www/apex (redirect to another registrable domain). The TLS
 * collector runs in parallel and cannot know it, so its certificate (and that of its www/apex) is probed here with
 * the same TLS probe; TLS-02 reads `HttpSection.finalTls`. A TLS handshake only, no HTTP request.
 */
async function probeFinalHost(
  ctx: CollectorContext,
  section: Pick<HttpSection, 'chains' | 'documents'>,
  known: readonly HostTarget[],
  timeoutMs: number,
): Promise<{ endpoints: TlsEndpoint[]; probes: ProbeRecord[] } | null> {
  const finalHost = startFinalHost(section);
  if (!finalHost || known.some((t) => t.host.toLowerCase() === finalHost)) return null;
  const start = section.documents.find((d) => d.role === 'start');
  let finalPort = 443;
  try {
    const u = new URL(start?.finalUrl ?? '');
    if (u.protocol === 'https:' && u.hostname.toLowerCase() === finalHost && u.port)
      finalPort = Number(u.port);
  } catch {
    finalPort = 443;
  }
  // Hosts the TLS collector already covers (e.g. the www/apex of a sibling subdomain) are not probed twice.
  const targets = hostVariants(finalHost, registrableDomain(finalHost))
    .filter((t) => !known.some((k) => k.host.toLowerCase() === t.host.toLowerCase()))
    .map((t) => ({ ...t, port: t.hostVariant === 'target' ? finalPort : 443 }));
  const endpoints = await Promise.all(
    targets.map((t) => probeTlsEndpoint(ctx, t, t.port, timeoutMs, 'final')),
  );
  const probes: ProbeRecord[] = targets.map((t) => ({
    kind: 'tls',
    class: 'T',
    target: `${t.host}:${t.port}`,
    // Same purpose as the TLS collector's handshakes (canary/README.md rule 1 lists probe purposes).
    purpose: 'certificate',
  }));
  return { endpoints, probes };
}

export function createHttpCollector(opts: HttpCollectorOptions = {}): HttpCollector {
  return async (ctx) => {
    const client = new HttpClient({
      network: ctx.network,
      userAgent: ctx.userAgent.http,
      signal: ctx.signal,
      now: ctx.now,
      ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.maxRetryAfterMs !== undefined ? { maxRetryAfterMs: opts.maxRetryAfterMs } : {}),
    });
    const probes: ProbeRecord[] = [];
    const probe = (target: string, purpose: string) =>
      probes.push({ kind: 'http', class: 'T', target: sanitizeUrl(target), purpose });
    try {
      const targets = hostVariants(ctx.target.host, ctx.target.etld1);
      const port = explicitPort(ctx.target.url);
      const runs = (
        await Promise.all([
          ...targets.map(async (t) => {
            const out: ChainRun[] = [];
            for (const scheme of ['http', 'https'] as const) {
              const start = startUrlFor(ctx, t, scheme);
              probe(start, 'redirect-chain');
              out.push(await followChain(client, start, t.hostVariant, `chain-${t.hostVariant}-${scheme}`));
            }
            return out;
          }),
          // A target with an explicit port is loaded from exactly that origin (start document, reachability).
          ...(port === null
            ? []
            : [
                (async () => {
                  probe(ctx.target.url, 'redirect-chain');
                  const run = await followChain(client, ctx.target.url, 'target', `chain-target-origin`);
                  run.chain.port = port;
                  return [run];
                })(),
              ]),
        ])
      ).flat();

      const startRun = runs.find((r) =>
        port === null
          ? r.chain.hostVariant === 'target' &&
            r.chain.scheme === ctx.target.scheme &&
            r.chain.port === undefined
          : r.chain.port === port,
      ) as ChainRun;
      const documents: DocumentResponse[] = [documentFrom('start', startRun, 'target')];

      const start = startRun.last;
      if (start && start.status >= 200 && start.status < 300 && isHtml(start.contentType, start.body)) {
        const links = findLegalLinks(start.body.toString('utf8'), start.url);
        for (const role of ['impressum', 'privacy'] as const) {
          const href = links[role];
          if (!href || !isSameSite(new URL(href).hostname, ctx.target.host)) continue;
          probe(href, `security-headers:${role}`);
          documents.push(
            documentFrom(role, await followChain(client, href, 'target', `doc-${role}`), 'link'),
          );
        }
      }

      const chains = runs.map((r) => r.chain);
      const errors = chains.flatMap((c) => (c.error ? [c.error] : []));
      const final = ctx.signal.aborted
        ? null
        : await probeFinalHost(
            ctx,
            { chains, documents },
            targets,
            opts.tlsTimeoutMs ?? DEFAULT_TLS_TIMEOUT_MS,
          );
      if (final) probes.push(...final.probes);
      const section: HttpSection = {
        userAgent: ctx.userAgent.http,
        chains,
        documents,
        requestsIssued: client.requestsIssued,
        throttled: client.throttled,
        ...(client.throttled ? { throttledHosts: client.throttledHosts } : {}),
        ...(final ? { finalTls: final.endpoints } : {}),
        errors,
      };
      const diagnostics: DiagnosticInput[] = client.throttled
        ? [{ code: 'SCAN-THROTTLED', affects: ['HDR-01', 'TLS-01'] }]
        : [];

      const standard = (scheme: 'http' | 'https') =>
        chains.find((c) => c.hostVariant === 'target' && c.scheme === scheme && c.port === undefined);
      const http = standard('http');
      const https = standard('https');
      // With an explicit port only that origin decides reachability; the standard ports are extra probes.
      const down = port === null ? unreachable(http) && unreachable(https) : unreachable(startRun.chain);
      const fatal =
        !ctx.signal.aborted && down
          ? {
              reason: 'unreachable' as const,
              code: 'start-page-unreachable',
              message:
                port === null
                  ? `${ctx.target.host} antwortet weder über http noch über https (${http?.outcome}/${https?.outcome}).`
                  : `${sanitizeUrl(ctx.target.url)} antwortet nicht (${startRun.chain.outcome}).`,
            }
          : undefined;

      return {
        status: client.throttled || ctx.signal.aborted ? 'partial' : 'ok',
        ...(client.throttled ? { reason: 'throttled' } : {}),
        sections: { http: section },
        probes,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        ...(fatal ? { fatal } : {}),
      };
    } catch (err) {
      ctx.log.error(`http collector: ${errorMessage(err)}`);
      return {
        status: 'error',
        reason: 'exception',
        sections: {},
        probes,
        error: { code: 'http-collector-exception', message: errorMessage(err), phase: 'http' },
      };
    } finally {
      await client.close();
    }
  };
}

export const collectHttp: HttpCollector = createHttpCollector();
