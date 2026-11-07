import { describe, expect, it } from 'vitest';
import { consent03 } from '../../../../../src/checks/browser/consent-03.ts';
import type { CmpFirstLayer } from '../../../../../src/cmp/types.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { renderMessage } from '../../../../../src/core/data/messages.ts';
import { makeCmpFacts, observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import {
  cmpFacts,
  cmpWith,
  cookie,
  defaultPages,
  firstLayer,
  phase,
  req,
  START,
  site,
  storage,
} from '../helpers.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const scenario = (file: string) => SCENARIOS['CONSENT-03']!.find((s) => s.file === file)!.build();
const gaHit = (id = 'a', p: Partial<Parameters<typeof req>[2]> = {}) =>
  req(id, p?.url ?? 'https://www.google-analytics.com/g/collect?v=2&cid=[redacted]', {
    resourceType: 'ping',
    identifierPresent: true,
    identifierNames: ['cid'],
    ...p,
  });

/** Phase A facts of a banner the generic heuristic found, with no CMP behind it. */
const heuristicCandidate = (signals: string[], p: Partial<CmpFirstLayer> = {}) =>
  makeCmpFacts({
    phase: 'A',
    pageUrl: START,
    detection: {
      cmpId: null,
      method: 'heuristic',
      version: null,
      versionSupported: null,
      recognitionConfidence: 'low',
      signals,
    },
    firstLayer: firstLayer(p),
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

  it('region not asserted → warning variant even with strong tracking', () => {
    const r = runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })] }));
    expect(observationsOf(r)[0]).toMatchObject({
      variant: 'no-banner-consent-services',
      params: { regionAsserted: false },
    });
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

  // banners found by the heuristic, the extended one included (other languages, static notice), are CONSENT-04 territory.
  it.each<[string, string[]]>([
    ['heuristic:dialog', []],
    ['heuristic:static', ['heuristic:keywords:2']],
    ['heuristic:fixed', ['heuristic:keywords:2']],
  ])('counterexample: a heuristic candidate with signal %s is a banner, not "no banner"', (signal, more) => {
    const cmp = cmpWith({ phase: 'A', facts: [heuristicCandidate([signal, ...more])] });
    const r = runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })], cmp }));
    expect(r).toMatchObject({ status: 'completed' });
    expect(variantsOf(r)).toEqual([]);
  });

  // a visible consent-looking iframe whose content could not be resolved limits the "no banner" conclusion.
  describe('unresolved consent iframe', () => {
    const frameCandidate = () =>
      heuristicCandidate(['heuristic:frame-candidate'], { consentFrameUnresolved: true });

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

describe('CONSENT-03 names what was stored apart from the services', () => {
  const body = (lang: 'de' | 'en', o: { variant: string; params: Record<string, unknown> }) =>
    renderMessage(loadTexts(lang), `CONSENT-03.${o.variant}`, o.params as never).body;

  it('services with requests and only some of them storing: the stored entries are listed on their own', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [
          phase('A', {
            requests: [
              gaHit('a'),
              req('b', 'https://www.googleadservices.com/pagead/conversion/123/?label=x'),
            ],
            cookies: [cookie('_gcl_au')],
            storage: [storage('_gcl_ls')],
          }),
        ],
      }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'no-banner-consent-services',
      params: {
        services: 'Google Ads, Google Analytics',
        storedCount: 2,
        stored: '_gcl_au (cookie), _gcl_ls (localStorage)',
      },
    });
    const de = body('de', o!);
    expect(de).toContain(
      'zu den Kategorien Analyse, Marketing oder eingebettete Inhalte gehören: Google Ads, Google Analytics.',
    );
    expect(de).toContain('Gespeichert wurden: _gcl_au (cookie), _gcl_ls (localStorage).');
    expect(de).not.toContain('mit Speicherung');
    expect(body('en', o!)).toContain('Stored: _gcl_au (cookie), _gcl_ls (localStorage).');
  });

  it('counterexample: requests without any storage say that no identifier or embed storage was observed', () => {
    const [o] = observationsOf(runCheck(consent03, site({ phases: [phase('A', { requests: [gaHit()] })] })));
    expect(o?.params).toMatchObject({ storedCount: 0, stored: null });
    expect(body('de', o!)).toContain(
      'Außer Einträgen auf der Allowlist wurde keine Speicherung von Analyse- oder Marketing-Kennungen oder durch eingebettete Dienste beobachtet.',
    );
    expect(body('en', o!)).toContain(
      'Apart from allowlisted entries, no storage of analytics or marketing identifiers or by embedded services was observed.',
    );
  });

  it('an entry of a listed service that the catalog lists as no identifier: the text does not say the service stored nothing', () => {
    const r = runCheck(
      consent03,
      site({
        phases: [
          phase('A', {
            requests: [
              req('a', 'https://static.hotjar.com/c/hotjar-123.js?sv=6'),
              req('b', 'https://in.hotjar.com/api/v2/client/sites/123/visit-data?sv=6', {
                resourceType: 'xhr',
              }),
            ],
            cookies: [cookie('_hjFirstSeen')],
          }),
        ],
      }),
    );
    const [o] = observationsOf(r);
    expect(o).toMatchObject({
      variant: 'no-banner-consent-services',
      params: { services: 'Hotjar', storedCount: 0 },
    });
    expect(`${body('de', o!)}\n${body('en', o!)}`).not.toMatch(
      /Speicherung durch diese Dienste|storage by these services/,
    );
  });
});
