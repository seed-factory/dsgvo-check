/** The real corpus canary/sites.yaml: valid, exactly 100 sites, and the composition the BRIEF asks for. */
import { describe, expect, it } from 'vitest';
import { type CanarySite, KNOWN_CMPS, loadSites, type Region } from '../../../scripts/canary-sites.ts';

const sites: CanarySite[] = loadSites();
const count = (pred: (s: CanarySite) => boolean) => sites.filter(pred).length;
const byRegion = (r: Region) => sites.filter((s) => s.region === r);

describe('canary/sites.yaml', () => {
  it('has exactly 100 valid sites', () => {
    expect(sites).toHaveLength(100);
  });

  it('is split roughly 45 / 25 / 30 between Germany, other EU/EEA and non-EU', () => {
    expect(byRegion('de').length).toBeGreaterThanOrEqual(40);
    expect(byRegion('de').length).toBeLessThanOrEqual(50);
    expect(byRegion('eu').length).toBeGreaterThanOrEqual(20);
    expect(byRegion('eu').length).toBeLessThanOrEqual(30);
    expect(byRegion('non-eu').length).toBeGreaterThanOrEqual(25);
    expect(byRegion('non-eu').length).toBeLessThanOrEqual(35);
  });

  it('covers many EU/EEA countries and the required non-EU countries (CH as non-EU)', () => {
    expect(new Set(byRegion('eu').map((s) => s.country)).size).toBeGreaterThanOrEqual(8);
    const nonEu = new Set(byRegion('non-eu').map((s) => s.country));
    for (const c of ['US', 'GB', 'CH', 'CA', 'JP', 'IN', 'BR', 'AU']) expect(nonEu).toContain(c);
  });

  it.each(KNOWN_CMPS.map((c) => [c]))('has at least 3 sites with confirmed CMP %s', (cmp) => {
    expect(count((s) => s.expectedCmp === cmp)).toBeGreaterThanOrEqual(3);
  });

  it('mixes sectors and size classes, including government references and small businesses', () => {
    expect(new Set(sites.map((s) => s.sector)).size).toBeGreaterThanOrEqual(10);
    expect(count((s) => s.sector === 'government')).toBeGreaterThanOrEqual(5);
    expect(count((s) => s.sizeClass === 'small-business')).toBeGreaterThanOrEqual(5);
    expect(count((s) => s.expectedCmp === 'none')).toBeGreaterThanOrEqual(3);
  });

  it('documents every public case with a single https reference inside the reason', () => {
    const documented = sites.filter((s) => s.publicReference !== null);
    expect(documented.length).toBeGreaterThan(0);
    for (const s of documented) {
      expect(s.publicReference).toMatch(/^https:\/\//);
      expect(s.selectionReason).toContain(s.publicReference as string);
    }
  });
});
