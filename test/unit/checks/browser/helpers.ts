/**
 * Scenario builders for browser-check tests: a "site" is https://www.example.de/ with phase A pages
 * start/impressum/datenschutz/kontakt linking both legal documents in the footer, and no CMP unless given.
 */
import type {
  BannerCandidateFact,
  CmpFacts,
  CmpPhaseFacts,
  CmpSection,
  ConsentStateFact,
} from '../../../../src/cmp/types.ts';
import type {
  BrowserPlan,
  CookieRecord,
  DocumentRecord,
  DocumentsSection,
  LinkFact,
  PageVisit,
  PhaseRecord,
  RequestRecord,
  StorageRecord,
} from '../../../../src/core/snapshot/browser.ts';
import type { Snapshot, SnapshotEnvironment } from '../../../../src/core/snapshot/index.ts';
import {
  makeBrowser,
  makeCmpFacts,
  makeCookie,
  makeDocument,
  makeDom,
  makeLink,
  makePage,
  makePhase,
  makeRequest,
  makeSnapshot,
  makeStorage,
  makeTarget,
  withDerived,
} from '../../../utils/snapshot-builder.ts';

export const ORIGIN = 'https://www.example.de';
export const START = `${ORIGIN}/`;
export const IMPRESSUM = `${ORIGIN}/impressum`;
export const PRIVACY = `${ORIGIN}/datenschutz`;
export const CONTACT = `${ORIGIN}/kontakt`;

export const footerLinks = (): LinkFact[] => [
  makeLink({ text: 'Impressum', href: IMPRESSUM, hrefKind: 'https', sameSite: true }),
  makeLink({ text: 'Datenschutz', href: PRIVACY, hrefKind: 'https', sameSite: true }),
];

export function page(
  url: string,
  role: PageVisit['role'],
  phase: PageVisit['phase'] = 'A',
  p: Partial<PageVisit> = {},
  links: LinkFact[] = footerLinks(),
): PageVisit {
  const order = [START, IMPRESSUM, PRIVACY, CONTACT].indexOf(url);
  return makePage({
    url,
    role,
    phase,
    order: order < 0 ? 9 : order,
    firstVisit: phase === 'A' && role === 'start',
    dom: makeDom({ links }),
    ...p,
  });
}

export const defaultPages = (phase: PageVisit['phase'] = 'A'): PageVisit[] => [
  page(START, 'start', phase),
  page(IMPRESSUM, 'impressum', phase),
  page(PRIVACY, 'privacy', phase),
  page(CONTACT, 'contact', phase),
];

/** Request in phase A on the start page unless overridden. */
export function req(id: string, url: string, p: Partial<RequestRecord> = {}): RequestRecord {
  return makeRequest({ id, url, pageUrl: START, ...p });
}

export function cookie(name: string, p: Partial<CookieRecord> = {}): CookieRecord {
  return makeCookie({ name, pageUrl: START, ...p });
}

export function storage(key: string, p: Partial<StorageRecord> = {}): StorageRecord {
  return makeStorage({ key, pageUrl: START, ...p });
}

export function phase(ph: PhaseRecord['phase'], p: Partial<PhaseRecord> = {}): PhaseRecord {
  return makePhase(ph, { pages: defaultPages(ph).slice(0, ph === 'A' ? 4 : 1), ...p });
}

/** Click record for phases B (reject) / C (accept). */
export const click = (action: 'reject' | 'accept') => ({
  action,
  cmpId: 'cookiebot',
  name: action === 'reject' ? 'Ablehnen' : 'Alle akzeptieren',
  clickedAt: 1_000,
  pageUrl: START,
  success: true,
});

export const defaultDocuments = (): DocumentsSection => ({
  documents: [
    makeDocument({
      kind: 'impressum',
      id: 'doc-impressum',
      url: IMPRESSUM,
      phase: 'A',
      linkedFrom: [{ pageUrl: START, text: 'Impressum' }],
      parts: [
        {
          id: 'i1',
          text: 'Impressum. Beispiel GmbH, Musterstraße 1, 10115 Berlin.',
          origin: 'visible',
          sourceUrl: IMPRESSUM,
        },
      ],
    }),
    makeDocument({
      kind: 'privacy',
      id: 'doc-privacy',
      url: PRIVACY,
      phase: 'A',
      linkedFrom: [{ pageUrl: START, text: 'Datenschutz' }],
      parts: [
        {
          id: 'p1',
          section: '1 > Verantwortlicher',
          text: 'Datenschutzerklärung. Verantwortlich ist die Beispiel GmbH.',
          origin: 'visible',
          sourceUrl: PRIVACY,
        },
      ],
    }),
  ],
  attempts: [],
});

/** Recognised CMP (own adapter, ≥ 2 signals → high). */
export function cmpFacts(p: Partial<CmpFacts> = {}): CmpFacts {
  return makeCmpFacts({
    phase: 'B',
    pageUrl: START,
    moment: 'first-screen',
    detection: {
      cmpId: 'cookiebot',
      method: 'adapter',
      version: '3.0.0',
      versionSupported: true,
      recognitionConfidence: 'high',
      signals: ['global:Cookiebot', 'dom:#CybotCookiebotDialog'],
    },
    ...p,
  });
}

/** CMP section without any banner candidate (facts recorded, nothing detected). */
export function noBannerCmp(phases: Array<'A' | 'B'> = ['A']): CmpSection {
  return {
    phases: phases.map((ph) => ({
      phase: ph,
      facts: [makeCmpFacts({ phase: ph, pageUrl: START, moment: ph === 'A' ? 'phase-end' : 'first-screen' })],
    })),
  };
}

export function cmpWith(...phases: CmpPhaseFacts[]): CmpSection {
  return { phases };
}

/** The CMP state after a reject: every optional category denied, an explicit answer. */
const deniedState = (origin: ConsentStateFact['origin']): ConsentStateFact => ({
  source: 'api',
  ready: 'ready',
  categories: { statistics: 'denied', marketing: 'denied' },
  origin,
  decision: { responded: true, method: 'explicit' },
});

/**
 * Phase B CMP facts of a reject click on the start page. `confirmed`: the state our click set and the state read back
 * after the reload confirm it, as an adapter records them; otherwise the banner closed but the state did not confirm
 * the reject (as with Shopware). `pages` adds the facts of a control page after the reload: `in-effect` with the
 * banner hidden and the reject stored, `banner-again` with the banner shown again (consent cookie of another host).
 */
export function rejectCmp(o: {
  confirmed: boolean;
  pages?: Record<string, 'in-effect' | 'banner-again'>;
}): CmpSection {
  const afterReload = cmpFacts({ moment: 'after-reload', state: o.confirmed ? [deniedState('stored')] : [] });
  const control = Object.entries(o.pages ?? {}).map(([pageUrl, effect]) =>
    cmpFacts({
      pageUrl,
      moment: 'control-page',
      state: effect === 'in-effect' ? [deniedState('stored')] : [],
      firstLayer: {
        bannerPresent: true,
        bannerVisible: effect === 'banner-again',
        buttons: [],
        purAbo: false,
        closeMeansAccept: null,
      },
    }),
  );
  return cmpWith({
    phase: 'B',
    facts: [cmpFacts(), afterReload, ...control],
    click: {
      action: 'reject',
      clicked: true,
      button: { name: 'Ablehnen', role: 'button', kind: 'reject', kindConfidence: 'high' },
    },
    verify: o.confirmed
      ? {
          action: 'reject',
          verified: true,
          method: ['api:all-denied', 'persisted-after-reload'],
          stateAfter: [deniedState('action')],
          persistedAfterReload: true,
        }
      : { action: 'reject', verified: false, method: [], stateAfter: [], persistedAfterReload: null },
  });
}

/** A banner-shaped box the generic heuristic dismissed: one consent keyword and a settings button, no banner name. */
export const bannerCandidate = (p: Partial<BannerCandidateFact> = {}): BannerCandidateFact => ({
  reason: 'keywords',
  keywordHits: 1,
  controls: ['settings', 'other'],
  cookieWording: true,
  fixed: true,
  dialog: false,
  named: false,
  ...p,
});

/** Phase A facts without a banner on `pages`; the heuristic recorded `candidate` there (null: it saw none). */
export function candidateCmp(
  candidate: BannerCandidateFact | null,
  pages: readonly string[] = [START, IMPRESSUM],
): CmpSection {
  return cmpWith({
    phase: 'A',
    facts: pages.map((pageUrl) =>
      makeCmpFacts({
        phase: 'A',
        pageUrl,
        moment: 'first-screen',
        firstLayer: {
          bannerPresent: false,
          bannerVisible: false,
          buttons: [],
          purAbo: false,
          closeMeansAccept: null,
          bannerCandidate: candidate,
        },
      }),
    ),
  });
}

/** A visible link inside a container the DOM collector named a banner (`region: banner`). */
export const bannerLink = (p: Partial<LinkFact> = {}): LinkFact =>
  makeLink({
    text: 'Mehr Informationen',
    href: PRIVACY,
    hrefKind: 'https',
    region: 'banner',
    sameSite: true,
    ...p,
  });

/** Phase A pages; the pages named in `withLinks` also carry `links` next to the footer links. */
export function pagesWithLinks(withLinks: Record<string, LinkFact[]>): PageVisit[] {
  return defaultPages('A').map((p) =>
    withLinks[p.url] ? { ...p, dom: makeDom({ links: [...footerLinks(), ...(withLinks[p.url] ?? [])] }) } : p,
  );
}

export interface SiteSpec {
  phases?: PhaseRecord[];
  cmp?: CmpSection;
  documents?: DocumentsSection;
  environment?: Partial<SnapshotEnvironment>;
  knownGaps?: string[];
  plan?: BrowserPlan | null;
  derive?: boolean;
}

/** Full snapshot (browser + cmp + documents) with `derived` computed by the real derive. */
export function site(spec: SiteSpec = {}): Snapshot {
  const base = makeSnapshot({
    target: makeTarget(START),
    browser: makeBrowser({ phases: spec.phases ?? [phase('A')], knownGaps: spec.knownGaps ?? [] }),
    cmp: spec.cmp ?? noBannerCmp(),
    documents: spec.documents ?? defaultDocuments(),
  });
  const snap: Snapshot = {
    ...base,
    environment: { ...base.environment, ...spec.environment },
    plan: { browser: spec.plan ?? null, probes: [] },
  };
  return spec.derive === false ? snap : withDerived(snap);
}

/** The partial snapshot that is written to a fixture file (derived is recomputed on load). */
export function fixtureBody(s: Snapshot): Partial<Snapshot> {
  const body: Partial<Snapshot> = {
    target: s.target,
    browser: s.browser,
    cmp: s.cmp,
    documents: s.documents,
  };
  if (s.plan.browser) body.plan = s.plan;
  if (s.environment.egress.region !== 'unknown') body.environment = s.environment;
  return body;
}

export function privacyDoc(parts: DocumentRecord['parts'], p: Partial<DocumentRecord> = {}): DocumentRecord {
  return makeDocument({ kind: 'privacy', id: 'doc-privacy', url: PRIVACY, phase: 'A', parts, ...p });
}
