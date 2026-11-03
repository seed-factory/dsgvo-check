import { describe, expect, it } from 'vitest';
import { embed01 } from '../../../../src/checks/browser/embed-01.ts';
import { makeDom, observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { click, cmpFacts, cmpWith, defaultPages, page, phase, req, START, site } from './helpers.ts';
import { SCENARIOS } from './scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['EMBED-01']!.find((s) => s.file === file)!.build();
const css = (id: string, p = {}) =>
  req(id, 'https://fonts.googleapis.com/css2?family=Roboto', { resourceType: 'stylesheet', ...p });

describe('EMBED-01 external fonts', () => {
  it('violation: Google Fonts CSS and font file → fonts-loaded', () => {
    const [o] = observationsOf(runCheck(embed01, scenario('violation-google-fonts.json')));
    expect(o).toMatchObject({
      variant: 'fonts-loaded',
      subject: 'google-fonts',
      category: 'fonts',
      params: { service: 'Google Fonts', pageCount: 1, afterReject: false },
    });
    expect(o?.evidence).toHaveLength(2);
  });

  it('clean: self-hosted fonts', () => {
    expect(variantsOf(runCheck(embed01, scenario('clean-self-hosted.json')))).toEqual([]);
  });

  it('inconclusive: no phase A', () => {
    expect(runCheck(embed01, scenario('inconclusive-no-network.json'))).toMatchObject({
      status: 'inconclusive',
    });
  });

  it('counterexample: preconnect to fonts.gstatic.com without a download → preconnect-only (info), not warning', () => {
    const start = page(START, 'start', 'A', {
      dom: makeDom({ linkRels: [{ rel: 'preconnect', href: 'https://fonts.gstatic.com/', source: 'dom' }] }),
    });
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { pages: [start, ...defaultPages('A').slice(1)] })] }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({ variant: 'preconnect-only', subject: 'google-fonts' });
    expect(o?.evidence[0]).toMatchObject({
      type: 'link',
      href: 'https://fonts.gstatic.com/',
      text: 'rel=preconnect',
    });
  });

  it('counterexample: an unfinished font request is not a load', () => {
    const r = runCheck(
      embed01,
      site({ phases: [phase('A', { requests: [css('a', { state: 'failed', status: undefined })] })] }),
    );
    expect(variantsOf(r)).toEqual(['preconnect-only']);
  });

  it('a load after the reject stays fonts-loaded; a load only after accept is no finding', () => {
    const afterReject = runCheck(
      embed01,
      site({
        phases: [
          phase('A'),
          phase('B', { click: click('reject'), requests: [css('b', { phase: 'B', afterClick: true })] }),
        ],
      }),
    );
    expect(observationsOf(afterReject)[0]).toMatchObject({
      variant: 'fonts-loaded',
      phases: ['B'],
      params: { afterReject: true },
    });
    const afterAccept = runCheck(
      embed01,
      site({
        phases: [
          phase('A'),
          phase('C', { click: click('accept'), requests: [css('c', { phase: 'C', afterClick: true })] }),
        ],
      }),
    );
    expect(variantsOf(afterAccept)).toEqual([]);
  });

  it('p.typekit.net alone (purpose not verified) is not a font load; Bunny Fonts (EU) still is', () => {
    const typekit = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://p.typekit.net/p.css?s=1', { resourceType: 'stylesheet' })],
          }),
        ],
      }),
    );
    expect(variantsOf(typekit)).toEqual([]);
    const bunny = runCheck(
      embed01,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://fonts.bunny.net/css?family=inter', { resourceType: 'stylesheet' })],
          }),
        ],
      }),
    );
    expect(observationsOf(bunny)[0]).toMatchObject({ variant: 'fonts-loaded', provider: { country: 'SI' } });
  });

  it('the collector gap "preconnect-without-request" (as in BASE_KNOWN_GAPS) is reported as a limitation', () => {
    const gaps = ['pagehide-beacons', 'preconnect-without-request', 'blocked-cookies-not-recorded'];
    const r = runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })], knownGaps: gaps }));
    expect(r.outcome?.limitations).toEqual(['preconnect-not-observable']);
    const none = runCheck(embed01, site({ phases: [phase('A', { requests: [css('a')] })] }));
    expect(none.outcome?.limitations).toEqual([]);
  });

  it('bot signal → inconclusive', () => {
    const r = runCheck(
      embed01,
      site({
        phases: [phase('A', { requests: [css('a')] })],
        cmp: cmpWith({
          phase: 'A',
          facts: [
            cmpFacts({ phase: 'A', botSignals: [{ cmpId: 'cookiebot', signal: 'cookiebot:isSpider' }] }),
          ],
        }),
      }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'bot-mode' });
  });
});
