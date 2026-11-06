/**
 * TLS-01: does `http://` of the host, www and apex lead to https? A closed port is not "serving content", a stub of
 * ≤ 1 KiB gives no finding, a timeout is inconclusive. When the browser ran, same-site links of phase A that ask for
 * `http://` are reported per linked host (tls-01-links.ts); without the browser the http entries are evaluated alone.
 * A form on a page served over http counts on the entries, on linked legal documents that ended on http and on the
 * http:// addresses of pages with a form that the scan requested after the browser (`http.twins`).
 */

import {
  defineCheck,
  type EvidenceInput,
  type Observation,
  type SnapshotSlice,
  subjects,
  tlsHostRole,
} from '../../core/api.ts';
import type {
  DocumentResponse,
  HostVariant,
  HttpHop,
  HttpSection,
  HttpTwin,
  RedirectChain,
} from '../../core/snapshot/http.ts';
import { BLOCKED_DOCUMENT, browserAcceptsTls, isRedirect, isSuccess, startFinalHost } from './shared.ts';
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

/** A page served over plain http with a form that takes input: an entry, a linked document or a twin. */
interface FormPage {
  page: string;
  status: number | null;
  /** Host the subject is named after: the entry's host for an entry, else the page's. */
  host: string;
  /** Where its first form sends; empty when unknown (an http(s) action not found, or an older snapshot). */
  action: string;
  downgrade: 'yes' | 'no';
  /** Evidence beside the page itself (the redirect chain of an entry). */
  evidence: EvidenceInput[];
}

/** What a response says about forms: a form that takes input, a page whose forms were not all seen, or nothing. */
interface FormResult {
  form?: FormPage;
  limitation?: string;
}

interface Verdict {
  observations: Observation[];
  undecided: boolean;
  timeout: boolean;
  forms: FormResult[];
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

const noVerdict = (): Verdict => ({ observations: [], undecided: false, timeout: false, forms: [] });
const undecided = (timeout: boolean): Verdict => ({ ...noVerdict(), undecided: true, timeout });

type FormFacts = Pick<HttpHop, 'hasForm' | 'forms' | 'formInspection'>;

/**
 * The forms of a plain-http success page. Without a form seen, a body read only in part (or not decodable) leaves the
 * question open: a limitation, so that the page never reads as one without a form.
 */
function formResult(facts: FormFacts, page: Omit<FormPage, 'action'>): FormResult {
  if (facts.hasForm) {
    const action = facts.forms?.find((f) => f.action !== null)?.action ?? '';
    return { form: { ...page, action } };
  }
  const missed = facts.formInspection === 'truncated' || facts.formInspection === 'unavailable';
  return missed ? { limitation: `http-form-not-inspected:${page.page}` } : {};
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

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
  const forms = [
    formResult(last, {
      page,
      status: last.status,
      host: http.host,
      downgrade,
      evidence: [chainEvidence(http)],
    }),
  ];

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
    return { ...noVerdict(), observations, forms };
  }
  if (!last.bodyTruncated && (last.bodyBytes ?? 0) <= STUB_BYTES)
    return { ...noVerdict(), observations, forms };

  const state = httpsStateOfHost(https, hops);
  if (state === 'unknown')
    return { observations, undecided: true, timeout: https?.outcome === 'timeout', forms };

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
  return { ...noVerdict(), observations, forms };
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

/**
 * A linked legal document that ended on a plain-http page. A bot challenge answered there instead of the document:
 * whether the document carries a form over http is then unknown.
 */
function documentForms(doc: DocumentResponse): FormResult {
  if (doc.foundVia !== 'link') return {};
  if (doc.error?.code === BLOCKED_DOCUMENT) {
    return doc.finalUrl.startsWith('http:') ? { limitation: `http-form-not-inspected:${doc.finalUrl}` } : {};
  }
  if (doc.error || !doc.formInspection) return {};
  if (!doc.finalUrl.startsWith('http:') || !isSuccess(doc.status)) return {};
  return formResult(doc, {
    page: doc.finalUrl,
    status: doc.status,
    host: hostOf(doc.finalUrl),
    downgrade: 'no',
    evidence: [],
  });
}

/**
 * The http:// address of a page with a form, requested once without following a redirect. A redirect to https serves
 * no form over http; a failed request, a challenge, a redirect to another http address or a server error leaves it open.
 */
function twinForms(twin: HttpTwin): FormResult {
  const open: FormResult = { limitation: `http-form-twin-undecided:${twin.page}` };
  const hop = twin.hop;
  if (twin.outcome !== 'ok' || !hop || twin.challenge) return open;
  if (isRedirect(hop.status)) return hop.location?.startsWith('https:') ? {} : open;
  if (hop.status === null || hop.status === 429 || hop.status >= 500) return open;
  if (!isSuccess(hop.status) || !hop.url.startsWith('http:')) return {};
  return formResult(hop, {
    page: hop.url,
    status: hop.status,
    host: hostOf(hop.url),
    downgrade: 'no',
    evidence: [],
  });
}

/**
 * One finding per host role: a host whose http pages carry forms on the root and on an article is one finding over
 * those pages, the first one speaking. A page reached by several entries (www and apex) counts once.
 */
function formObservations(forms: readonly FormPage[], finalHost: string): Observation[] {
  const seen = new Set<string>();
  const groups = new Map<string, FormPage[]>();
  for (const f of forms) {
    if (seen.has(f.page)) continue;
    seen.add(f.page);
    const subject = subjects.tlsEndpoint('http-entry', tlsHostRole(f.host, finalHost));
    groups.set(subject, [...(groups.get(subject) ?? []), f]);
  }

  return [...groups].map(([subject, pages]) => {
    const first = pages[0] as FormPage;
    return {
      checkId: ID,
      variant: 'form-on-http-page',
      confidence: 'high',
      subject,
      phases: ['http'],
      pages: pages.map((p) => p.page),
      evidence: pages.flatMap((p): EvidenceInput[] => [
        {
          type: 'page',
          phase: 'http',
          url: p.page,
          status: p.status,
          role: 'http-form',
          ...(p.action ? { formAction: p.action } : {}),
        },
        ...p.evidence,
      ]),
      params: {
        host: first.host,
        url: first.page,
        action: first.action,
        hasAction: first.action ? 'yes' : 'no',
        count: pages.length,
        downgrade: first.downgrade,
      },
    };
  });
}

/** Whether the step after the browser saw all pages with a form it could request. */
function twinStageLimitations(http: HttpSection): string[] {
  const stage = http.formTwinStage;
  if (!stage) return [];
  if (stage.error) return ['http-form-twins-not-collected'];
  return stage.budget > 0 && (stage.candidates ?? 0) > stage.budget ? ['http-form-twins-capped'] : [];
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

    const observations: Observation[] = [];
    const forms: FormResult[] = [];
    const limitations: string[] = [];
    let targetUndecided = false;
    let targetTimeout = false;
    for (const hv of HOST_VARIANTS) {
      const http = chainFor(slice, hv, 'http');
      if (!http) continue;

      const v = evaluate(finalHost, http, chainFor(slice, hv, 'https'));
      observations.push(...v.observations);
      forms.push(...v.forms);
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

    forms.push(...slice.http.documents.map(documentForms), ...(slice.http.twins ?? []).map(twinForms));
    observations.push(
      ...formObservations(
        forms.flatMap((f) => (f.form ? [f.form] : [])),
        finalHost,
      ),
    );
    limitations.push(
      ...new Set(forms.flatMap((f) => (f.limitation ? [f.limitation] : []))),
      ...twinStageLimitations(slice.http),
    );

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
