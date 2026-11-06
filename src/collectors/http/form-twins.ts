// After the browser: the http:// address of pages on which phase A saw a form that takes data, requested once each with
// GET (no redirect followed, nothing submitted), so that TLS-01 sees a form that plain http serves beyond the root of a
// host, such as the comment form of an article. Only on a host whose http:// root ended on a page served over http:
// where the root already redirects to https, its pages do so too and the request would be one more for nothing. At most
// `http.formTwinPages` pages, paced like every HTTP probe (≤ 2 requests per second and host).

import { isSuccess } from '../../checks/http/shared.ts';
import type { FormFact, PageVisit } from '../../core/snapshot/browser.ts';
import type { CollectorContext, HttpCollector } from '../../core/snapshot/collector.ts';
import type {
  FormTwinStage,
  HttpSection,
  HttpTwin,
  ProbeRecord,
  RedirectChain,
} from '../../core/snapshot/http.ts';
import type { Snapshot } from '../../core/snapshot/index.ts';
import { REDACTED } from '../../core/url/email.ts';
import { parseUrl, sanitizeUrl } from '../../core/url/url.ts';
import { httpChallenge } from './challenge.ts';
import type { HttpClient } from './client.ts';
import { outcomeOf, ProbeError } from './errors.ts';
import { createClient, DOCUMENT_READ_BYTES, errorOf, type HttpCollectorOptions, toHop } from './index.ts';

export interface FormTwinCandidate {
  /** The page as phase A stored it. */
  page: string;
  /** Its http:// address. */
  url: string;
}

/** A form that takes input other than a site search, as phase A read it (the HTTP collector's rule on markup). */
const takesData = (f: FormFact): boolean => f.takesInput === true;

/** Contact, comment, newsletter and login forms come before other forms that take input (a shop's quantity fields). */
const asksForAddress = (f: FormFact): boolean => f.hasEmailField || f.hasPasswordField;

/** Where the stored address was redacted, it is no longer the address of the page. */
const REDACTION_MARKS = [REDACTED, encodeURIComponent(REDACTED)].map((m) => m.toLowerCase());

/** Answers after which the step sends nothing more to the host, so that it never reaches the client's retry. */
const OVERLOAD_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * The plain-http probe of the host's root (`/`) ended on a page served over http: no redirect to https. The target's
 * chain keeps the path of the scanned URL; an address other than the root does not speak for the host.
 */
function rootServesHttp(chain: RedirectChain): boolean {
  if (chain.scheme !== 'http' || chain.port !== undefined || chain.outcome !== 'ok') return false;
  const start = parseUrl(chain.startUrl);
  if (start?.pathname !== '/' || start.search !== '') return false;
  const last = chain.hops.at(-1);
  return last?.url.startsWith('http:') === true && isSuccess(last.status);
}

/**
 * The http:// address of a page, or null. The stored address is sanitized: with a query, a port, credentials or a
 * redacted part it is not the one the page has, and the probes cover only the standard port.
 */
function twinUrl(stored: string): string | null {
  const u = parseUrl(stored, undefined, true);
  if (!u) return null;
  if (u.search !== '' || u.port !== '' || u.username !== '' || u.password !== '') return null;
  const lower = stored.toLowerCase();
  if (REDACTION_MARKS.some((m) => lower.includes(m))) return null;
  u.protocol = 'http:';
  u.hash = '';
  return u.href;
}

function phaseAPages(snapshot: Pick<Snapshot, 'browser'>): readonly PageVisit[] {
  return snapshot.browser?.phases.find((p) => p.phase === 'A')?.pages ?? [];
}

/** Pages whose http:// address the step may request, forms asking for an address first, otherwise in visit order. */
export function selectFormTwins(snapshot: Pick<Snapshot, 'http' | 'browser'>): FormTwinCandidate[] {
  const http = snapshot.http;
  if (!http || !snapshot.browser) return [];

  const serving = new Set(http.chains.filter(rootServesHttp).map((c) => c.host.toLowerCase()));
  // A host that throttled the HTTP collector gets no further request in this scan.
  const stopped = new Set((http.throttledHosts ?? []).map((h) => h.toLowerCase()));
  // Addresses the HTTP collector already requested: the roots and the linked legal documents.
  const known = new Set([
    ...http.chains.flatMap((c) => c.hops.map((h) => h.url)),
    ...http.documents.flatMap((d) => [d.url, d.finalUrl]),
  ]);

  const seen = new Set<string>();
  const first: FormTwinCandidate[] = [];
  const rest: FormTwinCandidate[] = [];
  for (const page of phaseAPages(snapshot)) {
    if (!page.evaluable || page.dom === null || page.challenge?.detected) continue;
    const forms = page.dom.forms.filter(takesData);
    if (forms.length === 0) continue;

    const url = twinUrl(page.finalUrl);
    if (url === null || known.has(url) || seen.has(url)) continue;
    const host = new URL(url).hostname.toLowerCase();
    if (!serving.has(host) || stopped.has(host)) continue;

    seen.add(url);
    (forms.some(asksForAddress) ? first : rest).push({ page: page.finalUrl, url });
  }
  return [...first, ...rest];
}

type TwinOutcome = HttpTwin['outcome'];

const twinBase = (c: FormTwinCandidate) => ({ page: sanitizeUrl(c.page), url: sanitizeUrl(c.url) });

/** A candidate left out because its host answered an earlier request of the step with 429 or 503. */
function notRequested(c: FormTwinCandidate): HttpTwin {
  const message = 'not requested: the host answered an earlier request of this step with 429 or 503';
  return {
    ...twinBase(c),
    hop: null,
    outcome: 'throttled',
    error: { code: 'throttled', message, phase: 'http', url: sanitizeUrl(c.url) },
  };
}

async function requestTwin(client: HttpClient, c: FormTwinCandidate): Promise<HttpTwin> {
  const base = twinBase(c);
  try {
    const r = await client.get(c.url, DOCUMENT_READ_BYTES);
    const challenge = httpChallenge(r);
    return { ...base, hop: toHop(r), outcome: 'ok', ...(challenge ? { challenge: challenge.kind } : {}) };
  } catch (err) {
    const code = err instanceof ProbeError ? err.code : 'error';
    return { ...base, hop: null, outcome: outcomeOf(code) as TwinOutcome, error: errorOf(err, c.url) };
  }
}

// The requests count with the collector's; `throttled` stays the HTTP collector's, since HDR-01 reads it for the
// documents, and a twin answered with 429 or 503 is undecided on its own (TLS-01).
function withTwins(
  first: HttpSection,
  twins: HttpTwin[],
  stage: FormTwinStage,
  client: HttpClient | null,
): HttpSection {
  const requestsIssued = first.requestsIssued + (client?.requestsIssued ?? 0);
  return { ...first, twins, formTwinStage: stage, requestsIssued };
}

export function createFormTwinCollector(opts: HttpCollectorOptions = {}): HttpCollector {
  return async (ctx: CollectorContext) => {
    const first = ctx.snapshot.http;
    if (!first || !ctx.snapshot.browser)
      return { status: 'skipped', reason: 'no-browser-section', sections: {} };

    const t0 = performance.now();
    const budget = ctx.config.http.formTwinPages;
    const candidates = selectFormTwins(ctx.snapshot);
    const chosen = candidates.slice(0, budget);
    const stage = (error?: FormTwinStage['error']): FormTwinStage => ({
      budget,
      candidates: candidates.length,
      durationMs: Math.round(performance.now() - t0),
      ...(error ? { error } : {}),
    });

    if (chosen.length === 0) return { status: 'ok', sections: { http: withTwins(first, [], stage(), null) } };
    if (ctx.signal.aborted) {
      const error = {
        code: 'timeout',
        message: 'scan deadline reached before the step',
        phase: 'http' as const,
      };
      return {
        status: 'partial',
        reason: 'timeout',
        sections: { http: withTwins(first, [], stage(error), null) },
      };
    }

    const client = createClient(ctx, opts);
    const probes: ProbeRecord[] = [];
    try {
      const twins: HttpTwin[] = [];
      const overloaded = new Set<string>();
      for (const c of chosen) {
        const host = new URL(c.url).hostname.toLowerCase();
        if (overloaded.has(host)) {
          twins.push(notRequested(c));
          continue;
        }
        probes.push({ kind: 'http', class: 'T', target: sanitizeUrl(c.url), purpose: 'form-twin' });
        const twin = await requestTwin(client, c);
        twins.push(twin);
        if (OVERLOAD_STATUSES.has(twin.hop?.status ?? 0)) overloaded.add(host);
      }
      ctx.log.debug(
        `http:// addresses of pages with a form: ${twins.length} of ${candidates.length} requested`,
      );

      return {
        status: twins.some((t) => t.outcome !== 'ok') ? 'partial' : 'ok',
        sections: { http: withTwins(first, twins, stage(), client) },
        probes,
      };
    } finally {
      await client.close();
    }
  };
}

export const collectHttpFormTwins: HttpCollector = createFormTwinCollector();
