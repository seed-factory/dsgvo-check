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
import type { BannerCandidateFact, CmpSection } from '../../../../../src/cmp/types.ts';
import { defaultConfig } from '../../../../../src/core/config/schema.ts';
import { checkThresholds } from '../../../../../src/core/config/thresholds.ts';
import type { PageVisit } from '../../../../../src/core/snapshot/browser.ts';
import { runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  bannerCandidate,
  bannerLink,
  CONTACT,
  candidateCmp,
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
  describe('CONSENT-03', () => {
    it.each(OBSERVED)('%s: inconclusive, no "no banner" finding', (_name, c) => {
      const r = runCheck(consent03, snapshot(c));
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-candidate-unrecognized' });
      expect(variantsOf(r)).toEqual([]);
    });

    it.each(NOT_OBSERVED)('counterexample, %s: the no-banner finding stays', (_name, c) => {
      expect(variantsOf(runCheck(consent03, snapshot(c)))).toEqual(['no-banner-consent-services']);
    });

    it.each(UNDETERMINED)('an older snapshot, %s: inconclusive, the banner undetermined', (_name, c) => {
      const r = runCheck(consent03, snapshot(c));
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-undetermined' });
      expect(variantsOf(r)).toEqual([]);
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
  });

  describe('CONSENT-04', () => {
    it.each(OBSERVED)('%s: info "Banner nicht erkannt", inconclusive', (_name, c) => {
      const r = runCheck(consent04, snapshot(c));
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
      expect(variantsOf(r)).toEqual(['banner-not-recognized']);
    });

    it.each(NOT_OBSERVED)('counterexample, %s: no banner, not applicable', (_name, c) => {
      expect(runCheck(consent04, snapshot(c))).toMatchObject({
        status: 'not_applicable',
        reason: 'no-banner',
      });
    });

    it.each(UNDETERMINED)('an older snapshot, %s: inconclusive without a finding', (_name, c) => {
      const r = runCheck(consent04, snapshot(c));
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-undetermined' });
      expect(variantsOf(r)).toEqual([]);
    });
  });

  describe('CONSENT-05', () => {
    it.each(OBSERVED)('%s: the reject was not clicked, inconclusive', (_name, c) => {
      const r = runCheck(consent05, snapshot(c));
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'banner-not-recognized' });
    });

    it.each(NOT_OBSERVED)('counterexample, %s: no banner, not applicable', (_name, c) => {
      expect(runCheck(consent05, snapshot(c))).toMatchObject({
        status: 'not_applicable',
        reason: 'no-banner',
      });
    });

    it.each(UNDETERMINED)('an older snapshot, %s: inconclusive, the banner undetermined', (_name, c) => {
      expect(runCheck(consent05, snapshot(c))).toMatchObject({
        status: 'inconclusive',
        reason: 'banner-undetermined',
      });
    });
  });
});
