/** Ajv (JSON Schema 2020-12) validator over the published schema/report.schema.json (contract tests). */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const schemaPath = new URL('../../schema/report.schema.json', import.meta.url);

let validateFn: ReturnType<Ajv2020['compile']> | null = null;

export function validateReport(report: unknown): { valid: boolean; errors: string } {
  if (!validateFn) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validateFn = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  }
  const valid = validateFn(report) as boolean;
  return {
    valid,
    errors: valid ? '' : JSON.stringify(validateFn.errors?.slice(0, 10), null, 2),
  };
}

export function expectValidReport(report: unknown): void {
  const { valid, errors } = validateReport(JSON.parse(JSON.stringify(report)));
  if (!valid) throw new Error(`report does not match schema/report.schema.json:\n${errors}`);
}
