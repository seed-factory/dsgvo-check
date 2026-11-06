/**
 * Pure schemas of test/data/cmp/adapters.yaml, categories.yaml and probe.yaml (checks parse `ctx.data.cmp` with them;
 * loaders: adapters-file.ts). The button lexicon, lexicon.yaml, has its own schema in lexicon.ts.
 */
import { z } from 'zod';
import { dataSection, RegexSource } from '../core/data/parse.ts';
import { SIGNAL_KINDS } from './detection.ts';
import { KNOWN_CMP_IDS, type KnownCmpId } from './types.ts';

const Selector = z.string().min(1);
const Names = z.array(z.string().min(1)).default([]);

const DetectSchema = z.strictObject({
  globals: Names,
  versionGlobals: Names,
  scripts: z.array(z.strictObject({ label: z.string().min(1), pattern: RegexSource })).default([]),
  dom: z.array(Selector).default([]),
  cookies: z.array(RegexSource).default([]),
  storage: z.array(RegexSource).default([]),
  requiredKinds: z.array(z.enum(SIGNAL_KINDS)).default([]),
});

const VersionRuleSchema = z
  .strictObject({
    global: z.string().min(1).optional(),
    dom: Selector.optional(),
    script: z.string().min(1).optional(),
    version: z.string().min(1),
  })
  .refine(
    (r) => [r.global, r.dom, r.script].filter((x) => x !== undefined).length === 1,
    'a version rule names exactly one of global, dom, script',
  );

const BannerSchema = z.strictObject({
  containers: z.array(Selector).min(1),
  overlays: z.array(Selector).default([]),
  vendorRoles: z
    .array(
      z.strictObject({
        selector: Selector,
        role: z.enum(['accept', 'reject', 'settings', 'save', 'close', 'later', 'hide']),
      }),
    )
    .default([]),
});

const AdapterSchema = z.strictObject({
  name: z.string().min(1),
  supportedMajors: z.array(z.number().int().nonnegative()).optional(),
  detect: DetectSchema,
  version: z
    .strictObject({
      fromScriptUrl: z.boolean().default(false),
      rules: z.array(VersionRuleSchema).default([]),
    })
    .default({ fromScriptUrl: false, rules: [] }),
  banner: BannerSchema,
  optionalGroups: Names,
  botUserAgent: RegexSource.optional(),
  essentialEmbeddings: z.array(RegexSource).default([]),
  answerCookie: z.string().min(1).optional(),
  groupsSource: z
    .strictObject({ selector: Selector, attribute: z.string().regex(/^[a-z][a-z0-9-]*$/) })
    .optional(),
});

export type AdapterData = z.infer<typeof AdapterSchema>;
export type VersionRule = z.infer<typeof VersionRuleSchema>;

export type ReaderInput =
  | 'botUserAgent'
  | 'optionalGroups'
  | 'essentialEmbeddings'
  | 'answerCookie'
  | 'groupsSource';

/** The page readers of these adapters cannot work without the input (an empty bot pattern would match every browser). */
const READER_INPUTS: Partial<Record<KnownCmpId, readonly ReaderInput[]>> = {
  borlabs: ['botUserAgent', 'optionalGroups'],
  ccm19: ['essentialEmbeddings'],
  'real-cookie-banner': ['botUserAgent'],
  shopware: ['answerCookie'],
  wix: ['optionalGroups'],
  cookieman: ['answerCookie', 'groupsSource'],
};

const missing = (value: unknown): boolean =>
  value === undefined || ((typeof value === 'string' || Array.isArray(value)) && value.length === 0);

/** One entry per known adapter id: a missing or an unknown id is a data error. */
export const adaptersSection = dataSection(
  'cmp',
  'adapters',
  z
    .strictObject(
      Object.fromEntries(KNOWN_CMP_IDS.map((id) => [id, AdapterSchema])) as Record<
        KnownCmpId,
        typeof AdapterSchema
      >,
    )
    .superRefine((all, ctx) => {
      for (const [id, inputs] of Object.entries(READER_INPUTS)) {
        const adapter = all[id as KnownCmpId];
        for (const key of inputs ?? []) {
          if (missing(adapter[key])) {
            ctx.addIssue({ code: 'custom', path: [id, key], message: `${id} needs "${key}"` });
          }
        }
      }
    }),
);

/** Names of consent categories that are strictly necessary, compiled to one case-insensitive test. */
export const essentialCategorySection = dataSection(
  'cmp',
  'essentialCategories',
  z
    .array(RegexSource)
    .min(1)
    .transform((fragments) => new RegExp(`^(?:${fragments.join('|')})$`, 'i')),
);

/** `2.x || 3.x` for tested majors 2 and 3; null when no range is declared. */
export function supportedVersionsOf(majors: readonly number[] | undefined): string | null {
  return majors && majors.length > 0 ? majors.map((m) => `${m}.x`).join(' || ') : null;
}

/** Attributes the in-page probe builds a button selector from, in order, and the id/class names of a banner container. */
export const probeSection = dataSection(
  'cmp',
  'probe',
  z.strictObject({
    selectorAttributes: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1),
    bannerContainerNames: z.array(RegexSource).min(1),
  }),
);

/** The sections of test/data/cmp besides the button lexicon, for the completeness test. */
export const cmpSections = [adaptersSection, essentialCategorySection, probeSection] as const;
