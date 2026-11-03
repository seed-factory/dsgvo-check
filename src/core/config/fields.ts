/** The settings as a flat list, read off the zod schema: environment name, kind, default and description of each. */
import type { z } from 'zod';
import { envName } from './names.ts';
import { type Config, DEFAULT_CONFIG, SECTIONS, type SectionName } from './schema.ts';

export type FieldKind = 'int' | 'number' | 'enum' | 'string' | 'list';

export interface Bounds {
  min: number | null;
  /** The lower bound itself is not allowed. */
  minExclusive: boolean;
  max: number | null;
}

export interface ConfigField {
  section: SectionName;
  key: string;
  env: string;
  kind: FieldKind;
  default: unknown;
  description: string;
  /** Values of secret settings never reach reports or messages. */
  secret: boolean;
  /** Listed among the report's `settings`: not secret and not already shown by a dedicated option of the report. */
  listed: boolean;
  /** Allowed values of an enum, or of the elements of a list. */
  options: readonly string[] | null;
  /** Bounds of a number; null when it is unbounded. */
  bounds: Bounds | null;
  /** The zod type of the field, for validating one value on its own. */
  schema: z.ZodType;
}

const SECRET_FIELDS: ReadonlySet<string> = new Set(['scan.proxy']);

/** Settings that the report shows as options of the scan, and the output path, which stays out of reports. */
const SHOWN_ELSEWHERE: ReadonlySet<string> = new Set([
  'scan.failOn',
  'scan.maxPages',
  'scan.timeoutMs',
  'browser.sandbox',
  'report.formats',
  'report.lang',
  'report.outDir',
]);

interface Wrapper {
  innerType?: z.ZodType;
  element?: z.ZodType;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    const type = s.def.type;
    const inner = (s.def as Wrapper).innerType;
    if ((type === 'default' || type === 'nullable' || type === 'optional') && inner) s = inner;
    else return s;
  }
}

interface Check {
  check: string;
  value: number;
  inclusive: boolean;
}

function boundsOf(n: z.ZodNumber): Bounds | null {
  const checks = (n.def.checks ?? []).map((c) => c._zod.def as unknown as Check);
  const lower = checks.find((c) => c.check === 'greater_than');
  const upper = checks.find((c) => c.check === 'less_than');
  if (!lower && !upper) return null;
  return { min: lower?.value ?? null, minExclusive: lower?.inclusive === false, max: upper?.value ?? null };
}

function describe(section: SectionName, key: string, schema: z.ZodType): ConfigField {
  const inner = unwrap(schema);
  const type = inner.def.type;
  let kind: FieldKind;
  let options: readonly string[] | null = null;
  let bounds: Bounds | null = null;
  if (type === 'number') {
    const n = inner as z.ZodNumber;
    kind = n.isInt ? 'int' : 'number';
    bounds = boundsOf(n);
  } else if (type === 'enum') {
    kind = 'enum';
    options = (inner as z.ZodEnum).options as readonly string[];
  } else if (type === 'array') {
    kind = 'list';
    const element = (inner.def as Wrapper).element as z.ZodType;
    if (element.def.type === 'enum') options = (element as z.ZodEnum).options as readonly string[];
  } else kind = 'string';
  const path = `${section}.${key}`;
  return {
    section,
    key,
    env: envName(section, key),
    kind,
    default: (DEFAULT_CONFIG[section] as Record<string, unknown>)[key],
    description: schema.meta()?.description ?? '',
    secret: SECRET_FIELDS.has(path),
    listed: !SECRET_FIELDS.has(path) && !SHOWN_ELSEWHERE.has(path),
    options,
    bounds,
    schema,
  };
}

let cache: readonly ConfigField[] | null = null;

export function configFields(): readonly ConfigField[] {
  cache ??= (Object.keys(SECTIONS) as SectionName[]).flatMap((section) =>
    Object.entries(SECTIONS[section].shape).map(([key, schema]) =>
      describe(section, key, schema as z.ZodType),
    ),
  );
  return cache;
}

export function settingOf(config: Config, field: ConfigField): unknown {
  return (config[field.section] as Record<string, unknown>)[field.key];
}

/** The value as it is written after `NAME=` in a `.env` file. */
export function envValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return Array.isArray(value) ? value.join(',') : String(value);
}
