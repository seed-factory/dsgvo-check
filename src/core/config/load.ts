/** Settings from the environment and a `.env` file: names, coercion of the text values, validation against the schema. */
import path from 'node:path';
import type { z } from 'zod';
import { loadTexts, type Texts } from '../data/load.ts';
import { uiText } from '../data/messages.ts';
import type { Lang } from '../report/schema.ts';
import { type EnvFile, EnvFileError, readEnvFile } from './dotenv.ts';
import { type ConfigField, configFields } from './fields.ts';
import { ENV_PREFIX } from './names.ts';
import { type ProblemReason, REASON, reasonOf } from './problems.ts';
import { type Config, ConfigSchema, SECTIONS } from './schema.ts';

/** Where the refused value came from; `default` is a built-in value that another setting contradicts. */
export type ProblemSource = 'environment' | 'config' | 'default' | { file: string };

export interface ConfigProblem {
  variable: string;
  /** Null for secret settings. */
  value: string | null;
  source: ProblemSource;
  reason: ProblemReason;
}

/** `NAME=value (source): reason` in the language of `texts`; the value of a secret setting is not shown. */
export function formatProblem(p: ConfigProblem, texts: Texts): string {
  const source = typeof p.source === 'string' ? uiText(texts, `config.source.${p.source}`) : p.source.file;
  const reason = uiText(texts, `config.problem.${p.reason.id}`, p.reason.params);
  return `${p.variable}${p.value === null ? '' : `=${p.value}`} (${source}): ${reason}`;
}

/** The problems as one line for `failure.invalid-config`; the variable names alone when the texts cannot be loaded. */
export function describeProblems(problems: readonly ConfigProblem[], lang: Lang, dataDir?: string): string {
  try {
    const texts = loadTexts(lang, dataDir);
    return problems.map((p) => formatProblem(p, texts)).join('; ');
  } catch {
    return problems.map((p) => p.variable).join(', ');
  }
}

/** Carries the problems; its own message is for developers (variable and reason id), users get `describeProblems`. */
export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];
  constructor(problems: readonly ConfigProblem[]) {
    super(problems.map((p) => `${p.variable}: ${p.reason.id}`).join('; '));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface ConfigSources {
  env: Readonly<Record<string, string | undefined>>;
  file?: EnvFile | null;
}

export interface LoadedConfig {
  config: Config;
  /** The `.env` file that was read, if any. */
  file: string | null;
  /** Settings taken from the `.env` file (the environment wins over it). */
  fromFile: readonly string[];
  /** Every setting that the environment or the file decided; the rest keeps its built-in value. */
  set: readonly string[];
  /** Variables of a known section that name no setting: most likely typos. */
  unknown: readonly string[];
}

type Coerced = { ok: true; value: unknown } | { ok: false; reason: ProblemReason };

const refused = (id: string): Coerced => ({ ok: false, reason: { id, params: {} } });

function coerce(field: ConfigField, text: string): Coerced {
  switch (field.kind) {
    case 'int':
      return /^-?\d+$/.test(text) ? { ok: true, value: Number(text) } : refused(REASON.integer);

    case 'number':
      return /^-?\d+(\.\d+)?$/.test(text) ? { ok: true, value: Number(text) } : refused(REASON.number);

    case 'list':
      return {
        ok: true,
        value: text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };

    default:
      return { ok: true, value: text };
  }
}

const SECTION_VARIABLE = new RegExp(`^${ENV_PREFIX}(?:${Object.keys(SECTIONS).join('|').toUpperCase()})_`);

/** Where the text of a setting came from, for the message about it. */
type Origins = Map<ConfigField, { text: string; source: ProblemSource }>;

/** Validates the settings found in `sources`; the environment wins over the file, an empty value counts as unset. */
export function resolveConfig(sources: ConfigSources): LoadedConfig {
  const fields = configFields();
  const { raw, origin, problems, fromFile, set } = readSettings(fields, sources);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) problems.push(...schemaProblems(parsed.error.issues, fields, origin));
  if (!parsed.success || problems.length > 0) throw new ConfigError(problems);

  const known = new Set(fields.map((f) => f.env));
  const names = new Set([...Object.keys(sources.env), ...Object.keys(sources.file?.values ?? {})]);
  const unknown = [...names].filter((n) => SECTION_VARIABLE.test(n) && !known.has(n)).sort();
  return { config: parsed.data, file: sources.file?.path ?? null, fromFile, set, unknown };
}

/** The text of each setting that is set, coerced to its type; values that do not coerce become problems. */
function readSettings(fields: readonly ConfigField[], sources: ConfigSources) {
  const raw: Record<string, Record<string, unknown>> = {};
  const origin: Origins = new Map();
  const problems: ConfigProblem[] = [];
  const fromFile: string[] = [];
  const set: string[] = [];

  for (const f of fields) {
    const fromEnv = sources.env[f.env]?.trim();
    const fromDotenv = sources.file?.values[f.env]?.trim();
    const text = fromEnv || fromDotenv;
    if (!text) continue;

    set.push(f.env);
    const source: ProblemSource = fromEnv ? 'environment' : { file: sources.file?.path ?? '.env' };
    origin.set(f, { text, source });

    const c = coerce(f, text);
    if (!c.ok) {
      problems.push({ variable: f.env, value: f.secret ? null : text, source, reason: c.reason });
      continue;
    }
    const section = raw[f.section] ?? {};
    section[f.key] = c.value;
    raw[f.section] = section;
    if (!fromEnv) fromFile.push(f.env);
  }
  return { raw, origin, problems, fromFile, set };
}

/** What the schema refused, each issue tied back to the variable and the source that set it. */
function schemaProblems(
  issues: readonly z.core.$ZodIssue[],
  fields: readonly ConfigField[],
  origin: Origins,
): ConfigProblem[] {
  const byPath = new Map(fields.map((f) => [`${f.section}.${f.key}`, f]));

  return issues.map((issue) => {
    const field = byPath.get(`${String(issue.path[0])}.${String(issue.path[1])}`);
    const found = field ? origin.get(field) : undefined;
    return {
      variable: field?.env ?? issue.path.join('.'),
      value: !field || field.secret ? null : (found?.text ?? String(field.default ?? '')),
      source: found?.source ?? 'default',
      reason: reasonOf(issue),
    };
  });
}

function readEnvFileOrThrow(file: string): EnvFile | null {
  try {
    return readEnvFile(file);
  } catch (err) {
    if (!(err instanceof EnvFileError)) throw err;
    const reason = { id: REASON.unreadable, params: { code: err.code } };
    throw new ConfigError([{ variable: path.basename(file), value: null, source: { file }, reason }]);
  }
}

/** Reads `process.env` and the `.env` file of the working directory. */
export function loadConfig(
  options: { env?: Readonly<Record<string, string | undefined>>; cwd?: string } = {},
): LoadedConfig {
  const file = readEnvFileOrThrow(path.join(options.cwd ?? process.cwd(), '.env'));
  return resolveConfig({ env: options.env ?? process.env, file });
}

/** Validates settings passed as an object (the `config` option of `scan()`); invalid values throw a `ConfigError`. */
export function parseConfigInput(input: unknown): Config {
  const parsed = ConfigSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw new ConfigError(
    parsed.error.issues.map((i) => ({
      variable: i.path.join('.') || 'config',
      value: null,
      source: 'config',
      reason: reasonOf(i),
    })),
  );
}
