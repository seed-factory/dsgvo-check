/**
 * TLS-01 (consensus §4, D19): does `http://` of the host, www and apex lead to https? Variant names: registry
 * docs/03-checks.md §2.1.
 * critical: http serves content while https is unavailable or invalid (`https-unavailable`), or a form on an http
 * page (`form-on-http-page`). warning: http 2xx without redirect while https works (`no-redirect`); redirect only
 * via meta/JS (`client-side-redirect-only`). info (`redirect-chain-detail`): the first hop is not https or goes to
 * another host. A chain that reaches https but ends on http again (downgrade) is evaluated on its final http page
 * (S-18). A closed port is not "serving content"; a stub of ≤ 1 KiB gives no finding; a timeout → inconclusive.
 * Prototype gap: http links to own subdomains (browser phase A) are not evaluated here.
 */

import type { HostVariant, HttpHop, RedirectChain } from '../../collectors/http/types.ts';
import {
  defineCheck,
  type EvidenceInput,
  type Observation,
  type SnapshotSlice,
  subjects,
  tlsHostRole,
} from '../../core/api.ts';
import { browserAcceptsTls, isRedirect, isSuccess, startFinalHost } from './shared.ts';

const ID = 'TLS-01';
const STUB_BYTES = 1024;
const HOST_VARIANTS: readonly HostVariant[] = ['target', 'www', 'apex'];

type HttpsState = 'ok' | 'unavailable' | 'invalid' | 'unknown';

function httpsState(c: RedirectChain | undefined): HttpsState {
  if (!c) return 'unknown';
  const httpsHops = c.hops.filter((h) => h.url.startsWith('https:'));
  if (httpsHops.some((h) => !browserAcceptsTls(h.tlsAuthorized, h.tlsAuthorizationError))) return 'invalid';
  if (c.hops.length > 0) return 'ok';
  switch (c.outcome) {
    case 'connection-refused':
    case 'dns-error':
      return 'unavailable';
    case 'tls-error':
      return 'invalid';
    default:
      return 'unknown';
  }
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
 * Subject `http-entry:<role>` (5.4): the role of the chain's host relative to the final host of the start page, so
 * the same entry gets the same fingerprint whether `example.de` or `www.example.de` was typed (S-37). The variant
 * group tells the variants of one entry apart.
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

function evaluate(finalHost: string, http: RedirectChain, https: RedirectChain | undefined): Verdict {
  const none: Verdict = { observations: [], undecided: false, timeout: false };
  const hops = http.hops;
  if (hops.length === 0) {
    if (['connection-refused', 'dns-error', 'tls-error'].includes(http.outcome)) return none;
    return { observations: [], undecided: true, timeout: http.outcome === 'timeout' };
  }

  const last = hops.at(-1) as HttpHop;
  const reachedHttps = hops.some((h) => h.url.startsWith('https:'));
  if (reachedHttps && last.url.startsWith('https:')) {
    // The chain ends on https: only the path of the first hop is of interest here.
    const first = hops[0] as HttpHop;
    const location = first.location ?? '';
    let direct = false;
    try {
      const u = new URL(location);
      direct = u.protocol === 'https:' && u.hostname === http.host;
    } catch {
      direct = false;
    }
    if (direct) return none;
    return {
      ...none,
      observations: [
        observation('redirect-chain-detail', http, finalHost, http.startUrl, [chainEvidence(http)], {
          host: http.host,
          url: http.startUrl,
          location,
          reason: location.startsWith('http:') ? 'http-first-hop' : 'other-host',
        }),
      ],
    };
  }

  // The chain ends on http: never upgraded, or upgraded and sent back to http (downgrade, S-18).
  if (http.outcome !== 'ok' || isRedirect(last.status)) {
    return { observations: [], undecided: true, timeout: http.outcome === 'timeout' };
  }
  if (!isSuccess(last.status)) return none;

  const downgrade = reachedHttps ? 'yes' : 'no';
  const page = last.url;
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
        { host: http.host, url: page, kind: client.kind },
        'medium',
      ),
    );
    return { ...none, observations };
  }
  if (!last.bodyTruncated && (last.bodyBytes ?? 0) <= STUB_BYTES) return { ...none, observations };

  // https of this host: its own chain; a downgrade chain itself reached https with a certificate browsers accept.
  let state = httpsState(https);
  if (
    state === 'unknown' &&
    hops.some(
      (h) => h.url.startsWith('https:') && browserAcceptsTls(h.tlsAuthorized, h.tlsAuthorizationError),
    )
  ) {
    state = 'ok';
  }
  if (state === 'unknown') {
    return { observations, undecided: true, timeout: https?.outcome === 'timeout' };
  }
  if (state === 'ok') {
    observations.push(
      observation('no-redirect', http, finalHost, page, [chainEvidence(http)], {
        host: http.host,
        url: page,
        downgrade,
      }),
    );
  } else {
    observations.push(
      observation(
        'https-unavailable',
        http,
        finalHost,
        page,
        [chainEvidence(http), ...(https ? [chainEvidence(https)] : [])],
        { host: http.host, url: page, reason: state, downgrade },
      ),
    );
  }
  return { ...none, observations };
}

/** Standard-port probe of a host variant (chains of an explicit target port only load the start page, S-20). */
function chainFor(slice: SnapshotSlice<'http'>, hv: HostVariant, scheme: 'http' | 'https') {
  return slice.http.chains.find((c) => c.hostVariant === hv && c.scheme === scheme && c.port === undefined);
}

export const tls01 = defineCheck({
  id: ID,
  module: 'http',
  requires: ['http'],
  variants: [
    { variant: 'https-unavailable', variantGroup: 'http-redirect' },
    { variant: 'no-redirect', variantGroup: 'http-redirect' },
    { variant: 'client-side-redirect-only', variantGroup: 'http-redirect' },
    { variant: 'form-on-http-page' },
    { variant: 'redirect-chain-detail' },
  ],
  run(slice) {
    if (!chainFor(slice, 'target', 'http')) throw new Error('http section has no http chain for the target');
    const observations: Observation[] = [];
    const limitations: string[] = [];
    let targetUndecided = false;
    let targetTimeout = false;
    const finalHost = startFinalHost(slice.http) ?? slice.target.finalHost ?? slice.target.host;
    for (const hv of HOST_VARIANTS) {
      const http = chainFor(slice, hv, 'http');
      if (!http) continue;
      const v = evaluate(finalHost, http, chainFor(slice, hv, 'https'));
      observations.push(...v.observations);
      if (v.undecided) {
        limitations.push(`undecided:${hv}`);
        if (hv === 'target') {
          targetUndecided = true;
          targetTimeout = v.timeout;
        }
      }
    }
    if (
      !slice.http.chains.some(
        (chain) =>
          chain.scheme === 'http' &&
          chain.host.toLowerCase() === finalHost.toLowerCase() &&
          chain.port === undefined,
      )
    ) {
      limitations.push('final-host-not-probed');
    }
    if (slice.http.throttled) limitations.push('throttled');
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
