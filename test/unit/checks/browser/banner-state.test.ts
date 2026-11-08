/**
 * Texts of findings before an interaction say whether a consent banner was found. Without any recorded CMP facts (the
 * extraction failed on every page) the banner was not evaluated: the texts then claim neither an interaction with a
 * banner nor that there is none, as CONSENT-03 and CONSENT-04 stay inconclusive on the same snapshot. A banner that was
 * observed but not recognised is named as such, never as missing.
 */
import { describe, expect, it } from 'vitest';
import { consent01 } from '../../../../src/checks/browser/consent-01.ts';
import { consent02 } from '../../../../src/checks/browser/consent-02.ts';
import { consent03 } from '../../../../src/checks/browser/consent-03.ts';
import { embed01 } from '../../../../src/checks/browser/embed-01.ts';
import { embed02 } from '../../../../src/checks/browser/embed-02.ts';
import { embed03 } from '../../../../src/checks/browser/embed-03.ts';
import type { BannerState } from '../../../../src/checks/browser/signals.ts';
import type { CmpSection } from '../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../src/core/data/messages.ts';
import type { AnyCheck } from '../../../../src/core/evaluation/check.ts';
import type { PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import {
  bannerCandidate,
  bannerLink,
  candidateCmp,
  cmpFacts,
  cmpWith,
  cookie,
  IMPRESSUM,
  noBannerCmp,
  pagesWithLinks,
  phase,
  req,
  START,
  site,
} from './helpers.ts';

/** One check and phase A input that gives it one finding before any interaction. */
const CASES: Array<[string, AnyCheck, Partial<PhaseRecord>]> = [
  ['CONSENT-01', consent01, { requests: [req('a', 'https://www.googletagmanager.com/gtag/js?id=G-ABC')] }],
  ['CONSENT-02', consent02, { cookies: [cookie('_ga')] }],
  [
    'EMBED-01',
    embed01,
    {
      requests: [req('a', 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet' })],
    },
  ],
  [
    'EMBED-02',
    embed02,
    {
      requests: [req('a', 'https://www.google.com/maps/embed?pb=[redacted]', { resourceType: 'document' })],
    },
  ],
  [
    'EMBED-03',
    embed03,
    { requests: [req('a', 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', { resourceType: 'image' })] },
  ],
];

/** CMP facts not recorded on any page: the phase is there, its facts are empty. */
const NOT_OBSERVED: CmpSection = { phases: [{ phase: 'A', facts: [] }] };

const UNRECOGNIZED = candidateCmp(bannerCandidate());
const BANNER_CLAIM =
  /kein Einwilligungsbanner gefunden|no consent banner found|mit dem Einwilligungsbanner|with the consent banner/;
const NOT_EVALUATED = {
  de: /[Vv]or jeder Interaktion,? \(?Einwilligungsbanner nicht ausgewertet/,
  en: /[Bb]efore any interaction,? \(?consent banner not evaluated/,
};

type ExpectedCopy = { de: RegExp; en: RegExp; forbidden: RegExp; phase?: Partial<PhaseRecord> };
const CMP: Array<[string, CmpSection, BannerState, ExpectedCopy?]> = [
  ['not recorded', NOT_OBSERVED, 'not-observed', { ...NOT_EVALUATED, forbidden: BANNER_CLAIM }],
  ['without a banner', noBannerCmp(), false],
  ['with a recognised CMP', cmpWith({ phase: 'B', facts: [cmpFacts()] }), true],
  [
    'with a banner observed but not recognised',
    UNRECOGNIZED,
    'unrecognized',
    {
      de: /[Vv]or jeder Interaktion,? \(?Einwilligungsbanner beobachtet, aber nicht erkannt/,
      en: /[Bb]efore any interaction,? \(?consent banner observed but not recognised/,
      forbidden: BANNER_CLAIM,
    },
  ],
  [
    'with shared banner links in an older snapshot',
    noBannerCmp(),
    'undetermined',
    {
      ...NOT_EVALUATED,
      forbidden: /beobachtet, aber|observed but/,
      phase: { pages: pagesWithLinks({ [START]: [bannerLink()], [IMPRESSUM]: [bannerLink()] }) },
    },
  ],
];

describe('banner state in the texts of findings before an interaction', () => {
  const texts = { de: loadTexts('de'), en: loadTexts('en') };

  it.each(
    CASES.flatMap(([id, check, input]) =>
      CMP.map(([facts, cmp, value, copy]) => [id, facts, check, input, cmp, value, copy] as const),
    ),
  )('%s with CMP facts %s', (_id, _facts, check, input, cmp, value, copy) => {
    const snap = site({ phases: [phase('A', { ...input, ...copy?.phase })], cmp });
    const [finding] = observationsOf(runCheck(check, snap));
    expect(finding?.params.bannerFound).toBe(value);
    if (!copy || !finding) return;

    const key = `${finding.checkId}.${finding.variant}`;
    for (const lang of ['de', 'en'] as const) {
      const { body } = renderMessage(texts[lang], key, finding.params);
      expect(body, lang).toMatch(copy[lang]);
      expect(body, lang).not.toMatch(copy.forbidden);
    }
  });

  it('CONSENT-03 stays inconclusive on the same snapshot, so the other texts do not contradict it', () => {
    const [, , input] = CASES[0]!;
    const pages = phase('A', input);
    const r = runCheck(consent03, site({ phases: [pages], cmp: NOT_OBSERVED }));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'cmp-not-observed' });
    const unrecognized = runCheck(consent03, site({ phases: [pages], cmp: UNRECOGNIZED }));
    expect(unrecognized).toMatchObject({ status: 'inconclusive', reason: 'banner-candidate-unrecognized' });
  });

  it.each(['de', 'en'] as const)(
    '%s: the CONSENT-01 actions point to a banner without saying whether the site has one',
    (lang) => {
      const actions = loadTexts(lang).actions;
      const action = (key: string, bannerFound: boolean | string) =>
        formatMessage(actions[key]!, { service: 'Google Analytics', bannerFound }, lang);
      const own =
        lang === 'de'
          ? /Ihres Einwilligungsbanners|das Einwilligungsbanner/
          : /your consent banner|the consent banner/;
      const some = lang === 'de' ? /eines Einwilligungsbanners|ein Einwilligungsbanner/ : /a consent banner/;
      for (const key of ['CONSENT-01.tracking-completed', 'CONSENT-01.library-loaded']) {
        expect(action(key, true)).toMatch(own);
        expect(action(key, false)).toMatch(some);
        expect(action(key, 'not-observed')).not.toMatch(own);
        expect(action(key, 'not-observed')).not.toMatch(some);
        expect(action(key, 'true, false')).toBe(action(key, 'not-observed'));
        // A banner observed but not recognised may be the site's own or not: the action speaks of either.
        expect(action(key, 'unrecognized')).toBe(action(key, 'not-observed'));
      }
    },
  );
});
