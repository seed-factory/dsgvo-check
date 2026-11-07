/**
 * A CMP that kept its dialog closed because its own crawler test matched the scanner's User-Agent: every check that
 * reads the CMP's bot signals is inconclusive with a reason that names this cause, never a finding; a dialog that
 * stayed closed without that signal keeps its own reason.
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
import { BOT_USER_AGENT_SIGNAL, type BotSignal, type CmpFacts } from '../../../../../src/cmp/types.ts';
import type { AnyCheck } from '../../../../../src/core/evaluation/check.ts';
import { makeBrowserPlan, runCheck } from '../../../../utils/snapshot-builder.ts';
import { cmpFacts, cmpWith, phase, site, unopenedDialogCmp } from '../helpers.ts';
import { ga } from '../scenarios/shared.ts';

const LABEL = 'CCM19 isBotBrowser (app.js)';
const userAgentSignal: BotSignal = { cmpId: 'ccm19', signal: BOT_USER_AGENT_SIGNAL, detail: LABEL };

/** Every check that reads the bot signals of the CMP facts. */
const SIGNAL_CHECKS: Array<[string, AnyCheck]> = [
  ['CONSENT-01', consent01],
  ['CONSENT-02', consent02],
  ['CONSENT-03', consent03],
  ['CONSENT-04', consent04],
  ['CONSENT-05', consent05],
  ['EMBED-01', embed01],
  ['EMBED-02', embed02],
  ['EMBED-03', embed03],
  ['PRIV-02', priv02],
];
/** The checks that report a dialog the CMP did not open for the scanner. */
const DIALOG_CHECKS = ['CONSENT-03', 'CONSENT-04', 'CONSENT-05'];

/** A GA hit with an identifier before any interaction, which would be a finding of CONSENT-01 and CONSENT-03. */
const tracked = (cmp: ReturnType<typeof unopenedDialogCmp>) =>
  site({
    phases: [phase('A', { requests: [ga.lib('A-1'), ga.hit('A-2')] }), phase('B')],
    cmp,
    plan: makeBrowserPlan(),
  });

const visibleBanner = (p: Partial<CmpFacts> = {}) =>
  cmpFacts({
    firstLayer: {
      bannerPresent: true,
      bannerVisible: true,
      buttons: [],
      purAbo: false,
      closeMeansAccept: null,
    },
    ...p,
  });

const botDiagnostics = (r: ReturnType<typeof runCheck>) =>
  (r.outcome?.diagnostics ?? []).filter((d) => d.code === 'SCAN-BOTMODE');

describe.each(SIGNAL_CHECKS)('%s and a CMP crawler test that matched the scanner', (id, check) => {
  it('inconclusive: the closed dialog with the crawler signal gives the reason that names it, no observation', () => {
    const r = runCheck(check, tracked(unopenedDialogCmp({ botSignals: [userAgentSignal] })));

    expect({ status: r.status, reason: r.reason }).toEqual({
      status: 'inconclusive',
      reason: 'cmp-bot-user-agent',
    });
    expect(r.outcome?.observations).toEqual([]);
    expect(botDiagnostics(r)).toEqual([
      {
        code: 'SCAN-BOTMODE',
        affects: [id],
        params: { signal: BOT_USER_AGENT_SIGNAL, cause: 'user-agent', test: LABEL },
      },
    ]);
  });

  it('counterexample: the same closed dialog without the crawler signal keeps its own reason', () => {
    const r = runCheck(check, tracked(unopenedDialogCmp()));

    expect(r.reason).not.toBe('cmp-bot-user-agent');
    expect(botDiagnostics(r)).toEqual([]);
    if (DIALOG_CHECKS.includes(id)) {
      expect({ status: r.status, reason: r.reason }).toEqual({
        status: 'inconclusive',
        reason: 'cmp-dialog-not-opened',
      });
    }
  });

  it('counterexample: another bot signal of the CMP stays the general bot mode', () => {
    const other: BotSignal = { cmpId: 'ccm19', signal: 'ccm19:bot-branch' };
    const r = runCheck(check, tracked(unopenedDialogCmp({ botSignals: [other] })));

    expect({ status: r.status, reason: r.reason }).toEqual({ status: 'inconclusive', reason: 'bot-mode' });
    expect(botDiagnostics(r)).toEqual([
      { code: 'SCAN-BOTMODE', affects: [id], params: { signal: 'ccm19:bot-branch' } },
    ]);
  });

  it('clean: a banner the CMP opened for the scanner gives no bot reason', () => {
    const r = runCheck(
      check,
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
});

describe('the crawler signal among other bot signals', () => {
  it('names the crawler test, which explains the closed dialog', () => {
    const r = runCheck(
      consent04,
      tracked(
        unopenedDialogCmp({ botSignals: [{ cmpId: 'ccm19', signal: 'ccm19:bot-branch' }, userAgentSignal] }),
      ),
    );

    expect(r.reason).toBe('cmp-bot-user-agent');
    expect(botDiagnostics(r)[0]?.params).toMatchObject({ cause: 'user-agent', test: LABEL });
  });
});
