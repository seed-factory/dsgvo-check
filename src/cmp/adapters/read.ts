/**
 * What the adapters' readers return, as the Node side takes it. A reader runs in the page's own world, where the page
 * can replace built-ins (`Array.prototype.some`, `RegExp.prototype.exec`, `JSON.parse`) and so make it return anything:
 * each adapter parses its reader's answer with a schema of these parts, and a string the page chose is kept only as one
 * of a closed set.
 */
import { z } from 'zod';

/** Present or not: anything but a boolean is `false`. */
export const flag = z.boolean().catch(false);

/** A boolean the page may not tell: anything else is `null`. */
export const maybeFlag = z.boolean().nullable().catch(null);

/** A string the page chose, used only through a closed set (`pageValue`, `decisionMethod`). */
export const pageText = z.string().nullable().catch(null);

/** `true` / `false` / `null` per category; the keys are checked when the state is stored (`foldCategories`). */
export const categoryFlags = z.record(z.string(), maybeFlag).catch({});

/** The answer of a reader in the shape of `schema`; a fixed error, without page data, when it is no object at all. */
export function readerResult<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('cmp reader returned no result');
  return parsed.data;
}

/** What a setting of the vendor is stored as when the page chose a value the vendor does not have. */
export const OTHER_VALUE = 'other';

/**
 * A value the page chose for a setting of the vendor (Complianz `region`) as one of the vendor's own values
 * (adapters.yaml `pageValues`); any other value is `other`, none is null.
 */
export function pageValue(value: string | null, known: readonly string[] | undefined): string | null {
  if (value === null) return null;
  return known?.includes(value) ? value : OTHER_VALUE;
}
