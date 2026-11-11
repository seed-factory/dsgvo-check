/** Targets of a run: the URLs of the command line and of a targets file, their report directories and report variants. */
import path from 'node:path';
import { PROFILE_DETAIL, type ReportProfile } from './core/report/reporter.ts';
import type { Lang } from './core/report/schema.ts';
import { InvalidInputError } from './core/runtime/errors.ts';
import { parseTarget } from './core/url/url.ts';
import type { ReportVariant } from './reporters/write.ts';

export interface SiteTarget {
  url: string;
  outDir: string;
}

/** Comma-separated list: trimmed, without empty entries and duplicates, in the given order. */
export function parseList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** URLs of a targets file: one per line; blank lines and `#` comments (at line start or after whitespace) are ignored. */
export function parseTargetList(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

/** Directory name of a site below `--out`: its host, plus the port when the URL names a non-default one. */
export function siteDirName(url: string): string {
  const target = new URL(parseTarget(url).url);
  const host = target.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .replace(/[^a-z0-9.-]/g, '_');
  return target.port ? `${host}_${target.port}` : host;
}

/** Report variants below `dir`: the files themselves for one language and profile, else `<lang>/<profile>/`. */
export function reportVariants(
  dir: string,
  langs: readonly Lang[],
  profiles: readonly ReportProfile[],
): ReportVariant[] {
  if (langs.length === 1 && profiles.length === 1) {
    return [{ lang: langs[0] as Lang, detail: PROFILE_DETAIL[profiles[0] as ReportProfile], dir }];
  }
  return langs.flatMap((lang) =>
    profiles.map((profile) => ({
      lang,
      detail: PROFILE_DETAIL[profile],
      dir: path.join(dir, lang, profile),
    })),
  );
}

/**
 * The scans of a run. A single URL without a targets file keeps `outDir` and is not parsed here (scan() reports it);
 * with several URLs or a targets file every site gets `<outDir>/<site directory>`.
 */
export function planTargets(input: {
  urls: readonly string[];
  fileUrls: readonly string[] | null;
  outDir: string;
  maxTargets: number;
  snapshot: boolean;
}): SiteTarget[] {
  const all = [...input.urls, ...(input.fileUrls ?? [])];
  if (all.length <= 1 && input.fileUrls === null) {
    return [{ url: all[0] ?? '', outDir: input.outDir }];
  }

  if (input.snapshot) throw new InvalidInputError('targets-snapshot');
  if (all.length === 0) throw new InvalidInputError('target-missing');
  if (all.length > input.maxTargets) {
    throw new InvalidInputError('targets-too-many', { count: all.length, max: input.maxTargets });
  }

  const seen = new Set<string>();
  return all.map((url) => {
    const dir = siteDirName(url);
    if (seen.has(dir)) throw new InvalidInputError('targets-duplicate', { dir });
    seen.add(dir);
    return { url, outDir: path.join(input.outDir, dir) };
  });
}
