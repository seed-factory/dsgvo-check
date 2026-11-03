import { describe, expect, it } from 'vitest';
import { EvidenceSchema, ReportSchema, reportJsonSchema } from '../../../src/core/report-schema.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report-fixtures.ts';
import { validateReport } from '../../utils/report-validator.ts';

describe('report schema (Ajv, JSON Schema 2020-12)', () => {
  it('is JSON Schema 2020-12', () => {
    expect(reportJsonSchema().$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('accepts a full report with every evidence type', () => {
    const r = validateReport(sampleFullReport());
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
    expect(ReportSchema.safeParse(sampleFullReport()).success).toBe(true);
  });

  it('accepts the minimal failed report', () => {
    expect(validateReport(sampleFailedReport()).valid).toBe(true);
    expect(ReportSchema.safeParse(sampleFailedReport()).success).toBe(true);
  });

  it('is open: unknown fields and unknown evidence types are allowed', () => {
    const r = sampleFullReport() as unknown as Record<string, unknown>;
    r.futureField = { x: 1 };
    (r.evidence as unknown[]).push({ id: 'ev-x', type: 'brand-new-type', anything: true });
    expect(validateReport(r).valid).toBe(true);
  });

  it('rejects closed-enum violations and malformed known evidence', () => {
    const bad = sampleFullReport();
    (bad.findings[0] as { severity: string }).severity = 'high';
    expect(validateReport(bad).valid).toBe(false);

    const badStatus = sampleFullReport();
    (badStatus.checks[0] as { status: string }).status = 'pass';
    expect(validateReport(badStatus).valid).toBe(false);

    const badEvidence = sampleFullReport();
    // a known type must satisfy its own shape (request without url)
    badEvidence.evidence[0] = { id: 'ev-request', type: 'request' } as never;
    expect(validateReport(badEvidence).valid).toBe(false);
  });

  it('a failed report needs failure, exitCode 2 and at least one exit reason', () => {
    const noFailure = sampleFailedReport() as unknown as { scan: Record<string, unknown> };
    delete noFailure.scan.failure;
    expect(validateReport(noFailure).valid).toBe(false);
    const wrongCode = sampleFailedReport() as unknown as { summary: { exitCode: number } };
    wrongCode.summary.exitCode = 1;
    expect(validateReport(wrongCode).valid).toBe(false);
  });

  it('exit reasons are a closed vocabulary', () => {
    const r = sampleFullReport();
    r.summary.exitReasons = ['whatever'];
    expect(validateReport(r).valid).toBe(false);
  });
});

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
