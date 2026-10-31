/** L1: adapter registry shape (catalog order, contract members) — no browser needed. */
import { describe, expect, it } from 'vitest';
import { adapters } from '../../../src/cmp/index.ts';

describe('CMP adapter registry', () => {
  it('has the seven adapters in catalog order', () => {
    expect(adapters.map((a) => a.id)).toEqual([
      'borlabs',
      'cookiebot',
      'complianz',
      'usercentrics',
      'ccm19',
      'real-cookie-banner',
      'cookiehub',
    ]);
  });

  it('every adapter implements the D12 contract', () => {
    for (const a of adapters) {
      for (const m of [
        'detect',
        'extract',
        'state',
        'geoSignals',
        'botSignals',
        'firstLayer',
        'reject',
        'accept',
        'verify',
      ] as const) {
        expect(typeof a[m], `${a.id}.${m}`).toBe('function');
      }
      expect(a.name.length).toBeGreaterThan(0);
    }
  });

  it('versioned adapters declare their tested range', () => {
    const ranges = Object.fromEntries(adapters.map((a) => [a.id, a.supportedVersions]));
    expect(ranges.borlabs).toBe('2.x || 3.x');
    expect(ranges.usercentrics).toBe('2.x || 3.x');
  });
});
