/**
 * What the snapshot keeps of a consent dialog (`cmp.dialogMentions`): the catalog services its text names. The text is
 * read once per scan, on the first screen of phase A where a CMP's own adapter recognises the dialog with confidence
 * `high`, as the whole text of the adapter's banner container, its collapsed and hidden details included (the
 * "Cookie-Details" of Borlabs Cookie list each service with provider and purpose). The collector looks up the names and
 * aliases of the service catalog in it in memory and keeps only the catalog's own term that matched. No text of the
 * page is kept: the dialog prints the visitor's consent ID or UID next to the services, in shapes that no redaction
 * tells apart from words.
 */
import { z } from 'zod';
import { KNOWN_CMP_IDS } from '../../cmp/types.ts';
import { sanitizeUrl } from '../url/url.ts';

/**
 * Characters of dialog text read. A dialog that lists every cookie of a large site fits; a page that renders its whole
 * content into the dialog's container is cut, and the record says so.
 */
export const CMP_DIALOG_TEXT_MAX_CHARS = 100_000;

/** More than the catalog holds: a record that names more services is not one the collector wrote. */
const MAX_MENTIONS = 500;

const ServiceMentionSchema = z.strictObject({
  serviceId: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** The catalog's own name or alias of the service that the dialog text holds as whole words; never page text. */
  term: z.string().min(1).max(100),
});

export const CmpDialogMentionsSchema = z.strictObject({
  cmpId: z.enum(KNOWN_CMP_IDS),
  /** Name of the CMP as test/data/cmp/adapters.yaml gives it, e.g. `Borlabs Cookie`. */
  cmpName: z.string().min(1).max(100),
  version: z.string().max(40).nullable(),
  phase: z.literal('A'),
  pageUrl: z.string().min(1),
  takenAt: z.string().min(1),
  /** One entry per catalog service the text names, by service id. */
  services: z.array(ServiceMentionSchema).max(MAX_MENTIONS),
  /** The dialog held more text than `CMP_DIALOG_TEXT_MAX_CHARS`; the rest was not searched. */
  truncated: z.boolean(),
});
export type CmpDialogMentions = z.infer<typeof CmpDialogMentionsSchema>;

/** The dialog mentions of a saved snapshot in the shape the collector writes; null when they do not fit the schema. */
export function parseCmpDialogMentions(raw: unknown): CmpDialogMentions | null {
  const parsed = CmpDialogMentionsSchema.safeParse(raw);
  return parsed.success ? { ...parsed.data, pageUrl: sanitizeUrl(parsed.data.pageUrl) } : null;
}
