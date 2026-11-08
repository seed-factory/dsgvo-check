/**
 * A CMP that kept its dialog closed because its own crawler test matched the scanner's User-Agent: every check that
 * reads the CMP's bot signals is inconclusive with a reason that names this cause, never a finding; a dialog that
 * stayed closed without that signal keeps its own reason. A direct bot or geo signal of the CMP in phase A or B makes
 * each of these checks inconclusive instead of the finding the same input gives without it.
 */
import { describe, expect, it } from 'vitest';
import { consent01 } from '../../../../../src/checks/browser/consent-01.ts';
import { consent02 } from '../../../../../src/checks/browser/consent-02.ts';
import { consent03 } from '../../../../../src/checks/browser/consent-03.ts';
import { consent04 } from '../../../../../src/checks/browser/consent-04.ts';
import { consent05 } from '../../../../../src/checks/browser/consent-05.ts';
import { embed01 } from '../../../../../src/checks/browser/embed-01.ts';
import { embed02 } from '../../../../../src/checks/browser/embed-02.ts';
import { embed03 } from '../../../../../src/checks/browser/embed-03.ts';
import { priv02 } from '../../../../../src/checks/browser/priv-02.ts';
import { consentSignals, signalOutcome } from '../../../../../src/checks/browser/signals.ts';
import {
  BOT_USER_AGENT_SIGNAL,
  type BotSignal,
  type CmpButton,
  type CmpFacts,
  type CmpSection,
} from '../../../../../src/cmp/types.ts';
import type { AnyCheck } from '../../../../../src/core/evaluation/check.ts';
import type { DiagnosticInput, Snapshot } from '../../../../../src/core/snapshot/index.ts';
import { makeBrowserPlan, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  CONTACT,
  click,
  cmpFacts,
  cmpWith,
  cookie,
  firstLayer,
  noBannerCmp,
  phase,
  rejectCmp,
  req,
  site,
  unopenedDialogCmp,
} from '../helpers.ts';
import { THUMBNAIL, VIDEOS, videoPages } from '../scenarios/embed-03.ts';
import { fontsCss, fontsOnTwoPages, fontsPart, LOCAL_CLAIM, policyWith } from '../scenarios/priv-02.ts';
import { crawlerTestSignal, ga } from '../scenarios/shared.ts';

/** A GA hit with an identifier before any interaction, which would be a finding of CONSENT-01 and CONSENT-03. */
const tracked = (cmp: CmpSection) =>
  site({
    phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] }), phase('B')],
    cmp,
    plan: makeBrowserPlan(),
  });

const visibleBanner = (p: Partial<CmpFacts> = {}) => cmpFacts({ firstLayer: firstLayer(), ...p });

/** An actionable control of the first layer. */
const control = (name: string, kind: CmpButton['kind']): CmpButton => ({
  role: 'button',
  name,
  tag: 'button',
  kind,
  kindConfidence: 'high',
  layer: 1,
  box: { x: 10, y: 600, width: 160, height: 44 },
  visibleAtFirstScreen: true,
  actionableAtFirstScreen: true,
  contrast: 7,
});

/** A recognised first layer that blocks the page and offers "Alle akzeptieren" and "Einstellungen", no reject. */
const blockingBanner = (ph: 'A' | 'B') =>
  cmpFacts({
    phase: ph,
    moment: ph === 'A' ? 'phase-end' : 'first-screen',
    firstLayer: firstLayer({
      buttons: [control('Alle akzeptieren', 'accept'), control('Einstellungen', 'settings')],
    }),
    blocking: {
      overlay: true,
      scrollLock: true,
      inert: false,
      coveredRatio: 0.6,
      method: ['overlay', 'overflow-hidden'],
    },
  });

/**
 * An input of one check that gives `variant` while the CMP reports no signal. `cmp` holds facts in phases A and B, to
 * which a signal case adds its signal; `site` builds the input around it.
 */
interface FindingInput {
  variant: string;
  cmp: CmpSection;
  site: (cmp: CmpSection) => Snapshot;
}

/** CMP facts of phases A and B in which nothing looked like a banner. */
const withoutBanner = noBannerCmp(['A', 'B']);

/** Every check that reads the bot and geo signals of the CMP facts, with an input that gives one of its findings. */
const SIGNAL_CHECKS: Array<[string, AnyCheck, FindingInput]> = [
  ['CONSENT-01', consent01, { variant: 'tracking-completed', cmp: withoutBanner, site: tracked }],
  [
    'CONSENT-02',
    consent02,
    {
      variant: 'tracking-identifier-stored',
      cmp: withoutBanner,
      site: (cmp) => site({ phases: [phase('A', { cookies: [cookie('_ga')] })], cmp }),
    },
  ],
  ['CONSENT-03', consent03, { variant: 'no-banner-consent-services', cmp: withoutBanner, site: tracked }],
  [
    'CONSENT-04',
    consent04,
    {
      variant: 'blocking-no-reject',
      cmp: cmpWith(
        { phase: 'A', facts: [blockingBanner('A')] },
        { phase: 'B', facts: [blockingBanner('B')] },
      ),
      site: (cmp) => site({ phases: [phase('A'), phase('B')], cmp }),
    },
  ],
  [
    'CONSENT-05',
    consent05,
    {
      variant: 'tracking-after-reject',
      cmp: cmpWith(
        { phase: 'A', facts: [cmpFacts({ phase: 'A', moment: 'phase-end' })] },
        ...rejectCmp({ confirmed: true }).phases,
      ),
      site: (cmp) =>
        site({
          phases: [
            phase('A'),
            phase('B', {
              click: click('reject'),
              requests: [ga.hit('B-1', { phase: 'B', afterClick: true })],
            }),
          ],
          cmp,
        }),
    },
  ],
  [
    'EMBED-01',
    embed01,
    {
      variant: 'fonts-loaded',
      cmp: withoutBanner,
      site: (cmp) => site({ phases: [phase('A', { requests: [fontsCss('A-1')] })], cmp }),
    },
  ],
  [
    'EMBED-02',
    embed02,
    {
      variant: 'maps-loaded',
      cmp: withoutBanner,
      site: (cmp) =>
        site({
          phases: [
            phase('A', {
              requests: [
                req('A-1', 'https://maps.googleapis.com/maps/vt?pb=[redacted]', {
                  pageUrl: CONTACT,
                  resourceType: 'image',
                }),
              ],
            }),
          ],
          cmp,
        }),
    },
  ],
  [
    'EMBED-03',
    embed03,
    {
      variant: 'video-loaded',
      cmp: withoutBanner,
      site: (cmp) =>
        site({
          phases: [
            phase('A', {
              pages: videoPages(),
              requests: [req('A-1', THUMBNAIL, { pageUrl: VIDEOS, resourceType: 'image' })],
            }),
          ],
          cmp,
        }),
    },
  ],
  [
    'PRIV-02',
    priv02,
    {
      variant: 'contradiction-replicated',
      cmp: withoutBanner,
      site: (cmp) => fontsOnTwoPages(policyWith(fontsPart(LOCAL_CLAIM)), cmp),
    },
  ],
];
/** The checks that report a dialog the CMP did not open for the scanner. */
const DIALOG_CHECKS = [consent03, consent04, consent05];

const botDiagnostics = (r: ReturnType<typeof runCheck>) =>
  (r.outcome?.diagnostics ?? []).filter((d) => d.code === 'SCAN-BOTMODE');

const OTHER_BOT: BotSignal = { cmpId: 'ccm19', signal: 'ccm19:bot-branch' };

it.each(DIALOG_CHECKS.map((check) => [check.id, check] as const))(
  '%s: the same closed dialog without the crawler signal keeps its own reason',
  (_id, check) => {
    const r = runCheck(check, tracked(unopenedDialogCmp()));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'cmp-dialog-not-opened' });
    expect(botDiagnostics(r)).toEqual([]);
  },
);

it('counterexample: another bot signal of the CMP stays the general bot mode', () => {
  const r = runCheck(consent04, tracked(unopenedDialogCmp({ botSignals: [OTHER_BOT] })));
  expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
  expect(botDiagnostics(r)).toEqual([
    { code: 'SCAN-BOTMODE', affects: [consent04.id], params: { signal: OTHER_BOT.signal } },
  ]);
});

it('clean: a banner the CMP opened for the scanner gives no bot reason', () => {
  const r = runCheck(
    consent04,
    site({
      phases: [phase('A'), phase('B')],
      cmp: cmpWith(
        { phase: 'A', facts: [visibleBanner({ phase: 'A' })] },
        { phase: 'B', facts: [visibleBanner()] },
      ),
      plan: makeBrowserPlan(),
    }),
  );

  expect(r.reason).not.toBe('cmp-bot-user-agent');
  expect(r.reason).not.toBe('bot-mode');
  expect(botDiagnostics(r)).toEqual([]);
});

describe('the crawler signal among other bot signals', () => {
  it('names the crawler test, which explains the closed dialog', () => {
    const r = runCheck(consent04, tracked(unopenedDialogCmp({ botSignals: [OTHER_BOT, crawlerTestSignal] })));

    expect(r.reason).toBe('cmp-bot-user-agent');
    expect(botDiagnostics(r)[0]?.params).toMatchObject({
      cause: 'user-agent',
      test: crawlerTestSignal.detail,
    });
  });
});

/**
 * `cmp` with `signal` added to every fact of phase `ph`. An input without facts there gets no signal and keeps its
 * finding, so a signal case cannot pass on it.
 */
const withSignal = (cmp: CmpSection, ph: 'A' | 'B', signal: Partial<CmpFacts>): CmpSection => ({
  ...cmp,
  phases: cmp.phases.map((p) =>
    p.phase === ph ? { ...p, facts: p.facts.map((f) => ({ ...f, ...signal })) } : p,
  ),
});

const SPIDER: BotSignal = { cmpId: 'cookiebot', signal: 'cookiebot:isSpider' };

/** A direct signal in the CMP facts of one phase, the reason it gives and its diagnostic (without `affects`). */
type SignalCase = [string, 'A' | 'B', Partial<CmpFacts>, string, Omit<DiagnosticInput, 'affects'>];

const CHECK_SIGNALS: SignalCase[] = [
  [
    'a bot signal in phase A (cookiebot:isSpider)',
    'A',
    { botSignals: [SPIDER] },
    'bot-mode',
    { code: 'SCAN-BOTMODE', params: { signal: 'cookiebot:isSpider' } },
  ],
  [
    'a geo signal in phase B (out of region)',
    'B',
    { geoSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isOutOfRegion' }] },
    'geo',
    { code: 'SCAN-GEO', params: { signal: 'cookiebot:isOutOfRegion' } },
  ],
];

const OTHER_PHASE_SIGNALS: SignalCase[] = [
  [
    'a bot signal in phase B (cookiebot:isSpider)',
    'B',
    { botSignals: [SPIDER] },
    'bot-mode',
    { code: 'SCAN-BOTMODE', params: { signal: 'cookiebot:isSpider' } },
  ],
  [
    'a geo signal in phase A (TCF gdprApplies=false)',
    'A',
    { geoSignals: [{ cmpId: 'tcf', signal: 'tcf:gdprApplies=false' }] },
    'geo',
    { code: 'SCAN-GEO', params: { signal: 'tcf:gdprApplies=false' } },
  ],
];

describe.each(SIGNAL_CHECKS)('%s and CMP bot and geo signals', (id, check, finding) => {
  it('inconclusive: the closed dialog with the crawler signal gives the reason that names it, no observation', () => {
    const r = runCheck(check, tracked(unopenedDialogCmp({ botSignals: [crawlerTestSignal] })));

    expect({ status: r.status, reason: r.reason }).toEqual({
      status: 'inconclusive',
      reason: 'cmp-bot-user-agent',
    });
    expect(r.outcome?.observations).toEqual([]);
    expect(botDiagnostics(r)).toEqual([
      {
        code: 'SCAN-BOTMODE',
        affects: [id],
        params: { signal: BOT_USER_AGENT_SIGNAL, cause: 'user-agent', test: crawlerTestSignal.detail },
      },
    ]);
  });

  it('counterexample: the same input without a signal gives the finding', () => {
    const r = runCheck(check, finding.site(finding.cmp));

    expect(r.status).toBe('completed');
    expect(variantsOf(r)).toEqual([finding.variant]);
  });

  it.each(CHECK_SIGNALS)(
    '%s → inconclusive with its diagnostic, no observation',
    (_name, ph, signal, reason, diagnostic) => {
      const r = runCheck(check, finding.site(withSignal(finding.cmp, ph, signal)));

      expect({ status: r.status, reason: r.reason }).toEqual({ status: 'inconclusive', reason });
      expect(r.outcome?.observations).toEqual([]);
      expect(r.outcome?.diagnostics).toEqual([{ ...diagnostic, affects: [id] }]);
    },
  );
});

it.each(OTHER_PHASE_SIGNALS)(
  '%s gives its diagnostic through the shared signal evaluation',
  (_name, ph, signal, reason, diagnostic) => {
    const signals = consentSignals(withSignal(withoutBanner, ph, signal), ['A', 'B']);
    expect(signalOutcome(consent04.id, signals)).toEqual({
      status: 'inconclusive',
      reason,
      observations: [],
      diagnostics: [{ ...diagnostic, affects: [consent04.id] }],
    });
  },
);
