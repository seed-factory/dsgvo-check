import { describe, expect, it } from 'vitest';
import { consent03 } from '../../../../src/checks/browser/consent-03.ts';
import type { CmpFacts } from '../../../../src/cmp/types.ts';
import { makeCmpFacts, observationsOf, runCheck, variantsOf } from '../../../utils/snapshot-builder.ts';
import { cmpFacts, cmpWith, cookie, defaultPages, phase, req, START, site, storage } from './helpers.ts';
import { SCENARIOS } from './scenarios.ts';

const scenario = (file: string) => SCENARIOS['CONSENT-03']!.find((s) => s.file === file)!.build();
const gaHit = (id = 'a', p: Partial<Parameters<typeof req>[2]> = {}) =>
  req(id, p?.url ?? 'https://www.google-analytics.com/g/collect?v=2&cid=[redacted]', {
    resourceType: 'ping',
    identifierPresent: true,
    identifierNames: ['cid'],
    ...p,
  });

describe('CONSENT-03 no consent dialog', () => {
  it('violation: no candidate, GA hit with identifier, EEA asserted → critical variant with "laut Nutzerangabe"', () => {
    const r = runCheck(consent03, scenario('violation-no-banner-ga-region-asserted.json'));
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'no-banner-strong-tracking',
      subject: 'consent-ui',
      params: { services: 'Google Analytics', pageCount: 4, regionAsserted: true, strongTracking: true },
    });
    expect(o?.evidence.some((e) => e.type === 'page')).toBe(true);
  });

  it('clean: only fonts and CDN → not CONSENT-03', () => {
    expect(variantsOf(runCheck(consent03, scenario('clean-fonts-only.json')))).toEqual([]);
  });

  it('inconclusive: direct geo signal → SCAN-GEO', () => {
    const r = runCheck(consent03, scenario('inconclusive-geo.json'));
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'geo' });
    expect(r.outcome?.diagnostics?.[0]).toMatchObject({ code: 'SCAN-GEO', affects: ['CONSENT-03'] });
  });

  it('region not asserted → warning variant even with strong tracking', () => {
    const r = runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })] }));
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'no-banner-consent-services',
      params: { regionAsserted: false },
    });
  });

  it('counterexample: a heuristic banner candidate is CONSENT-04 territory, not "no banner"', () => {
    const cmp = cmpWith({
      phase: 'A',
      facts: [
        makeCmpFacts({
          phase: 'A',
          pageUrl: START,
          detection: {
            cmpId: null,
            method: 'heuristic',
            version: null,
            versionSupported: null,
            recognitionConfidence: 'low',
            signals: ['heuristic:dialog'],
          },
          firstLayer: {
            bannerPresent: true,
            bannerVisible: true,
            buttons: [],
            purAbo: false,
            closeMeansAccept: null,
          },
        }),
      ],
    });
    expect(
      variantsOf(runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })], cmp }))),
    ).toEqual([]);
  });

  it('a recognised CMP anywhere means a banner exists', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [phase('A', { requests: [gaHit()] })],
        cmp: cmpWith({ phase: 'B', facts: [cmpFacts()] }),
      }),
    );
    expect(r).toMatchObject({ status: 'completed' });
    expect(variantsOf(r)).toEqual([]);
  });

  it('an embed writing storage needs consent: YouTube localStorage before interaction → warning variant', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [
          phase('A', {
            requests: [req('a', 'https://www.youtube.com/embed/abc', { resourceType: 'document' })],
            storage: [
              storage('yt-remote-device-id', { origin: 'https://www.youtube.com', firstParty: false }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'no-banner-consent-services',
      params: { services: 'YouTube' },
    });
  });

  it('tracking storage alone is strong tracking', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [phase('A', { cookies: [cookie('_fbp')] })],
        environment: {
          egress: { mode: 'direct', region: 'asserted', assertedRegion: 'eea', source: 'laut Nutzerangabe' },
        },
      }),
    );
    expect(variantsOf(r)).toEqual(['no-banner-strong-tracking']);
  });

  const asserted = {
    egress: { mode: 'direct', region: 'asserted', assertedRegion: 'eea', source: 'laut Nutzerangabe' },
  } as const;

  it('a cookieless Consent Mode ping is no strong tracking → warning variant even with an asserted region', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [
          phase('A', {
            requests: [
              gaHit('a', { url: 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]' }),
            ],
          }),
        ],
        environment: asserted,
      }),
    );
    expect(observationsOf(r).map((o) => [o.variant, o.params.strongTracking])).toEqual([
      ['no-banner-consent-services', false],
    ]);
  });

  it('analogue: a denied ping whose identifier matches stored data is strong tracking', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [
          phase('A', {
            requests: [
              gaHit('a', {
                url: 'https://www.google-analytics.com/g/collect?v=2&gcs=G100&cid=[redacted]',
                matchesStoredIdentifier: true,
              }),
            ],
          }),
        ],
        environment: asserted,
      }),
    );
    expect(variantsOf(r)).toEqual(['no-banner-strong-tracking']);
  });

  it('assume-region reaches the check through ctx.options even when the snapshot egress is unknown', () => {
    const snap = site({ phases: [phase('A', { requests: [gaHit()] })] });
    expect(snap.environment.egress.region).toBe('unknown');
    const r = runCheck(consent03, snap, {
      options: { strict: false, assumeRegion: 'de', fromSnapshot: false },
    });
    expect(observationsOf(r).map((o) => [o.variant, o.params.regionAsserted])).toEqual([
      ['no-banner-strong-tracking', true],
    ]);
  });

  it('a first-party tracking endpoint (tag gateway) without a banner counts as tracking', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', `${START}metrics/g/collect?v=2&tid=G-1&cid=[redacted]`, {
                resourceType: 'ping',
                identifierPresent: true,
                identifierNames: ['cid'],
              }),
            ],
          }),
        ],
      }),
    );
    expect(observationsOf(r).map((o) => [o.variant, o.params.services])).toEqual([
      ['no-banner-consent-services', 'Google Analytics'],
    ]);
  });

  it('one evaluable page is not enough → inconclusive', () => {
    const r = runCheck(
      consent03,
      site({ phases: [phase('A', { pages: defaultPages('A').slice(0, 1), requests: [gaHit()] })] }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'insufficient-pages' });
  });

  it('no CMP facts recorded → inconclusive (absence is not established)', () => {
    const r = runCheck(
      consent03,
      site({ phases: [phase('A', { requests: [gaHit()] })], cmp: { phases: [] } }),
    );
    expect(r).toMatchObject({ status: 'inconclusive', reason: 'cmp-not-observed' });
  });

  // : banners found by the extended heuristic (other languages, static notice) are CONSENT-04 territory.
  it.each(['heuristic:static', 'heuristic:fixed'])(
    'counterexample: a heuristic candidate with signal %s is a banner, not "no banner"',
    (signal) => {
      const cmp = cmpWith({
        phase: 'A',
        facts: [
          makeCmpFacts({
            phase: 'A',
            pageUrl: START,
            detection: {
              cmpId: null,
              method: 'heuristic',
              version: null,
              versionSupported: null,
              recognitionConfidence: 'low',
              signals: [signal, 'heuristic:keywords:2'],
            },
            firstLayer: {
              bannerPresent: true,
              bannerVisible: true,
              buttons: [],
              purAbo: false,
              closeMeansAccept: null,
            },
          }),
        ],
      });
      const r = runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })], cmp }));
      expect(r).toMatchObject({ status: 'completed' });
      expect(variantsOf(r)).toEqual([]);
    },
  );

  // : a visible consent-looking iframe whose content could not be resolved limits the "no banner" conclusion.
  describe('unresolved consent iframe', () => {
    const frameCandidate = (p: Partial<CmpFacts['firstLayer']> = {}) =>
      makeCmpFacts({
        phase: 'A',
        pageUrl: START,
        detection: {
          cmpId: null,
          method: 'heuristic',
          version: null,
          versionSupported: null,
          recognitionConfidence: 'low',
          signals: ['heuristic:frame-candidate'],
        },
        firstLayer: {
          bannerPresent: true,
          bannerVisible: true,
          buttons: [],
          purAbo: false,
          closeMeansAccept: null,
          consentFrameUnresolved: true,
          ...p,
        },
      });

    it('tracking before interaction and an unresolved consent frame: inconclusive, no no-banner finding', () => {
      const r = runCheck(
        consent03,
        site({
          phases: [phase('A', { requests: [gaHit()] })],
          cmp: cmpWith({ phase: 'A', facts: [frameCandidate()] }),
        }),
      );
      expect(r).toMatchObject({ status: 'inconclusive', reason: 'consent-frame-unresolved' });
      expect(r.outcome?.limitations).toContain('consent-frame-unresolved');
      expect(variantsOf(r)).toEqual([]);
    });

    it('counterexample: without such a candidate the same tracking still gives the no-banner finding', () => {
      const r = runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })] }));
      expect(variantsOf(r)).toEqual(['no-banner-consent-services']);
    });

    it('a resolved banner anywhere keeps "a banner exists" (completed, no finding), frame candidate or not', () => {
      const r = runCheck(
        consent03,
        site({
          phases: [phase('A', { requests: [gaHit()] })],
          cmp: cmpWith({ phase: 'A', facts: [frameCandidate()] }, { phase: 'B', facts: [cmpFacts()] }),
        }),
      );
      expect(r).toMatchObject({ status: 'completed' });
      expect(variantsOf(r)).toEqual([]);
    });

    it('no tracking observed: nothing to conclude either way, no spurious inconclusive', () => {
      const r = runCheck(consent03, site({ cmp: cmpWith({ phase: 'A', facts: [frameCandidate()] }) }));
      expect(r).toMatchObject({ status: 'completed' });
    });
  });
});
