/**
 * What `cmpPageProbe` returned, as the Node side takes it. The probe runs in the page's own world, where the page can
 * replace built-ins (`Array.prototype.find`, `String.prototype.includes`, `Math.round`, `CSS.escape`) and so return
 * anything. Every field is kept only in the shape and the vocabulary the probe produces: selectors in the forms of
 * selector.ts, tags and roles by their rules, vendor roles out of the probe's arguments, fixed words out of their lists,
 * finite numbers. A field that does not conform is dropped or neutral; extra fields are dropped.
 */
import { z } from 'zod';
import { isAriaRole, isTagName, redactCmpLabel } from '../../core/redaction/page-names.ts';
import type { CandidateControlKind } from '../types.ts';
import { BLOCKING_METHODS, type ProbeArgs, type ProbeResult, type RawButton } from './probe-types.ts';
import { isProbeSelector } from './selector.ts';

/** The tag of an element whose tag name is no name (the probe writes the same). */
export const UNKNOWN_TAG = 'unknown';

/** The probe cuts accessible names here. */
const NAME_MAX_LENGTH = 200;
const COVERED_LINK_LABEL_MAX_LENGTH = 80;
const MAX_COVERED_LINKS = 200;

/**
 * A control label of the page. The probe cuts it at `NAME_MAX_LENGTH`, so its last word may be the start of an id or an
 * address (`… 4f3a9c1`, `… alice@exa`) that no mask recognizes: a label at the limit loses that word.
 */
function controlLabel(raw: string): string {
  const text = raw.slice(0, NAME_MAX_LENGTH);
  return redactCmpLabel(raw.length >= NAME_MAX_LENGTH ? text.replace(/\S*$/, '').trimEnd() : text);
}
const MAX_HEURISTIC_SIGNALS = 8;
const MAX_SWITCHES = 200;

const HEURISTIC_SIGNAL =
  /^heuristic:(?:dialog|fixed|static|named|frame-body|frame|keywords:\d{1,4}|controls:\d{1,5})$/;
const CANDIDATE_REASONS = ['keywords', 'no-control', 'page-section'] as const;
const CANDIDATE_CONTROLS = [
  'accept',
  'reject',
  'settings',
  'save',
  'other',
] as const satisfies readonly CandidateControlKind[];

/** The implicit role of a control by its tag, for a role that is no role (the probe reads an unknown token so too). */
function implicitRole(tag: string): string {
  if (tag === 'button' || tag === 'summary' || tag === 'input') return 'button';
  if (tag === 'a' || tag === 'area') return 'link';
  return 'generic';
}

/** The valid items of a list, at most `max`; anything but a list is empty. */
function listOf<T extends z.ZodType>(item: T, max: number) {
  return z.unknown().transform((value) => {
    const out: Array<z.output<T>> = [];
    if (!Array.isArray(value)) return out;
    for (const v of value) {
      if (out.length >= max) break;
      const parsed = item.safeParse(v);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  });
}

const num = z.number();
const flag = z.boolean().catch(false);
const count = z.number().int().min(0).catch(0);
const Box = z.object({ x: num, y: num, width: num, height: num });
const optionalBox = Box.nullable().catch(null);

const Blocking = z
  .object({
    overlay: flag,
    scrollLock: flag,
    inert: flag,
    coveredRatio: z.number().min(0).max(1).nullable().catch(null),
    method: listOf(z.enum(BLOCKING_METHODS), BLOCKING_METHODS.length),
    ariaModal: flag,
  })
  .catch({
    overlay: false,
    scrollLock: false,
    inert: false,
    coveredRatio: null,
    method: [],
    ariaModal: false,
  });

const CandidateFact = z.object({
  reason: z.enum(CANDIDATE_REASONS),
  keywordHits: z.number().int().min(0),
  controls: listOf(z.enum(CANDIDATE_CONTROLS), CANDIDATE_CONTROLS.length).transform((c) => [...new Set(c)]),
  cookieWording: z.boolean(),
  fixed: z.boolean(),
  dialog: z.boolean(),
  named: z.boolean(),
});

function probeResultSchema(args: ProbeArgs) {
  const vendorRoles = new Set(args.vendorRoles.map((v) => v.role));
  const containers = new Set(args.containers);
  const keywords = new Set(args.keywords);

  const Button = z
    .object({
      role: z.string().catch(''),
      name: z.string().catch(''),
      tag: z.string().catch(''),
      vendorRole: z.string().nullable().catch(null),
      box: optionalBox,
      rendered: flag,
      visibleInViewport: flag,
      inViewport: flag,
      enabled: flag,
      hitTestOk: flag,
      actionable: flag,
      contrast: z.number().min(1).max(21).nullable().catch(null),
      fontSizePx: z.number().min(0).nullable().catch(null),
      selector: z.string().nullable().catch(null),
      inShadowDom: flag,
      href: z.string().nullable().catch(null),
    })
    .transform((b): RawButton => {
      const tag = isTagName(b.tag) ? b.tag : UNKNOWN_TAG;
      return {
        ...b,
        role: isAriaRole(b.role) ? b.role : implicitRole(tag),
        name: controlLabel(b.name),
        tag,
        vendorRole: b.vendorRole !== null && vendorRoles.has(b.vendorRole) ? b.vendorRole : null,
        selector:
          b.selector !== null && isProbeSelector(b.selector, args.selectorAttributes) ? b.selector : null,
      };
    });

  return z.object({
    found: flag,
    containerCount: count,
    visible: flag,
    containerBox: optionalBox,
    containerFixed: flag,
    containerSelector: z
      .string()
      .nullable()
      .catch(null)
      .transform((s) => (s !== null && containers.has(s) ? s : null)),
    textLength: count,
    purAbo: flag,
    keywordHits: listOf(z.string(), args.keywords.length).transform((hits) =>
      [...new Set(hits)].filter((k) => keywords.has(k)),
    ),
    buttons: listOf(Button, args.maxButtons),
    buttonsTruncated: flag,
    animating: flag,
    blocking: Blocking,
    viewport: z
      .object({ width: z.number().min(0), height: z.number().min(0) })
      .catch({ width: 0, height: 0 }),
    coveredLinks: listOf(
      z.object({
        label: z.string().max(COVERED_LINK_LABEL_MAX_LENGTH).transform(redactCmpLabel),
        box: Box,
        coveredBy: z.enum(['banner', 'overlay']),
      }),
      MAX_COVERED_LINKS,
    ),
    heuristic: z
      .object({
        score: num,
        signals: listOf(z.string().regex(HEURISTIC_SIGNAL), MAX_HEURISTIC_SIGNALS),
      })
      .nullable()
      .catch(null),
    rejectedCandidate: z.object({ fact: CandidateFact, rank: num, box: Box }).nullable().catch(null),
    switches: listOf(
      z.object({ checked: z.boolean().nullable(), disabled: z.boolean() }),
      MAX_SWITCHES,
    ).optional(),
    fullText: z.object({ text: z.string(), truncated: z.boolean() }).optional().catch(undefined),
  });
}

/**
 * The probe's result in the shape and vocabulary of `ProbeResult`; throws a fixed error (no page data) when it is not
 * even an object. `switches` and `fullText` are kept only when `args` asked for them.
 */
export function parseProbeResult(raw: unknown, args: ProbeArgs): ProbeResult {
  const parsed = probeResultSchema(args).safeParse(raw);
  if (!parsed.success) throw new Error('cmp probe returned no result');
  const { switches, fullText, ...rest } = parsed.data;
  const maxChars = args.fullTextMaxChars;
  return {
    ...rest,
    ...(args.switches ? { switches: switches ?? [] } : {}),
    ...(maxChars !== undefined && fullText
      ? { fullText: { text: fullText.text.slice(0, maxChars), truncated: fullText.truncated } }
      : {}),
  };
}
