import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReportSchema, reportJsonSchema } from '../../../src/core/report-schema.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report-fixtures.ts';
import { validateReport } from '../../utils/report-validator.ts';
import { REPO_ROOT } from '../../utils/snapshot-builder.ts';

describe('report schema (Ajv, JSON Schema 2020-12)', () => {
  it('schema/report.schema.json is up to date with the zod schema', () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/emit-schema.ts'), '--check'], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
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
