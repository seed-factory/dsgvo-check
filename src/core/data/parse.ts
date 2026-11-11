/**
 * Pure side of the data loaders (no I/O, so checks may import it): the error type and the validation of one section
 * of a `test/data/<dir>` catalog. Reading the files is `load.ts`.
 */
import { z } from 'zod';

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export function formatIssues(err: z.ZodError, prefix = ''): string {
  return err.issues
    .map((i) => `${[prefix, ...i.path].filter((p) => p !== '').join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * One top-level key (`key:`) of the merged `test/data/<dir>/*.yaml` object with its schema. Several files of a directory
 * share the merged object, so every file owns its own key.
 */
export interface DataSection<T> {
  dir: string;
  key: string;
  /** Validates the merged directory object (the loader's, or `ctx.data.<dir>` of a check). */
  parse(merged: unknown): T;
}

export function dataSection<S extends z.ZodType>(
  dir: string,
  key: string,
  schema: S,
): DataSection<z.infer<S>> {
  return {
    dir,
    key,
    parse(merged) {
      const section =
        merged !== null && typeof merged === 'object' ? (merged as Record<string, unknown>)[key] : undefined;
      if (section === undefined) throw new DataError(`test/data/${dir}: section "${key}:" is missing`);
      const res = schema.safeParse(section);
      if (!res.success) throw new DataError(`test/data/${dir}: ${formatIssues(res.error, key)}`);
      return res.data;
    },
  };
}

/** A regular expression source that compiles; an invalid one is a data error, not a silent non-match. */
export const RegexSource = z.string().min(1).refine(compiles, 'invalid regular expression');

function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Lower-case names compared against lower-cased input. */
export const LowerName = z
  .string()
  .min(1)
  .refine((s) => s === s.toLowerCase(), 'must be lower case');
