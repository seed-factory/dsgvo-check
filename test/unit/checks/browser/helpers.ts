/**
 * Scenario builders for browser-check tests: a "site" is https://www.example.de/ with phase A pages
 * start/impressum/datenschutz/kontakt linking both legal documents in the footer, and no CMP unless given.
 */
import type {
  BannerCandidateFact,
  CmpFacts,
  CmpFirstLayer,
  CmpPhaseFacts,
  CmpSection,
  ConsentStateFact,
} from '../../../../src/cmp/types.ts';
import type { AnyCheck } from '../../../../src/core/evaluation/check.ts';
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
  runCheck,
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

export const startAndContact = (links: LinkFact[]) => [
  page(START, 'start', 'A', {}, links),
  page(CONTACT, 'contact', 'A', {}, links),
];

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

/** The first layer of a banner in the page: visible and without controls unless `p` says otherwise. */
export const firstLayer = (p: Partial<CmpFirstLayer> = {}): CmpFirstLayer => ({
  bannerPresent: true,
  bannerVisible: true,
  buttons: [],
  purAbo: false,
  closeMeansAccept: null,
  ...p,
});

/** A control of a dialog that was rendered into the page but not opened: no box, disabled, second layer. */
const closedControl = (name: string, kind: 'accept' | 'reject' | 'settings') => ({
  role: 'button',
  name,
  tag: 'button',
  kind,
  kindConfidence: 'high' as const,
  layer: 2 as const,
  box: null,
  visibleAtFirstScreen: false,
  actionableAtFirstScreen: false,
  contrast: null,
  vendorRole: kind,
  enabled: false,
  inViewport: false,
  hitTestOk: false,
});

/**
 * CCM19 recognised with high confidence, its dialog in the page but not opened: hidden, every control disabled, no
 * answer stored. `notOpened` is the adapter's flag, which only the first screen of a consent phase carries, measured
 * after the wait for the banner.
 */
export function unopenedDialogFacts(p: Partial<CmpFacts> = {}, notOpened = true): CmpFacts {
  return makeCmpFacts({
    phase: 'B',
    pageUrl: START,
    moment: 'first-screen',
    detection: {
      cmpId: 'ccm19',
      method: 'adapter',
      version: null,
      versionSupported: null,
      recognitionConfidence: 'high',
      signals: ['global:CCM', 'dom:#ccm-widget'],
    },
    firstLayer: firstLayer({
      bannerVisible: false,
      buttons: [
        closedControl('Alle akzeptieren', 'accept'),
        closedControl('Einstellungen', 'settings'),
        closedControl('Ablehnen', 'reject'),
      ],
      textLength: 0,
      containerBox: null,
      containerUnambiguous: true,
      ...(notOpened ? { dialogNotOpened: true } : {}),
    }),
    state: [
      {
        source: 'api',
        ready: 'ready',
        categories: { embeddings: 'denied' },
        origin: 'default',
        decision: { responded: false, method: 'unknown' },
      },
    ],
    ...p,
  });
}

/**
 * Phases A and B on a site whose CCM19 dialog never opened: the facts of A are taken without waiting and carry no flag,
 * the first screen of B carries it; nothing was clicked.
 */
export function unopenedDialogCmp(b: Partial<CmpFacts> = {}): CmpSection {
  return cmpWith(
    { phase: 'A', facts: [unopenedDialogFacts({ phase: 'A' }, false)] },
    { phase: 'B', facts: [unopenedDialogFacts(b)] },
  );
}

/** Another host of the site (same registrable domain as `ORIGIN`), as a consent cookie bound to one host splits them. */
export const SHOP_HOST = 'https://shop.example.de';

/**
 * CMP facts of a control page after the click of phase B (reject) or C (accept). `inEffect`: the CMP read back the
 * stored answer of the click and hides the banner; otherwise it shows the banner again and has no answer, as on a host
 * the consent cookie of the click page does not reach.
 */
export function controlPageFacts(pageUrl: string, ph: 'B' | 'C', inEffect: boolean): CmpFacts {
  const answer = ph === 'B' ? 'denied' : 'granted';
  return cmpFacts({
    phase: ph,
    pageUrl,
    moment: 'control-page',
    firstLayer: firstLayer({ bannerVisible: !inEffect }),
    state: [
      inEffect
        ? {
            source: 'api',
            ready: 'ready',
            categories: { statistics: answer, marketing: answer },
            origin: 'stored',
            decision: { responded: true, method: 'explicit' },
          }
        : {
            source: 'api',
            ready: 'ready',
            categories: { statistics: 'denied', marketing: 'denied' },
            origin: 'default',
            decision: { responded: false, method: 'unknown' },
          },
    ],
  });
}

/** Pages of a consent phase: the start page, in B its reload, then the control pages in this order. */
export function consentPages(ph: 'B' | 'C', control: readonly string[]): PageVisit[] {
  return [
    page(START, 'start', ph, { order: 0 }),
    ...(ph === 'B' ? [page(START, 'start', ph, { order: 0, reload: true })] : []),
    ...control.map((url, i) => page(url, url === CONTACT ? 'contact' : 'nav', ph, { order: i + 1 })),
  ];
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
      firstLayer: firstLayer({ bannerVisible: effect === 'banner-again' }),
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

/** A first-layer control of the Wix-like bar below, as the adapter measures it. */
const barControl = (name: string, kind: 'accept' | 'settings') => ({
  role: 'button',
  name,
  tag: 'button',
  kind,
  kindConfidence: 'high' as const,
  layer: 1 as const,
  box: { x: 900, y: 700, width: 160, height: 40 },
  visibleAtFirstScreen: true,
  actionableAtFirstScreen: true,
  contrast: 7,
  selector: `[data-hook="${kind}"]`,
  vendorRole: kind,
});

/** The Wix policy categories: every optional one denied after the save. */
const wixDenied = (origin: ConsentStateFact['origin']): ConsentStateFact => ({
  source: 'api',
  ready: 'ready',
  categories: { functional: 'denied', analytics: 'denied', advertising: 'denied' },
  origin,
  decision: { responded: true, method: 'explicit' },
});

/**
 * Phase B of a Wix-like bar whose first layer has only "Cookie-Einstellungen" and "Zustimmen": the reject is the save
 * control of the settings layer. `pressed: false` stands for a layer that was opened but not saved (`reason` in the
 * plan), `confirmed: false` for a save the platform policy did not record (it stayed the default).
 */
export function settingsRejectCmp(o: { pressed?: boolean; confirmed?: boolean } = {}): CmpSection {
  const pressed = o.pressed ?? true;
  const confirmed = pressed && (o.confirmed ?? true);
  const wix = {
    cmpId: 'wix',
    method: 'adapter' as const,
    version: null,
    versionSupported: null,
    recognitionConfidence: 'high' as const,
    signals: ['dom:[data-hook="consent-banner-root"]', 'script:static.parastorage.com'],
  };
  const first = cmpFacts({
    detection: wix,
    firstLayer: firstLayer({
      buttons: [barControl('Cookie-Einstellungen', 'settings'), barControl('Zustimmen', 'accept')],
    }),
    blocking: { overlay: false, scrollLock: false, inert: false, coveredRatio: 0.15, method: [] },
    state: [{ ...wixDenied('default'), decision: { responded: false, method: 'unknown' } }],
  });
  const afterReload = cmpFacts({
    detection: wix,
    moment: 'after-reload',
    state: confirmed ? [wixDenied('stored')] : [],
  });
  const settings = {
    takenAt: '2026-11-07T10:00:00.000Z',
    opened: true,
    buttons: [],
    containerUnambiguous: true,
    buttonsTruncated: false,
    groups: [
      { checked: true, disabled: true },
      { checked: false, disabled: false },
      { checked: !pressed, disabled: false },
    ],
    essentialGroups: 1,
  };
  const button = {
    name: 'Speichern',
    role: 'button',
    kind: 'reject' as const,
    kindConfidence: 'high' as const,
  };
  return cmpWith({
    phase: 'B',
    facts: pressed ? [first, afterReload] : [first],
    settings,
    click: pressed
      ? { action: 'reject', clicked: true, button, path: 'settings' }
      : { action: 'reject', clicked: false, button: null, error: 'no-unambiguous-reject' },
    ...(pressed
      ? {
          verify: confirmed
            ? {
                action: 'reject' as const,
                verified: true,
                method: ['api:all-denied', 'persisted-after-reload'],
                stateAfter: [wixDenied('action')],
                persistedAfterReload: true,
              }
            : {
                action: 'reject' as const,
                verified: false,
                method: [],
                stateAfter: [
                  { ...wixDenied('default'), decision: { responded: false, method: 'unknown' as const } },
                ],
                persistedAfterReload: false,
                reason: 'decision:not-responded',
              },
        }
      : {}),
  });
}

/** The plan of that phase B: no first-layer reject, the settings control opened and its save pressed, or why not. */
export function settingsRejectPlan(reason?: string): BrowserPlan {
  const target = (name: string) => ({ cmpId: 'wix', name, role: 'button', kindConfidence: 'high' as const });
  return {
    pages: [],
    controlPages: [],
    click: {
      B: {
        phase: 'B',
        action: 'reject',
        target: null,
        reason: 'no-unambiguous-reject-at-first-layer',
        settings: {
          open: target('Cookie-Einstellungen'),
          save: reason ? null : target('Speichern'),
          ...(reason ? { reason } : {}),
        },
      },
      C: { phase: 'C', action: 'accept', target: target('Zustimmen') },
    },
  };
}

/** The phase B record of a save in the settings layer, pressed as the reject on the start page. */
export const settingsClick = () => ({ ...click('reject'), cmpId: 'wix', name: 'Speichern' });

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
        firstLayer: firstLayer({ bannerPresent: false, bannerVisible: false, bannerCandidate: candidate }),
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

export const runSiteCheck = (check: AnyCheck, spec?: SiteSpec, ctx?: Parameters<typeof runCheck>[2]) =>
  runCheck(check, site(spec), ctx);

export const runPhaseACheck = (
  check: AnyCheck,
  facts?: Partial<PhaseRecord>,
  spec?: Omit<SiteSpec, 'phases'>,
) => runSiteCheck(check, { ...spec, phases: [phase('A', facts)] });

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
