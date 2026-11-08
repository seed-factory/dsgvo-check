/**
 * A banner that was observed but not recognised: the generic heuristic kept a banner-shaped candidate without taking it.
 * CONSENT-03 then stays inconclusive instead of "no banner", CONSENT-04 reports "Banner nicht erkannt" (info), and
 * CONSENT-05 is inconclusive, as for a banner the heuristic found. In snapshots written before that fact, the same
 * visible link of a banner-named container on two pages of phase A is a weaker sign: the DOM collector names
 * component wrappers (`cmp-navigation`) like banners, so it leaves the banner undetermined and claims no observation.
 */
import { describe, expect, it } from 'vitest';
import { consent03 } from '../../../../../src/checks/browser/consent-03.ts';
import { consent04 } from '../../../../../src/checks/browser/consent-04.ts';
import { consent05 } from '../../../../../src/checks/browser/consent-05.ts';
import { bannerState } from '../../../../../src/checks/browser/signals.ts';
import type { BannerCandidateFact, CmpFacts, CmpSection } from '../../../../../src/cmp/types.ts';
import { defaultConfig } from '../../../../../src/core/config/schema.ts';
import { checkThresholds } from '../../../../../src/core/config/thresholds.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import type { PageVisit } from '../../../../../src/core/snapshot/browser.ts';
import { makeCmpFacts, observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  bannerCandidate,
  bannerLink,
  CONTACT,
  candidateCmp,
  cmpFacts,
  cmpWith,
  firstLayer,
  IMPRESSUM,
  noBannerCmp,
  PRIVACY,
  pagesWithLinks,
  phase,
  req,
  START,
  site,
} from '../helpers.ts';

const gaHit = () =>
  req('A-1', 'https://www.google-analytics.com/g/collect?v=2&cid=[redacted]', {
    resourceType: 'ping',
    identifierPresent: true,
    identifierNames: ['cid'],
  });

interface Case {
  cmp: CmpSection;
  pages?: PageVisit[];
}

const snapshot = ({ cmp, pages }: Case) =>
  site({ phases: [phase('A', { requests: [gaHit()], ...(pages ? { pages } : {}) })], cmp });

const candidate = (p: Partial<BannerCandidateFact> = {}, pages?: string[]) =>
  candidateCmp(bannerCandidate(p), pages);

/** Snapshots with a banner observed but not recognised. */
const OBSERVED: Array<[string, Case]> = [
  ['a candidate with one keyword and a settings button on two pages', { cmp: candidate() }],
  ['a candidate on the start page only', { cmp: candidate({}, [START]) }],
  ['a candidate on two subpages, not on the start page', { cmp: candidate({}, [IMPRESSUM, PRIVACY]) }],
  [
    'a candidate without cookie wording but with a reject button',
    { cmp: candidate({ controls: ['reject', 'other'], cookieWording: false }) },
  ],
  [
    'a banner-named candidate whose only control is a close button',
    { cmp: candidate({ reason: 'no-control', controls: ['other'], named: true }) },
  ],
  [
    'a fixed box with cookie wording and two keywords whose buttons the lexicon cannot read (no role, a long name)',
    { cmp: candidate({ reason: 'no-control', keywordHits: 2, controls: [] }) },
  ],
  [
    'a dialog with cookie wording and two keywords whose only control is unknown',
    {
      cmp: candidate({
        reason: 'no-control',
        keywordHits: 2,
        controls: ['other'],
        fixed: false,
        dialog: true,
      }),
    },
  ],
];

/** Older snapshots without the candidate fact, where a banner can neither be confirmed nor ruled out. */
const UNDETERMINED: Array<[string, Case]> = [
  [
    'the same visible banner link on two pages',
    {
      cmp: noBannerCmp(),
      pages: pagesWithLinks({ [START]: [bannerLink()], [IMPRESSUM]: [bannerLink()] }),
    },
  ],
  [
    'navigation links of a component named like a banner (`cmp-navigation`) on every page',
    {
      cmp: noBannerCmp(),
      pages: pagesWithLinks({
        [START]: [bannerLink({ text: 'Produkte', href: START })],
        [IMPRESSUM]: [bannerLink({ text: 'Produkte', href: START })],
        [CONTACT]: [bannerLink({ text: 'Produkte', href: START })],
      }),
    },
  ],
];

/** Snapshots where nothing counts as a banner. */
const NOT_OBSERVED: Array<[string, Case]> = [
  ['the heuristic saw no candidate', { cmp: candidateCmp(null) }],
  [
    'a candidate inside a header or footer (settings link strip)',
    { cmp: candidate({ reason: 'page-section', keywordHits: 2 }) },
  ],
  [
    'a candidate without a banner name and without a control the lexicon knows (chat, newsletter)',
    { cmp: candidate({ reason: 'keywords', controls: ['other'] }) },
  ],
  [
    'a candidate without cookie wording whose controls are "Details" or "Mehr Informationen" (chat, newsletter)',
    { cmp: candidate({ reason: 'keywords', controls: ['settings', 'other'], cookieWording: false }) },
  ],
  ['a candidate on one subpage only (table of contents of the policy)', { cmp: candidate({}, [PRIVACY]) }],
  [
    'a fixed box with two keywords but without cookie wording and without a control the lexicon knows (newsletter)',
    { cmp: candidate({ reason: 'no-control', keywordHits: 2, controls: ['other'], cookieWording: false }) },
  ],
  [
    'a static notice with cookie wording and two keywords but without a control the lexicon knows',
    { cmp: candidate({ reason: 'no-control', keywordHits: 2, controls: [], fixed: false }) },
  ],
  [
    'the candidate fact is recorded (none seen), so banner links do not count',
    {
      cmp: candidateCmp(null),
      pages: pagesWithLinks({ [START]: [bannerLink()], [IMPRESSUM]: [bannerLink()] }),
    },
  ],
  [
    'an older snapshot: banner links of the policy table of contents and of the navigation, each on one page',
    {
      cmp: noBannerCmp(),
      pages: pagesWithLinks({
        [PRIVACY]: [bannerLink({ text: 'Welche Cookies wir setzen', href: `${PRIVACY}#cookies` })],
        [CONTACT]: [bannerLink({ text: 'Kontakt', href: CONTACT })],
      }),
    },
  ],
  [
    'an older snapshot: the banner link on two pages, but not visible',
    {
      cmp: noBannerCmp(),
      pages: pagesWithLinks({
        [START]: [bannerLink({ visible: false })],
        [IMPRESSUM]: [bannerLink({ visible: false })],
      }),
    },
  ],
];

describe('a banner observed but not recognised', () => {
  it.each([
    ...OBSERVED.map(([name, input]) => [name, input, 'unrecognized'] as const),
    ...NOT_OBSERVED.map(([name, input]) => [name, input, false] as const),
    ...UNDETERMINED.map(([name, input]) => [name, input, 'undetermined'] as const),
  ])('%s', (_name, input, expected) => {
    const { browser } = snapshot(input);
    const { minCandidatePages } = checkThresholds(defaultConfig()).cmp;
    expect(bannerState(input.cmp, browser!, minCandidatePages)).toBe(expected);
  });

  it('an unrecognized candidate blocks a no-banner finding and is reported as info', () => {
    const snap = snapshot(OBSERVED[0]![1]);
    const missing = runCheck(consent03, snap);
    expect(missing).toMatchObject({ status: 'inconclusive', reason: 'banner-candidate-unrecognized' });
    expect(variantsOf(missing)).toEqual([]);

    const design = runCheck(consent04, snap);
    expect(design).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
    expect(variantsOf(design)).toEqual(['banner-not-recognized']);
    expect(runCheck(consent05, snap)).toMatchObject({
      status: 'inconclusive',
      reason: 'banner-not-recognized',
    });
  });

  it('counterexample: without a candidate, the no-banner finding stays', () => {
    const snap = snapshot(NOT_OBSERVED[0]![1]);
    expect(variantsOf(runCheck(consent03, snap))).toEqual(['no-banner-consent-services']);
    for (const check of [consent04, consent05]) {
      expect(runCheck(check, snap), check.id).toMatchObject({
        status: 'not_applicable',
        reason: 'no-banner',
      });
    }
  });

  it('legacy banner links alone leave all three checks inconclusive', () => {
    const snap = snapshot(UNDETERMINED[0]![1]);
    for (const check of [consent03, consent04, consent05]) {
      const result = runCheck(check, snap);
      expect(result, check.id).toMatchObject({ status: 'inconclusive', reason: 'banner-undetermined' });
      expect(variantsOf(result), check.id).toEqual([]);
    }
  });

  it('the settings decide on how many subpages a candidate must show; the start page always counts', () => {
    const base = checkThresholds(defaultConfig());
    const thresholds = { ...base, cmp: { ...base.cmp, minCandidatePages: 3 } };
    const twoSubpages = snapshot({ cmp: candidate({}, [IMPRESSUM, PRIVACY]) });
    expect(variantsOf(runCheck(consent03, twoSubpages, { thresholds }))).toEqual([
      'no-banner-consent-services',
    ]);
    expect(runCheck(consent03, snapshot({ cmp: candidate({}, [START]) }), { thresholds })).toMatchObject({
      status: 'inconclusive',
      reason: 'banner-candidate-unrecognized',
    });
  });

  it('without anything loaded that needs consent there is nothing to conclude: completed', () => {
    const r = runCheck(consent03, site({ cmp: candidate() }));
    expect(r).toMatchObject({ status: 'completed' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('the info names the features of the candidate as its evidence, not the buttons of a banner that was not read', () => {
    const [o] = observationsOf(runCheck(consent04, snapshot({ cmp: candidate() })));
    const cmpEvidence = o?.evidence.filter((e) => e.type === 'cmp') ?? [];
    expect(cmpEvidence).toHaveLength(1);
    expect(cmpEvidence[0]).toMatchObject({ candidate: bannerCandidate(), cmpId: null });
    expect(cmpEvidence[0]).not.toHaveProperty('buttons');
    expect(cmpEvidence[0]).not.toHaveProperty('blocking');
    expect(o?.classification?.source).toBe('heuristic');

    for (const lang of ['de', 'en'] as const) {
      const body = renderMessage(
        loadTexts(lang),
        'CONSENT-04.banner-not-recognized',
        o?.params as never,
      ).body;
      expect(body).not.toMatch(/gemessenen Fakten|measured facts/);
      expect(body).toMatch(/bannerähnlich|banner-like/);
    }
  });
});

/** Phase A facts on every page: a banner the heuristic took on `found`, nothing banner-like on the others. */
function heuristicCmp(found: readonly string[], layer: Partial<CmpFacts['firstLayer']> = {}): CmpSection {
  return cmpWith({
    phase: 'A',
    facts: [START, IMPRESSUM, PRIVACY, CONTACT].map((pageUrl) =>
      found.includes(pageUrl)
        ? makeCmpFacts({
            phase: 'A',
            pageUrl,
            moment: 'first-screen',
            detection: {
              cmpId: null,
              method: 'heuristic',
              version: null,
              versionSupported: null,
              recognitionConfidence: 'medium',
              signals: ['heuristic:fixed', 'heuristic:keywords:3', 'heuristic:controls:4'],
            },
            firstLayer: firstLayer(layer),
          })
        : makeCmpFacts({
            phase: 'A',
            pageUrl,
            moment: 'first-screen',
            firstLayer: firstLayer({ bannerPresent: false, bannerVisible: false, bannerCandidate: null }),
          }),
    ),
  });
}

// A banner shows on every page of phase A until it is answered: what the heuristic took on one subpage only (a sticky
// table of contents of the policy, an embedded policy) is part of that page, like a dismissed candidate there.
describe('a banner the heuristic took', () => {
  const PART_OF_A_PAGE: Array<[string, CmpSection]> = [
    ['on one subpage only', heuristicCmp([PRIVACY])],
    [
      'as an unresolved consent iframe on one subpage only',
      heuristicCmp([PRIVACY], { consentFrameUnresolved: true }),
    ],
  ];
  const BANNER: Array<[string, CmpSection]> = [
    ['on the start page', heuristicCmp([START])],
    ['on two subpages', heuristicCmp([IMPRESSUM, CONTACT])],
  ];

  it.each(PART_OF_A_PAGE)(
    '%s: CONSENT-03 keeps the no-banner finding, CONSENT-04 and -05 see no banner',
    (_n, cmp) => {
      expect(variantsOf(runCheck(consent03, snapshot({ cmp })))).toEqual(['no-banner-consent-services']);
      expect(runCheck(consent04, snapshot({ cmp }))).toMatchObject({
        status: 'not_applicable',
        reason: 'no-banner',
      });
      expect(runCheck(consent05, snapshot({ cmp }))).toMatchObject({
        status: 'not_applicable',
        reason: 'no-banner',
      });
    },
  );

  it.each(BANNER)(
    '%s: a banner, CONSENT-03 without a finding, CONSENT-04 "Banner nicht erkannt"',
    (_n, cmp) => {
      const r = runCheck(consent03, snapshot({ cmp }));
      expect(r).toMatchObject({ status: 'completed' });
      expect(variantsOf(r)).toEqual([]);
      expect(variantsOf(runCheck(consent04, snapshot({ cmp })))).toEqual(['banner-not-recognized']);
    },
  );

  it('an unresolved consent iframe on the start page limits the conclusion', () => {
    const cmp = heuristicCmp([START], { consentFrameUnresolved: true });
    expect(runCheck(consent03, snapshot({ cmp }))).toMatchObject({
      status: 'inconclusive',
      reason: 'consent-frame-unresolved',
    });
  });

  it('counterexample: a CMP an adapter recognised on one subpage only is a banner', () => {
    const cmp = cmpWith({ phase: 'A', facts: [cmpFacts({ phase: 'A', pageUrl: CONTACT })] });
    const r = runCheck(consent03, snapshot({ cmp }));
    expect(r).toMatchObject({ status: 'completed' });
    expect(variantsOf(r)).toEqual([]);
  });
});
