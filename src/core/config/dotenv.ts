/** Reads a `.env` file without touching `process.env`: Chromium and the PDF printer inherit that environment, and foreign variables of a project's `.env` must not reach them. */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export interface EnvFile {
  path: string;
  values: Readonly<Record<string, string>>;
}

export class EnvFileError extends Error {
  readonly path: string;
  /** The system error code (`EISDIR`, `EACCES`, ...). */
  readonly code: string;
  constructor(path: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    super(`cannot read ${path}: ${code}`, { cause });
    this.name = 'EnvFileError';
    this.path = path;
    this.code = code;
  }
}

/** null when the file does not exist. */
export function readEnvFile(file: string): EnvFile | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new EnvFileError(file, err);
  }
  return { path: file, values: parseEnv(text) as Record<string, string> };
}
