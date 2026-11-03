/**
 * Writes schema/report.schema.json (JSON Schema 2020-12) from the zod report schema. Part of `corepack pnpm build`:
 * the published schema is a build output, the zod schema in src/core/report-schema.ts is its only source.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportJsonSchema } from '../src/core/report-schema.ts';

const dir = fileURLToPath(new URL('../schema/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}report.schema.json`, `${JSON.stringify(reportJsonSchema(), null, 2)}\n`);
