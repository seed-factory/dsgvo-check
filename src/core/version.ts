import { readFileSync } from 'node:fs';

/** Package version, read once from package.json (same relative path from src/core and dist/core). */
export const TOOL_NAME = 'dsgvo-check';
export const TOOL_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
