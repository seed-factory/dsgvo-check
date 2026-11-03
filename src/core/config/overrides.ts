/** The settings that differ from the built-in defaults, for the report; secrets and settings the report shows elsewhere are left out. */
import { configFields, settingOf } from './fields.ts';
import type { Config } from './schema.ts';

export type SettingValue = string | number | boolean;

/** Keyed by environment variable name, so a line of the report can be pasted into a `.env` file. */
export function configOverrides(config: Config): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const f of configFields()) {
    if (!f.listed) continue;
    const value = settingOf(config, f);
    if (JSON.stringify(value) === JSON.stringify(f.default)) continue;
    out[f.env] = Array.isArray(value) ? value.join(',') : (value as SettingValue);
  }
  return out;
}
