/** Environment variable names of the settings: `DSGVO_CHECK_<SECTION>_<NAME>` with the key in upper snake case. */

export const ENV_PREFIX = 'DSGVO_CHECK_';

/** Settings that keep a name documented before the section scheme existed. */
const ENV_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  'scan.proxy': 'DSGVO_CHECK_PROXY',
};

const snake = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();

export function envName(section: string, key: string): string {
  return ENV_NAME_OVERRIDES[`${section}.${key}`] ?? `${ENV_PREFIX}${snake(section)}_${snake(key)}`;
}
