/** Writes schema/report.schema.json from the zod schema in src/core/report/schema.ts, its only source; part of `corepack pnpm build`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportJsonSchema } from '../src/core/report/schema.ts';

const dir = fileURLToPath(new URL('../schema/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}report.schema.json`, `${JSON.stringify(reportJsonSchema(), null, 2)}\n`);
