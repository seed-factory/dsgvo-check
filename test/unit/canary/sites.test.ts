import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  type CanarySite,
  filterSites,
  parseSites,
  regionOfCountry,
  SitesValidationError,
} from '../../../scripts/canary-sites.ts';

type RawSite = Record<string, unknown>;

function site(i: number, over: RawSite = {}): RawSite {
  return {
    id: `de-site-${i}`,
    url: `https://www.site-${i}.de/`,
    region: 'de',
    country: 'DE',
    sector: 'media',
    sizeClass: 'medium',
    expectedCmp: 'unknown',
    selectionReason: 'Branchenmix: Medien',
    publicReference: null,
    ...over,
  };
}

function corpus(sites: RawSite[]): string {
  return stringify({ version: 1, sites });
}

function issuesOf(text: string, expectedCount: number | null = null): string[] {
  try {
    parseSites(text, { expectedCount });
  } catch (err) {
    if (err instanceof SitesValidationError) return err.issues.map((i) => `${i.field}: ${i.message}`);
    throw err;
  }
  return [];
}

describe('parseSites', () => {
  it('parses a valid corpus and normalizes the URL', () => {
    const sites = parseSites(
      corpus([
        site(1, { url: 'https://WWW.Site-1.de' }),
        site(2, { expectedCmp: 'cookiebot', cmpSignal: 'html: consent.cookiebot.com/uc.js' }),
      ]),
      { expectedCount: 2 },
    );
    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatchObject<Partial<CanarySite>>({
      id: 'de-site-1',
      url: 'https://www.site-1.de/',
      host: 'www.site-1.de',
      etld1: 'site-1.de',
      cmpSignal: null,
      publicReference: null,
    });
    expect(sites[1]?.expectedCmp).toBe('cookiebot');
  });

  it('requires exactly 100 sites by default', () => {
    const text = corpus(Array.from({ length: 99 }, (_, i) => site(i)));
    expect(issuesOf(text, 100)).toEqual(['sites: expected exactly 100 sites, got 99']);
    expect(() => parseSites(text)).toThrow(SitesValidationError);
    const hundred = corpus(Array.from({ length: 100 }, (_, i) => site(i)));
    expect(parseSites(hundred)).toHaveLength(100);
  });

  it('reports duplicate ids, urls, hosts and registrable domains', () => {
    const issues = issuesOf(
      corpus([
        site(1),
        site(2, { id: 'de-site-1' }),
        site(3, { url: 'https://www.site-1.de' }),
        site(4, { url: 'http://www.site-1.de/de/' }),
        site(5, { url: 'https://shop.site-1.de/' }),
      ]),
    );
    expect(issues).toEqual([
      'sites[1].id: duplicate id "de-site-1"',
      'sites[2].url: duplicate url "https://www.site-1.de/"',
      'sites[3].url: duplicate host "www.site-1.de"',
      'sites[4].url: duplicate registrable domain "site-1.de" (also de-site-1)',
    ]);
  });

  it('rejects values outside the allowed sets', () => {
    const issues = issuesOf(
      corpus([site(1, { region: 'eu-west', sizeClass: 'huge', expectedCmp: 'onetrust', sector: 'casino' })]),
    );
    expect(issues).toHaveLength(4);
    expect(issues.join('\n')).toMatch(/sites\[0\]\.region/);
    expect(issues.join('\n')).toMatch(/sites\[0\]\.sizeClass/);
    expect(issues.join('\n')).toMatch(/sites\[0\]\.expectedCmp/);
    expect(issues.join('\n')).toMatch(/sites\[0\]\.sector/);
  });

  it('rejects unknown fields and missing fields', () => {
    const { sector: _sector, ...noSector } = site(1);
    const issues = issuesOf(corpus([{ ...noSector, rating: 'bad' }]));
    expect(issues.join('\n')).toMatch(/sites\[0\]\.sector/);
    expect(issues.join('\n')).toMatch(/rating/);
  });

  it('checks that region matches the ISO country', () => {
    expect(regionOfCountry('DE')).toBe('de');
    expect(regionOfCountry('AT')).toBe('eu');
    expect(regionOfCountry('NO')).toBe('eu');
    expect(regionOfCountry('GR')).toBe('eu');
    expect(regionOfCountry('CH')).toBe('non-eu');
    expect(regionOfCountry('GB')).toBe('non-eu');
    const issues = issuesOf(
      corpus([
        site(1, { id: 'ch-a', country: 'CH', region: 'eu' }),
        site(2, { id: 'at-b', country: 'AT', region: 'non-eu' }),
        site(3, { id: 'uk-c', country: 'UK', region: 'non-eu' }),
        site(4, { id: 'gr-d', country: 'GR', region: 'eu' }),
      ]),
    );
    expect(issues).toEqual([
      'sites[0].region: country CH belongs to region "non-eu", not "eu"',
      'sites[1].region: country AT belongs to region "eu", not "non-eu"',
      'sites[2].country: not an ISO 3166-1 alpha-2 code: "UK" (use GB)',
    ]);
  });

  it('requires the id to start with the lower-case country code', () => {
    expect(issuesOf(corpus([site(1, { id: 'fr-site-1' })]))).toEqual(['sites[0].id: must start with "de-"']);
    expect(issuesOf(corpus([site(1, { id: 'de_Site' })]))[0]).toMatch(/sites\[0\]\.id/);
  });

  it('accepts only plain http(s) start URLs', () => {
    const issues = issuesOf(
      corpus([
        site(1, { url: 'ftp://www.site-1.de/' }),
        site(2, { url: 'https://user:pw@www.site-2.de/' }),
        site(3, { url: 'https://www.site-3.de/?utm_source=x' }),
        site(4, { url: 'https://www.site-4.de/#top' }),
        site(5, { url: 'not a url' }),
      ]),
    );
    expect(issues).toHaveLength(5);
    for (const [i, line] of issues.entries()) expect(line).toMatch(new RegExp(`^sites\\[${i}\\]\\.url: `));
  });

  it('ties publicReference to a neutral "öffentlich dokumentierter Fall" reason', () => {
    const ref = 'https://www.cnil.fr/fr/exemple-decision';
    expect(
      issuesOf(
        corpus([
          site(1, {
            selectionReason: `öffentlich dokumentierter Fall: CNIL-Entscheidung 2021 – ${ref}`,
            publicReference: ref,
          }),
        ]),
      ),
    ).toEqual([]);
    const issues = issuesOf(
      corpus([
        site(1, { selectionReason: 'Branchenmix: Medien', publicReference: ref }),
        site(2, { selectionReason: 'öffentlich dokumentierter Fall: CNIL 2021', publicReference: null }),
        site(3, {
          selectionReason: `öffentlich dokumentierter Fall: ${ref}`,
          publicReference: 'http://example.org/x',
        }),
        site(4, { selectionReason: 'öffentlich dokumentierter Fall: CNIL 2021', publicReference: ref }),
      ]),
    );
    expect(issues).toEqual([
      'sites[0].selectionReason: must start with "öffentlich dokumentierter Fall:" when publicReference is set',
      'sites[1].publicReference: required when selectionReason is "öffentlich dokumentierter Fall"',
      'sites[2].publicReference: must be an https URL',
      'sites[3].selectionReason: must contain the publicReference URL',
    ]);
  });

  it('requires cmpSignal for every expectedCmp other than unknown', () => {
    const issues = issuesOf(
      corpus([
        site(1, { expectedCmp: 'borlabs' }),
        site(2, { expectedCmp: 'none', cmpSignal: '' }),
        site(3, { expectedCmp: 'unknown' }),
        site(4, { expectedCmp: 'cookiehub', cmpSignal: 'Herstellerseite' }),
      ]),
    );
    expect(issues).toEqual([
      'sites[0].cmpSignal: required when expectedCmp is "borlabs"',
      'sites[1].cmpSignal: required when expectedCmp is "none"',
    ]);
  });

  it('keeps selection reasons free of legal verdicts', () => {
    const issues = issuesOf(
      corpus([
        site(1, { selectionReason: 'Seite verstößt gegen die DSGVO' }),
        site(2, { selectionReason: 'non-compliant banner' }),
        site(3, { expectedCmp: 'none', cmpSignal: 'html: rechtswidrig' }),
        site(4, {
          selectionReason:
            'öffentlich dokumentierter Fall: Bescheid 2022 – https://example.org/violation-cookies',
          publicReference: 'https://example.org/violation-cookies',
        }),
      ]),
    );
    expect(issues).toEqual([
      'sites[0].selectionReason: contains a legal verdict ("verstößt"); state facts only',
      'sites[1].selectionReason: contains a legal verdict ("non-compliant"); state facts only',
      'sites[2].cmpSignal: contains a legal verdict ("rechtswidrig"); state facts only',
    ]);
  });

  it('rejects malformed documents', () => {
    expect(issuesOf('sites: [')[0]).toMatch(/^\(root\): invalid YAML/);
    expect(issuesOf('version: 2\nsites: []\n')[0]).toMatch(/version/);
    expect(issuesOf('just text')[0]).toMatch(/\(root\)/);
  });
});

describe('filterSites', () => {
  const sites = parseSites(
    corpus([
      site(1),
      site(2, { id: 'at-two', url: 'https://www.two.at/', country: 'AT', region: 'eu' }),
      site(3, { id: 'us-three', url: 'https://www.three.com/', country: 'US', region: 'non-eu' }),
      site(4),
    ]),
    { expectedCount: null },
  );

  it('keeps file order and applies region, id and limit filters', () => {
    expect(filterSites(sites, {}).map((s) => s.id)).toEqual(['de-site-1', 'at-two', 'us-three', 'de-site-4']);
    expect(filterSites(sites, { regions: ['de', 'non-eu'] }).map((s) => s.id)).toEqual([
      'de-site-1',
      'us-three',
      'de-site-4',
    ]);
    expect(filterSites(sites, { ids: ['de-site-4', 'at-two'] }).map((s) => s.id)).toEqual([
      'at-two',
      'de-site-4',
    ]);
    expect(filterSites(sites, { regions: ['de'], limit: 1 }).map((s) => s.id)).toEqual(['de-site-1']);
  });

  it('fails on unknown ids instead of silently scanning nothing', () => {
    expect(() => filterSites(sites, { ids: ['xx-missing'] })).toThrow(/unknown site id: xx-missing/);
  });
});
