/**
 * Throttling and browser-check guards:
 * - A phase A cut short by throttling (429/503) is not a clean observation. With evaluable pages
 * the affected checks are `partial` (limitation `throttled`, 5.2); without any evaluable page they are
 * `inconclusive` (reason `throttled`) instead of `completed` without findings.
 * - Counterexamples pin down the browser-check guard conditions.
 */
import { describe, expect, it } from 'vitest';
import { consent01 } from '../../../../src/checks/browser/consent-01.ts';
import { consent02 } from '../../../../src/checks/browser/consent-02.ts';
import { embed01 } from '../../../../src/checks/browser/embed-01.ts';
import { embed02 } from '../../../../src/checks/browser/embed-02.ts';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import { priv01 } from '../../../../src/checks/browser/priv-01.ts';
import { track01 } from '../../../../src/checks/browser/track-01.ts';
import type { AnyCheck } from '../../../../src/core/check.ts';
import { runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { CONTACT, click, cookie, defaultPages, page, phase, req, START, site } from './helpers.ts';

const THROTTLE_CHECKS: Array<[string, AnyCheck]> = [
  ['CONSENT-01', consent01],
  ['CONSENT-02', consent02],
  ['EMBED-01', embed01],
  ['EMBED-02', embed02],
  ['TRACK-01', track01],
];

describe('throttled phase A', () => {
  it.each(THROTTLE_CHECKS)(
    '%s: only a non-evaluable 429 start page → inconclusive (throttled)',
    (_id, check) => {
      const snap = site({
        phases: [
          phase('A', {
            status: 'partial',
            reason: 'throttled',
            pages: [
              page(START, 'start', 'A', {
                evaluable: false,
                notEvaluableReason: 'http-429',
                navigation: { ...defaultPages()[0]!.navigation, status: 429, ok: false },
              }),
            ],
          }),
        ],
      });
      const r = runCheck(check, snap);
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'throttled' });
    },
  );

  it.each(THROTTLE_CHECKS)(
    '%s: evaluable pages before the stop → partial with limitation throttled',
    (_id, check) => {
      const snap = site({
        phases: [phase('A', { status: 'partial', reason: 'throttled', pages: defaultPages().slice(0, 2) })],
      });
      const r = runCheck(check, snap);
      expect(r.status).toBe('partial');
      expect(r.outcome?.limitations).toContain('throttled');
    },
  );

  it('counterexample: an unthrottled phase A stays completed', () => {
    for (const [, check] of THROTTLE_CHECKS) expect(runCheck(check, site()).status).toBe('completed');
  });
});

describe('guard conditions without a counterexample so far', () => {
  it('shared.hasPhaseA: a skipped phase A is no pre-consent observation, even with page records', () => {
    const snap = site({ phases: [phase('A', { status: 'skipped', reason: 'time-budget' })] });
    expect(runCheck(consent01, snap)).toMatchObject({ status: 'inconclusive' });
  });

  it('CONSENT-02: a tracking cookie only attempted (not stored) is info, not a stored identifier', () => {
    const snap = site({ phases: [phase('A', { cookies: [cookie('_ga', { state: 'attempted' })] })] });
    expect(variantsOf(runCheck(consent02, snap))).toEqual(['storage-rejected-or-attempted']);
    const sent = site({ phases: [phase('A', { cookies: [cookie('_ga', { state: 'sent' })] })] });
    expect(variantsOf(runCheck(consent02, sent))).toEqual(['tracking-identifier-stored']);
  });

  it('EMBED-01: fonts loaded only after accept are no finding', () => {
    const snap = site({
      phases: [
        phase('A'),
        phase('C', {
          click: click('accept'),
          requests: [
            req('c1', 'https://fonts.gstatic.com/s/roboto/v30/x.woff2', {
              phase: 'C',
              resourceType: 'font',
              afterClick: true,
              tRef: 'click',
            }),
          ],
        }),
      ],
    });
    expect(variantsOf(runCheck(embed01, snap))).toEqual([]);
  });

  it('EMBED-01: a preconnect hint alone is info, a dns-prefetch on another rel is ignored', () => {
    const hint = (rel: string) =>
      site({
        phases: [
          phase('A', {
            pages: [
              page(START, 'start', 'A', {
                dom: {
                  ...defaultPages()[0]!.dom!,
                  linkRels: [{ rel, href: 'https://fonts.gstatic.com/', source: 'dom' }],
                },
              }),
            ],
          }),
        ],
      });
    expect(variantsOf(runCheck(embed01, hint('preconnect')))).toEqual(['preconnect-only']);
    expect(variantsOf(runCheck(embed01, hint('stylesheet')))).toEqual([]);
  });

  it('EMBED-02: maps on the start page are found even when the contact page could not be evaluated', () => {
    const maps = req('m1', 'https://maps.googleapis.com/maps/api/js?key=[redacted]', {
      resourceType: 'script',
    });
    const pages = [
      page(START, 'start'),
      page(CONTACT, 'contact', 'A', { evaluable: false, notEvaluableReason: 'http-500' }),
    ];
    const r = runCheck(embed02, site({ phases: [phase('A', { pages, requests: [maps] })] }));
    expect(variantsOf(r)).toEqual(['maps-loaded']);
  });

  it('LEGAL-01: the reload of the start page in B does not count as a page without the legal links', () => {
    const reload = page(START, 'start', 'B', {
      reload: true,
      dom: { ...defaultPages()[0]!.dom!, links: [] },
    });
    const r = runCheck(
      legal01,
      site({ phases: [phase('A'), phase('B', { pages: [page(START, 'start', 'B'), reload] })] }),
    );
    expect(variantsOf(r)).toEqual([]);
  });

  it('PRIV-01: a catalog service without any observed stage is not reported', () => {
    // A known tracking host whose request never left the browser has no TRACK-01 stage.
    const blocked = req('b1', 'https://www.google-analytics.com/g/collect?v=2', {
      resourceType: 'ping',
      state: 'blocked-by-browser',
      delivery: 'blocked-by-browser',
      status: undefined,
    });
    const r = runCheck(priv01, site({ phases: [phase('A', { requests: [blocked] })] }));
    expect(variantsOf(r)).toEqual([]);
  });
});
