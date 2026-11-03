/**
 * Scenario builders for browser-check tests and the fixture generator (generate-fixtures.ts).
 * A "site" is the target https://www.example.de/ with phase A pages start/impressum/datenschutz/kontakt that link
 * to both legal documents in the footer, documents found via link, and no CMP detected unless given.
 */
import type { CmpFacts, CmpPhaseFacts, CmpSection } from '../../../../src/cmp/types.ts';
import type { Snapshot, SnapshotEnvironment } from '../../../../src/core/snapshot.ts';
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
} from '../../../../src/core/snapshot-browser.ts';
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
