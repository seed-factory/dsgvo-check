/** Loaders for test/data/ (ruleset, texts, routing, generic data dirs): each directory is a catalog of YAML files merged across modules. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Lang, SeveritySchema } from '../report/schema.ts';

/** Package data directory test/data (same relative path from src/core and dist/core). */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../test/data/', import.meta.url));

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

function yamlFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new DataError(`${dir}: ${(err as Error).message}`);
  }
  return entries
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => path.join(dir, f));
}

function readYaml(file: string): unknown {
  const raw = readFileSync(file, 'utf8');
  try {
    return parseYaml(raw) ?? {};
  } catch (err) {
    throw new DataError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
}

function formatZodError(file: string, err: z.ZodError): string {
  return `${file}: ${err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
}

function parseFile<T extends z.ZodType>(file: string, schema: T): z.infer<T> {
  const res = schema.safeParse(readYaml(file));
  if (!res.success) throw new DataError(formatZodError(file, res.error));
  return res.data;
}

/** Merge record maps from several files; the same key in two files is an error. */
function mergeUnique<V>(
  target: Record<string, V>,
  source: Record<string, V> | undefined,
  file: string,
  what: string,
) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (Object.hasOwn(target, k)) throw new DataError(`${file}: duplicate ${what} "${k}"`);
    target[k] = v;
  }
}

const RulesetVariantSchema = z.object({
  severity: SeveritySchema,
  /** Optional per-variant gating override (default: check gating). */
  gating: z.boolean().optional(),
  /** Level and gating cannot be changed by overrides (an override rule for it is invalid input). */
  locked: z.boolean().optional(),
  /** CRM catalog code (JSON report only) or explicit null: every variant states its mapping. */
  crm: z
    .string()
    .regex(/^T\d_[A-Z_]+$/)
    .nullable(),
});

const RulesetCheckSchema = z.object({
  gating: z.boolean().default(true),
  variants: z.record(z.string(), RulesetVariantSchema),
});

const RulesetFileSchema = z.object({
  profile: z
    .object({
      id: z.literal('de-2026'),
      version: z.string(),
      rechtsstand: z.string(),
      draft: z.boolean().default(true),
    })
    .optional(),
  checks: z.record(z.string(), RulesetCheckSchema).nullish(),
});

export type RulesetCheck = z.infer<typeof RulesetCheckSchema>;
export interface Ruleset {
  profile: { id: 'de-2026'; version: string; rechtsstand: string; draft: boolean };
  checks: Record<string, RulesetCheck>;
}

export function loadRuleset(dataDir = DEFAULT_DATA_DIR): Ruleset {
  const dir = path.join(dataDir, 'ruleset', 'de-2026');
  const files = yamlFiles(dir);
  if (files.length === 0) throw new DataError(`ruleset de-2026: no files in ${dir}`);
  let meta: Ruleset['profile'] | undefined;
  const checks: Record<string, RulesetCheck> = {};
  for (const file of files) {
    const parsed = parseFile(file, RulesetFileSchema);
    if (parsed.profile) {
      if (meta) throw new DataError(`${file}: duplicate profile block`);
      meta = parsed.profile;
    }
    mergeUnique(checks, parsed.checks ?? undefined, file, 'ruleset check');
  }
  if (!meta) throw new DataError(`ruleset de-2026: missing profile block`);
  return { profile: meta, checks };
}

const MessageSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  draft: z.boolean().optional(),
});

const LegalNoteSchema = z.object({
  text: z.string().min(1),
  status: z.enum([
    'authority-consensus',
    'court-first-instance',
    'court-appellate',
    'contested',
    'technical',
  ]),
  reviewedAt: z.string().nullable().default(null),
  reviewBy: z.string().nullable().default(null),
  draft: z.boolean().optional(),
});

const TextsFileSchema = z.object({
  draft: z.boolean().default(true),
  messages: z.record(z.string(), MessageSchema).nullish(),
  legalNotes: z.record(z.string(), LegalNoteSchema).nullish(),
  /** UI strings (console/HTML labels, disclaimer, diagnostics). Keys are dotted, e.g. `console.heading`. */
  ui: z.record(z.string(), z.string()).nullish(),
});

export interface TextEntry {
  title: string;
  body: string;
  draft: boolean;
}
export interface LegalNote {
  text: string;
  status: z.infer<typeof LegalNoteSchema>['status'];
  reviewedAt: string | null;
  reviewBy: string | null;
  draft: boolean;
}
export interface Texts {
  lang: Lang;
  messages: Record<string, TextEntry>;
  legalNotes: Record<string, LegalNote>;
  ui: Record<string, { text: string; draft: boolean }>;
}

export function loadTexts(lang: Lang, dataDir = DEFAULT_DATA_DIR): Texts {
  const dir = path.join(dataDir, 'texts', lang);
  const files = yamlFiles(dir);
  if (files.length === 0) throw new DataError(`texts ${lang}: no files in ${dir}`);
  const out: Texts = { lang, messages: {}, legalNotes: {}, ui: {} };
  for (const file of files) {
    const parsed = parseFile(file, TextsFileSchema);
    const messages: Record<string, TextEntry> = {};
    for (const [k, m] of Object.entries(parsed.messages ?? {})) {
      messages[k] = { title: m.title, body: m.body, draft: m.draft ?? parsed.draft };
    }
    const notes: Record<string, LegalNote> = {};
    for (const [k, n] of Object.entries(parsed.legalNotes ?? {})) {
      notes[k] = { ...n, draft: n.draft ?? parsed.draft };
    }
    const ui: Record<string, { text: string; draft: boolean }> = {};
    for (const [k, t] of Object.entries(parsed.ui ?? {})) ui[k] = { text: t, draft: parsed.draft };
    mergeUnique(out.messages, messages, file, 'message');
    mergeUnique(out.legalNotes, notes, file, 'legal note');
    mergeUnique(out.ui, ui, file, 'ui string');
  }
  return out;
}

const RoutingFileSchema = z.object({
  version: z.literal(1),
  /** Service category → owning check id. */
  owners: z.record(z.string(), z.string().regex(/^[A-Z]+-\d{2}$/)),
});

export type Routing = Record<string, string>;

export function loadRouting(dataDir = DEFAULT_DATA_DIR): Routing {
  return parseFile(path.join(dataDir, 'routing.yaml'), RoutingFileSchema).owners;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  file: string,
  at: string,
) {
  for (const [k, v] of Object.entries(source)) {
    const key = at ? `${at}.${k}` : k;
    const existing = target[k];
    if (existing === undefined) target[k] = v;
    else if (Array.isArray(existing) && Array.isArray(v)) target[k] = [...existing, ...v];
    else if (isPlainObject(existing) && isPlainObject(v)) deepMerge(existing, v, file, key);
    else throw new DataError(`${file}: conflicting value for "${key}"`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Loads test/data/<name>/*.yaml merged (objects deeply, arrays concatenated, scalar conflicts are errors) for `Check.data`; callers validate with their own zod schema. */
export function loadDataDir(name: string, dataDir = DEFAULT_DATA_DIR): Record<string, unknown> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new DataError(`invalid data dir name "${name}"`);
  const out: Record<string, unknown> = {};
  for (const file of yamlFiles(path.join(dataDir, name))) {
    const content = readYaml(file);
    if (!isPlainObject(content)) throw new DataError(`${file}: top level must be a mapping`);
    deepMerge(out, content, file, '');
  }
  return out;
}

export interface CoreData {
  ruleset: Ruleset;
  texts: Texts;
  routing: Routing;
}

export function loadCoreData(lang: Lang, dataDir = DEFAULT_DATA_DIR): CoreData {
  return {
    ruleset: loadRuleset(dataDir),
    texts: loadTexts(lang, dataDir),
    routing: loadRouting(dataDir),
  };
}
