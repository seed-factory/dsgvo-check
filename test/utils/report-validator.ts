/** Ajv (JSON Schema 2020-12) validator over the published report schema, as the build emits it (contract tests). */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { reportJsonSchema } from '../../src/core/report-schema.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

let validateFn: ReturnType<Ajv2020['compile']> | null = null;

export function validateReport(report: unknown): { valid: boolean; errors: string } {
  if (!validateFn) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validateFn = ajv.compile(JSON.parse(JSON.stringify(reportJsonSchema())));
  }
  const valid = validateFn(report) as boolean;
  return {
    valid,
    errors: valid ? '' : JSON.stringify(validateFn.errors?.slice(0, 10), null, 2),
  };
}

export function expectValidReport(report: unknown): void {
  const { valid, errors } = validateReport(JSON.parse(JSON.stringify(report)));
  if (!valid) throw new Error(`report does not match the report JSON schema:\n${errors}`);
}
