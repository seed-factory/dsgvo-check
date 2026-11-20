import { parseUrl as parse } from '../../../core/url/url.ts';
import { type LanguageRules, loadPageRules } from '../rules.ts';

export function normalizePageLabel(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function pathSegments(raw: string): string[] {
  const u = parse(raw);
  if (!u) return [];
  return u.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}

/** A listed language code with an optional region in BCP 47 form (`de`, `de-at`, `en_GB`), normalized; else null. */
function localeOf(segment: string | undefined, rules: LanguageRules): string | null {
  if (segment === undefined) return null;
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}))?$/.exec(segment.toLowerCase());
  if (!m || !rules.localePrefixes.has(m[1] as string)) return null;
  return m[2] ? `${m[1]}-${m[2]}` : (m[1] as string);
}

const languageOf = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? '';

export interface LanguageStart {
  raw: string;
  lang?: string;
}

export interface LanguageContext {
  rules: LanguageRules;
  /** Locale of the start page's first path segment (`de`, `de-at`), or null when its path has none. */
  startLocale: string | null;
  /** Language of the start page: its `lang`, else that of its locale prefix. */
  startLanguage: string | null;
  /** Locale prefixes the start page's own language switch leads to. */
  alternatePrefixes: ReadonlySet<string>;
}

export interface AlternateCandidate {
  raw: string;
  text: string;
  accessibleName?: string;
  hreflang?: string;
}

const labelsOf = (l: AlternateCandidate): string[] =>
  [l.text, l.accessibleName ?? ''].map(normalizePageLabel).filter((x) => x !== '');

export function languageContext(
  start: LanguageStart,
  links: readonly AlternateCandidate[],
  rules: LanguageRules = loadPageRules().languages,
): LanguageContext {
  const startLocale = localeOf(pathSegments(start.raw)[0], rules);
  const startLanguage = start.lang
    ? languageOf(start.lang) || null
    : startLocale
      ? languageOf(startLocale)
      : null;
  const base: LanguageContext = { rules, startLocale, startLanguage, alternatePrefixes: new Set() };

  // A start page without a locale prefix may still switch to `/en/…`: the sections behind that switch are the other
  // language as well, even where their own label does not say so. Its switch to `/de/` of its own language leads to
  // the same language: the sections there are its own (a region of it, `/de-at/`, stays another version).
  const startTag = start.lang ? localeOf(start.lang, rules) : null;
  const ownLocale = (locale: string) =>
    startLocale === null && (locale === startLanguage || locale === startTag);
  const prefixes = new Set<string>();
  for (const l of links) {
    const locale = localeOf(pathSegments(l.raw)[0], rules);
    if (locale === null || locale === startLocale || ownLocale(locale)) continue;
    if (isLanguageAlternate(l, base)) prefixes.add(locale);
  }
  return { ...base, alternatePrefixes: prefixes };
}

/**
 * Another language version of the site: a link whose `hreflang` names another language than the start page (the same
 * language still leaves the prefix to decide: `/de-at/` beside `/de/`); a locale prefix other than the start page's or
 * one its language switch leads to; a bare locale root (`/en/`) without visible
 * text, such as a flag whose name is a sentence ("Switch to English"); a link labelled with a language code ("EN");
 * or one labelled with a language name ("English") that leads into a locale prefix or to the root. "IT-Service" on
 * `/it/` of a site without locale prefixes stays a section, and so does a course page "Englisch" of a language school.
 */
export function isLanguageAlternate(l: AlternateCandidate, ctx: LanguageContext): boolean {
  const hreflang = l.hreflang && l.hreflang !== 'x-default' ? languageOf(l.hreflang) : null;
  if (hreflang && ctx.startLanguage !== null && hreflang !== ctx.startLanguage) return true;

  const segments = pathSegments(l.raw);
  const locale = localeOf(segments[0], ctx.rules);
  if (locale !== null) {
    if (ctx.startLocale !== null && locale !== ctx.startLocale) return true;
    if (ctx.alternatePrefixes.has(locale)) return true;
    if (segments.length === 1 && normalizePageLabel(l.text) === '') return true;
  }

  const labels = labelsOf(l);
  if (labels.some((label) => localeOf(label, ctx.rules) !== null)) return true;
  const named = labels.some((label) => ctx.rules.switchLabels.has(label));
  return named && (locale !== null || segments.length === 0);
}

/** URL template of a page: its first path segment, after the locale prefix on a site whose start page has one. */
export function templateOf(raw: string, lang: LanguageContext): string {
  const segments = pathSegments(raw);
  const skip = lang.startLocale !== null && localeOf(segments[0], lang.rules) !== null ? 1 : 0;
  return segments[skip] ?? '';
}
