/**
 * Texts of findings before an interaction say whether a consent banner was found. Without any recorded CMP facts (the
 * extraction failed on every page) the banner was not evaluated: the texts then claim neither an interaction with a
 * banner nor that there is none, as CONSENT-03 and CONSENT-04 stay inconclusive on the same snapshot.
 */
import { describe, expect, it } from 'vitest';
import { consent01 } from '../../../../src/checks/browser/consent-01.ts';
import { consent02 } from '../../../../src/checks/browser/consent-02.ts';
import { consent03 } from '../../../../src/checks/browser/consent-03.ts';
import { embed01 } from '../../../../src/checks/browser/embed-01.ts';
import { embed02 } from '../../../../src/checks/browser/embed-02.ts';
import type { CmpSection } from '../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../src/core/data/messages.ts';
import type { AnyCheck } from '../../../../src/core/evaluation/check.ts';
import type { PhaseRecord } from '../../../../src/core/snapshot/browser.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { cmpFacts, cmpWith, cookie, noBannerCmp, phase, req, site } from './helpers.ts';

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
];

/** CMP facts not recorded on any page: the phase is there, its facts are empty. */
const NOT_OBSERVED: CmpSection = { phases: [{ phase: 'A', facts: [] }] };

/** CMP facts and the `bannerFound` param they give; found or not stay booleans, as in reports written before. */
const CMP: Array<[string, CmpSection, boolean | 'not-observed']> = [
  ['not recorded', NOT_OBSERVED, 'not-observed'],
  ['without a banner', noBannerCmp(), false],
  ['with a recognised CMP', cmpWith({ phase: 'B', facts: [cmpFacts()] }), true],
];

const finding = (check: AnyCheck, input: Partial<PhaseRecord>, cmp: CmpSection) => {
  const [o] = observationsOf(runCheck(check, site({ phases: [phase('A', input)], cmp })));
  expect(o, 'the input gives a finding').toBeDefined();
  return o!;
};

describe('banner state in the texts of findings before an interaction', () => {
  it.each(
    CASES.flatMap(([id, check, input]) =>
      CMP.map(([facts, cmp, value]) => [id, facts, check, input, cmp, value] as const),
    ),
  )('%s with CMP facts %s', (_id, _facts, check, input, cmp, value) => {
    expect(finding(check, input, cmp).params.bannerFound).toBe(value);
  });

  it.each(CASES)(
    '%s: a banner that was not evaluated is neither named nor said to be missing',
    (_id, check, input) => {
      const o = finding(check, input, NOT_OBSERVED);
      const key = `${o.checkId}.${o.variant}`;
      const de = renderMessage(loadTexts('de'), key, o.params).body;
      const en = renderMessage(loadTexts('en'), key, o.params).body;
      expect(de).toMatch(/[Vv]or jeder Interaktion,? \(?Einwilligungsbanner nicht ausgewertet/);
      expect(en).toMatch(/[Bb]efore any interaction,? \(?consent banner not evaluated/);
      expect(`${de}\n${en}`).not.toMatch(/kein Einwilligungsbanner gefunden|no consent banner found/);
      expect(`${de}\n${en}`).not.toMatch(/mit dem Einwilligungsbanner|with the consent banner/);
    },
  );

  it('CONSENT-03 stays inconclusive on the same snapshot, so the other texts do not contradict it', () => {
    const [, , input] = CASES[0]!;
    const pages = phase('A', input);
    const r = runCheck(consent03, site({ phases: [pages], cmp: NOT_OBSERVED }));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'cmp-not-observed' });
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
      }
    },
  );
});
