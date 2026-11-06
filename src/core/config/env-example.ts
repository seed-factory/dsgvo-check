/** Text of `.env.example`, generated from the schema so that names, defaults and descriptions cannot drift. */
import { type Bounds, type ConfigField, configFields, envValue } from './fields.ts';
import type { SectionName } from './schema.ts';

const WIDTH = 100;

const SECTION_TITLES: Readonly<Record<SectionName, string>> = {
  scan: 'scan: limits of one run',
  browser: 'browser: Chromium, pauses, timeouts, recording limits',
  http: 'http: passive HTTP probes',
  tls: 'tls: handshakes and certificate windows (TLS-02)',
  dns: 'dns: mail DNS lookups (MAIL-01, MAIL-02, MAIL-03)',
  cmp: 'cmp: cookie banner recognition (CONSENT-04)',
  legal: 'legal: Impressum details and statements of the privacy policy',
  report: 'report: output and size limits',
  pdf: 'pdf: PDF printing',
};

const HEADER = [
  'dsgvo-check settings. Every line is optional: the values shown are the built-in defaults, and a scan',
  'without any of them runs with exactly these values.',
  '',
  'Precedence: command-line flag > environment variable > this file (.env in the current directory) >',
  'built-in default. A variable that is already set in the environment wins over this file.',
  'Numbers carry their unit in the name (_MS milliseconds, _BYTES bytes, _DAYS days, _BITS bits). An empty',
  'value counts as unset. Values are read as they stand: no quotes needed, lists are comma-separated.',
  '',
  'Generated from src/core/config by `corepack pnpm env:example`; do not edit by hand.',
];

function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `# ${line} ${word}`.length > WIDTH) {
      lines.push(`# ${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(`# ${line}`);
  return lines;
}

function boundsText({ min, minExclusive, max }: Bounds): string {
  if (min !== null && max !== null)
    return minExclusive ? `Above ${min}, at most ${max}.` : `Range: ${min}..${max}.`;
  if (min !== null) return minExclusive ? `Above ${min}.` : `Minimum: ${min}.`;
  return `Maximum: ${max}.`;
}

function notes(f: ConfigField): string {
  const parts: string[] = [];
  if (f.kind === 'enum' && f.options) parts.push(`One of: ${f.options.join(', ')}.`);
  if (f.bounds) parts.push(boundsText(f.bounds));
  return parts.join(' ');
}

function entry(f: ConfigField): string[] {
  const text = [f.description, notes(f)].filter(Boolean).join(' ');
  return [...wrap(text), `# ${f.env}=${envValue(f.default)}`];
}

export function renderEnvExample(): string {
  const out: string[] = HEADER.map((l) => (l ? `# ${l}` : '#'));
  let section: SectionName | null = null;
  for (const f of configFields()) {
    if (f.section !== section) {
      section = f.section;
      out.push('', `# ---- ${SECTION_TITLES[section]}`);
    }
    out.push('', ...entry(f));
  }
  return `${out.join('\n')}\n`;
}
