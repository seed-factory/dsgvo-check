import { describe, expect, it } from 'vitest';
import { adapters } from '../../../src/cmp/index.ts';

describe('CMP adapter registry', () => {
  it('has the seven adapters of the catalog in its order, then the banners of shop and site systems', () => {
    expect(adapters.map((a) => a.id)).toEqual([
      'borlabs',
      'cookiebot',
      'complianz',
      'usercentrics',
      'ccm19',
      'real-cookie-banner',
      'cookiehub',
      'shopware',
      'wix',
      'cookieman',
    ]);
  });

  it('versioned adapters declare their tested range', () => {
    const ranges = Object.fromEntries(adapters.map((a) => [a.id, a.supportedVersions]));
    expect(ranges.borlabs).toBe('2.x || 3.x');
    expect(ranges.usercentrics).toBe('2.x || 3.x');
  });
});
