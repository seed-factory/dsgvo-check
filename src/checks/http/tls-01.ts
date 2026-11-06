/**
 * TLS-01: does `http://` of the host, www and apex lead to https? A closed port is not "serving content", a stub of
 * ≤ 1 KiB gives no finding, a timeout is inconclusive. When the browser ran, same-site links of phase A that ask for
 * `http://` are reported per linked host (tls-01-links.ts); without the browser the http entries are evaluated alone.
 */

import {
  defineCheck,
  type EvidenceInput,
  type Observation,
  type SnapshotSlice,
  subjects,
  tlsHostRole,
} from '../../core/api.ts';
import type { HostVariant, HttpHop, RedirectChain } from '../../core/snapshot/http.ts';
import { browserAcceptsTls, isRedirect, isSuccess, startFinalHost } from './shared.ts';
import { evaluateHttpLinks } from './tls-01-links.ts';

const ID = 'TLS-01';
/** A page of at most this size is a stub (parking page, redirect stub), not content served over http. */
const STUB_BYTES = 1024;
const HOST_VARIANTS: readonly HostVariant[] = ['target', 'www', 'apex'];

/** A closed port or an unknown host serves nothing over http: there is nothing to evaluate. */
const NOT_SERVING_OUTCOMES: readonly RedirectChain['outcome'][] = [
  'connection-refused',
  'dns-error',
  'tls-error',
];

type HttpsState = 'ok' | 'unavailable' | 'invalid' | 'unknown';

/** What a chain without a single hop says about HTTPS; its other outcomes (timeout, throttled, …) say nothing. */
const HTTPS_STATE_OF_EMPTY_CHAIN: ReadonlyMap<RedirectChain['outcome'], HttpsState> = new Map([
  ['connection-refused', 'unavailable'],
  ['dns-error', 'unavailable'],
  ['tls-error', 'invalid'],
]);

function httpsState(c: RedirectChain | undefined): HttpsState {
  if (!c) return 'unknown';
  const httpsHops = c.hops.filter((h) => h.url.startsWith('https:'));
  if (httpsHops.some((h) => !browserAcceptsTls(h.tlsAuthorized, h.tlsAuthorizationError))) return 'invalid';
  if (c.hops.length > 0) return 'ok';
  return HTTPS_STATE_OF_EMPTY_CHAIN.get(c.outcome) ?? 'unknown';
}

function chainEvidence(c: RedirectChain): EvidenceInput {
  return {
    type: 'redirect-chain',
    phase: 'http',
    startUrl: c.startUrl,
    hops: c.hops.map((h) => ({
      url: h.url,
      status: h.status,
      ...(h.location ? { location: h.location } : {}),
    })),
    outcome: c.outcome,
  };
}

interface Verdict {
  observations: Observation[];
  undecided: boolean;
  timeout: boolean;
}

/**
 * Subject `http-entry:<role>` is the chain host's role relative to the start page's final host, so typing `example.de`
 * or `www.example.de` gives the same fingerprint.
 */
function observation(
  variant: string,
  http: RedirectChain,
  finalHost: string,
  page: string,
  evidence: EvidenceInput[],
  params: Observation['params'],
  confidence: Observation['confidence'] = 'high',
): Observation {
  return {
    checkId: ID,
    variant,
    confidence,
    subject: subjects.tlsEndpoint('http-entry', tlsHostRole(http.host, finalHost)),
    phases: ['http'],
    pages: [page],
    evidence,
    params,
  };
}

const noVerdict = (): Verdict => ({ observations: [], undecided: false, timeout: false });
const undecided = (timeout: boolean): Verdict => ({ observations: [], undecided: true, timeout });

const hasHttpsHop = (hops: readonly HttpHop[]): boolean => hops.some((h) => h.url.startsWith('https:'));

/** The first hop already goes to https on the same host: nothing to say about the redirect. */
function isDirectHttpsRedirect(location: string, host: string): boolean {
  try {
    const u = new URL(location);
    return u.protocol === 'https:' && u.hostname === host;
  } catch {
    return false;
  }
}

/** The chain started on http and ended on https: only the path of the first hop is of interest. */
function judgeUpgradedChain(finalHost: string, http: RedirectChain): Verdict {
  const location = (http.hops[0] as HttpHop).location ?? '';
  if (isDirectHttpsRedirect(location, http.host)) return noVerdict();

  const detail = observation('redirect-chain-detail', http, finalHost, http.startUrl, [chainEvidence(http)], {
    host: http.host,
    url: http.startUrl,
    location,
    reason: location.startsWith('http:') ? 'http-first-hop' : 'other-host',
  });
  return { ...noVerdict(), observations: [detail] };
}

/** https of this host: its own chain; a downgrade chain itself reached https with a certificate browsers accept. */
function httpsStateOfHost(https: RedirectChain | undefined, hops: readonly HttpHop[]): HttpsState {
  const state = httpsState(https);
  const reachedAcceptedHttps = hops.some(
    (h) => h.url.startsWith('https:') && browserAcceptsTls(h.tlsAuthorized, h.tlsAuthorizationError),
  );
  return state === 'unknown' && reachedAcceptedHttps ? 'ok' : state;
}

/**
 * The address typed (`url`) and the http page it ends on (`page`). The www and the apex entry often end on the same
 * page; naming the entry keeps their findings apart.
 */
function entryParams(http: RedirectChain, page: string): Observation['params'] {
  return { host: http.host, url: http.startUrl, page, redirected: http.startUrl === page ? 'no' : 'yes' };
}

/** The chain ends on http: never upgraded, or upgraded and sent back to http (downgrade). */
function judgeChainEndingOnHttp(
  finalHost: string,
  http: RedirectChain,
  https: RedirectChain | undefined,
): Verdict {
  const hops = http.hops;
  const last = hops.at(-1) as HttpHop;
  if (http.outcome !== 'ok' || isRedirect(last.status)) return undecided(http.outcome === 'timeout');
  if (!isSuccess(last.status)) return noVerdict();

  const downgrade = hasHttpsHop(hops) ? 'yes' : 'no';
  const page = last.url;
  const entry = entryParams(http, page);
  const observations: Observation[] = [];
  if (last.hasForm) {
    observations.push(
      observation(
        'form-on-http-page',
        http,
        finalHost,
        page,
        [
          { type: 'page', phase: 'http', url: page, status: last.status, role: 'http-form' },
          chainEvidence(http),
        ],
        { host: http.host, url: page, downgrade },
      ),
    );
  }

  const client = last.clientRedirect;
  if (client?.url?.startsWith('https:')) {
    observations.push(
      observation(
        'client-side-redirect-only',
        http,
        finalHost,
        page,
        [chainEvidence(http)],
        { ...entry, kind: client.kind },
        'medium',
      ),
    );
    return { ...noVerdict(), observations };
  }
  if (!last.bodyTruncated && (last.bodyBytes ?? 0) <= STUB_BYTES) return { ...noVerdict(), observations };

  const state = httpsStateOfHost(https, hops);
  if (state === 'unknown') return { observations, undecided: true, timeout: https?.outcome === 'timeout' };

  if (state === 'ok') {
    observations.push(
      observation('no-redirect', http, finalHost, page, [chainEvidence(http)], { ...entry, downgrade }),
    );
  } else {
    observations.push(
      observation(
        'https-unavailable',
        http,
        finalHost,
        page,
        [chainEvidence(http), ...(https ? [chainEvidence(https)] : [])],
        { ...entry, reason: state, downgrade },
      ),
    );
  }
  return { ...noVerdict(), observations };
}

function evaluate(finalHost: string, http: RedirectChain, https: RedirectChain | undefined): Verdict {
  const hops = http.hops;
  if (hops.length === 0) {
    if (NOT_SERVING_OUTCOMES.includes(http.outcome)) return noVerdict();
    return undecided(http.outcome === 'timeout');
  }

  const last = hops.at(-1) as HttpHop;
  if (hasHttpsHop(hops) && last.url.startsWith('https:')) return judgeUpgradedChain(finalHost, http);
  return judgeChainEndingOnHttp(finalHost, http, https);
}

/** Entries (www and apex) that end on the same http page with a form describe one form: it is reported once. */
function withoutRepeatedForms(observations: readonly Observation[]): Observation[] {
  const seen = new Set<string>();
  return observations.filter((o) => {
    if (o.variant !== 'form-on-http-page') return true;
    const page = o.pages[0] ?? '';
    if (seen.has(page)) return false;
    seen.add(page);
    return true;
  });
}

/** Standard-port probe of a host variant (chains of an explicit target port only load the start page). */
function chainFor(slice: Pick<SnapshotSlice<'http'>, 'http'>, hv: HostVariant, scheme: 'http' | 'https') {
  return slice.http.chains.find((c) => c.hostVariant === hv && c.scheme === scheme && c.port === undefined);
}

export const tls01 = defineCheck({
  id: ID,
  module: 'http',
  requires: ['http'],
  // The links come from the browser when the scan runs it; TLS-01 alone does not start it.
  optional: ['browser'],
  variants: [
    { variant: 'https-unavailable', variantGroup: 'http-redirect' },
    { variant: 'no-redirect', variantGroup: 'http-redirect' },
    { variant: 'client-side-redirect-only', variantGroup: 'http-redirect' },
    { variant: 'form-on-http-page' },
    { variant: 'redirect-chain-detail' },
    // A host's state may change between scans; its link keeps one fingerprint.
    { variant: 'internal-http-link', variantGroup: 'http-link' },
    { variant: 'internal-http-link-upgraded', variantGroup: 'http-link' },
  ],
  run(slice) {
    if (!chainFor(slice, 'target', 'http')) throw new Error('http section has no http chain for the target');
    const finalHost = startFinalHost(slice.http) ?? slice.target.finalHost ?? slice.target.host;

    const found: Observation[] = [];
    const limitations: string[] = [];
    let targetUndecided = false;
    let targetTimeout = false;
    for (const hv of HOST_VARIANTS) {
      const http = chainFor(slice, hv, 'http');
      if (!http) continue;

      const v = evaluate(finalHost, http, chainFor(slice, hv, 'https'));
      found.push(...v.observations);
      if (!v.undecided) continue;
      limitations.push(`undecided:${hv}`);
      if (hv === 'target') {
        targetUndecided = true;
        targetTimeout = v.timeout;
      }
    }

    const finalHostProbed = slice.http.chains.some(
      (chain) =>
        chain.scheme === 'http' &&
        chain.host.toLowerCase() === finalHost.toLowerCase() &&
        chain.port === undefined,
    );
    if (!finalHostProbed) limitations.push('final-host-not-probed');
    if (slice.http.throttled) limitations.push('throttled');
    const observations = withoutRepeatedForms(found);

    if (slice.browser) {
      const links = evaluateHttpLinks(slice.http, slice.browser);
      observations.push(...links.observations);
      if (links.notObserved) limitations.push('page-links-not-observed');
    } else if (slice.unavailable.includes('browser')) {
      limitations.push('page-links-not-observed');
    }

    if (targetUndecided) {
      return {
        status: 'inconclusive',
        reason: targetTimeout ? 'timeout' : 'undecided',
        limitations,
        observations,
      };
    }
    if (limitations.length > 0) return { status: 'partial', limitations, observations };
    return observations;
  },
});
