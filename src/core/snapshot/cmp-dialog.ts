/**
 * The text of a consent dialog (`cmp.dialogText`): read once per scan, on the first screen of phase A where a CMP's own
 * adapter recognises it with confidence `high`, as the whole text of the adapter's banner container, its collapsed and
 * hidden details included (the "Cookie-Details" of Borlabs Cookie list each service with provider and purpose). The
 * collector redacts it before it is written; a saved snapshot is validated and redacted again when it is read.
 */
import { z } from 'zod';
import { KNOWN_CMP_IDS } from '../../cmp/types.ts';
import { redactText } from '../redaction/redact.ts';
import { redactValueTokens, stripInvisible } from '../redaction/values.ts';
import { sanitizeUrl } from '../url/url.ts';

/**
 * Characters of dialog text kept. A dialog that lists every cookie of a large site fits; a page that renders its whole
 * content into the dialog's container is cut, and the record says so.
 */
export const CMP_DIALOG_TEXT_MAX_CHARS = 100_000;

/** The id under which evidence quotes the dialog text. */
export const CMP_DIALOG_ID = 'cmp-dialog';

export const CmpDialogTextSchema = z.strictObject({
  id: z.literal(CMP_DIALOG_ID),
  cmpId: z.enum(KNOWN_CMP_IDS),
  /** Name of the CMP as test/data/cmp/adapters.yaml gives it, e.g. `Borlabs Cookie`. */
  cmpName: z.string().min(1).max(100),
  version: z.string().max(40).nullable(),
  phase: z.literal('A'),
  pageUrl: z.string().min(1),
  takenAt: z.string().min(1),
  /** Whitespace-collapsed and redacted: no address, URL value, consent ID, UID or other value-like token. */
  text: z.string().max(CMP_DIALOG_TEXT_MAX_CHARS),
  /** The dialog held more text than `CMP_DIALOG_TEXT_MAX_CHARS`; the rest was not read. */
  truncated: z.boolean(),
});
export type CmpDialogText = z.infer<typeof CmpDialogTextSchema>;

/** Drops the last token of a text that was cut: it may be the first part of a value, too short to look like one. */
const withoutCutToken = (s: string): string => s.replace(/\S*$/, '').trimEnd();

/**
 * The text as stored: invisible characters out first, so that an address split by a soft hyphen or a zero-width space
 * is recognised whole; then free-text redaction (`redact`: addresses and URL values, with the caller's query
 * allowlist), value-like tokens, and the cap. `cut` says the page side already cut it at the cap.
 */
export function storedDialogText(
  raw: string,
  cut: boolean,
  redact: (s: string) => string = redactText,
): { text: string; truncated: boolean } {
  const visible = stripInvisible(raw);
  const body = cut ? withoutCutToken(visible) : visible;
  const text = redactValueTokens(redact(body.replace(/\s+/g, ' ').trim()));
  if (text.length <= CMP_DIALOG_TEXT_MAX_CHARS) return { text, truncated: cut };
  return { text: withoutCutToken(text.slice(0, CMP_DIALOG_TEXT_MAX_CHARS)), truncated: true };
}

/** The dialog text of a saved snapshot, redacted as the collector does; null when it does not fit the schema. */
export function parseCmpDialogText(raw: unknown): CmpDialogText | null {
  const parsed = CmpDialogTextSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const stored = storedDialogText(d.text, false);
  return {
    ...d,
    pageUrl: sanitizeUrl(d.pageUrl),
    text: stored.text,
    truncated: d.truncated || stored.truncated,
  };
}
