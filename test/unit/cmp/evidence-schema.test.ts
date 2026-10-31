/**
 * L1: report evidence schema parts owned with the CMP zone: `cmp.buttons[].vendorRole` (G16) and the completeness
 * `manifest` of a `document` evidence (G28; filled by the legal zone). Zod strips unknown keys, so a field missing
 * in the schema silently disappears from the report.
 */
import { describe, expect, it } from 'vitest';
import { EvidenceSchema } from '../../../src/core/report-schema.ts';

describe('cmp evidence: vendorRole', () => {
  const base = {
    id: 'ev-1',
    type: 'cmp' as const,
    cmpId: 'cookiebot',
    recognitionConfidence: 'high' as const,
  };

  it('keeps a vendorRole string and a null vendorRole', () => {
    const parsed = EvidenceSchema.parse({
      ...base,
      buttons: [
        { name: 'Ausgewählte Cookies akzeptieren', kind: 'accept', vendorRole: 'save' },
        { name: 'Alle akzeptieren', kind: 'accept', vendorRole: null },
      ],
    }) as { buttons: Array<{ vendorRole?: string | null }> };
    expect(parsed.buttons[0]?.vendorRole).toBe('save');
    expect(parsed.buttons[1]?.vendorRole).toBeNull();
  });

  it('a button without vendorRole stays valid (optional)', () => {
    expect(
      EvidenceSchema.safeParse({ ...base, buttons: [{ name: 'Ablehnen', kind: 'reject' }] }).success,
    ).toBe(true);
  });
});

describe('document evidence: manifest', () => {
  const doc = {
    id: 'ev-2',
    type: 'document' as const,
    url: 'https://www.example.test/datenschutz',
    kind: 'privacy',
    complete: true,
  };

  it('keeps the safe counters of the completeness manifest', () => {
    const manifest = {
      partCount: 7,
      textLength: 18452,
      expandablesFound: 6,
      expandablesOpened: 5,
      framesIncluded: 1,
      framesFound: 2,
      framesRead: 1,
      linkedPages: 0,
      truncated: false,
    };
    const parsed = EvidenceSchema.parse({ ...doc, manifest }) as { manifest?: Record<string, unknown> };
    expect(parsed.manifest).toEqual(manifest);
  });

  it('a partial manifest is valid; a document without manifest stays valid', () => {
    expect(EvidenceSchema.safeParse({ ...doc, manifest: { textLength: 10 } }).success).toBe(true);
    expect(EvidenceSchema.safeParse(doc).success).toBe(true);
  });

  it('the manifest holds numbers and one flag only (no text, no values)', () => {
    expect(EvidenceSchema.safeParse({ ...doc, manifest: { textLength: 'long' } }).success).toBe(false);
  });
});
