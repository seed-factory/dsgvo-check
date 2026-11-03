/**
 * Schemas and loaders of test/data/browser/*.yaml: names of identifiers, bot-challenge signatures, the page vocabulary of
 * the in-page readers and the page-selection lists. Each file owns one key of the merged directory; the loaders hand the
 * collector compiled values, so the lists are edited in YAML and nothing else changes.
 */
import { z } from 'zod';
import { loadSection } from '../../core/data/load.ts';
import { dataSection, LowerName, RegexSource } from '../../core/data/parse.ts';
import type { DocumentPatterns } from './in-page/document.ts';
import type { DomPatterns } from './in-page/dom.ts';

const alternation = (fragments: readonly string[]): string => fragments.join('|');

export const identifiersSection = dataSection(
  'browser',
  'identifiers',
  z
    .strictObject({
      params: z.array(LowerName).min(1),
      pathParams: z.array(LowerName).min(1),
      cookies: z.array(RegexSource),
      cookiesAnyCase: z.array(RegexSource),
      consentModeParams: z.array(LowerName).min(1),
      eventParams: z.array(LowerName).min(1),
    })
    .transform((v) => ({
      params: new Set(v.params) as ReadonlySet<string>,
      pathParams: new Set(v.pathParams) as ReadonlySet<string>,
      cookies: [
        ...v.cookies.map((source) => new RegExp(source)),
        ...v.cookiesAnyCase.map((source) => new RegExp(source, 'i')),
      ] as readonly RegExp[],
      consentModeParams: v.consentModeParams as readonly string[],
      eventParams: v.eventParams as readonly string[],
    })),
);

const ChallengeKind = z.enum(['cloudflare', 'akamai', 'captcha', 'waf-block']);
const PatternRule = z.strictObject({ pattern: RegexSource, kind: ChallengeKind, signal: z.string().min(1) });

export const challengesSection = dataSection(
  'browser',
  'challenges',
  z
    .strictObject({
      headers: z.array(
        z.strictObject({
          name: LowerName,
          kind: ChallengeKind,
          signal: z.string().min(1),
          status: z.number().int().optional(),
          allowEmptyValue: z.boolean().default(false),
        }),
      ),
      scripts: z.array(PatternRule),
      titles: z.array(PatternRule),
      texts: z.array(PatternRule),
    })
    .transform((v) => {
      const compiled = (rules: typeof v.scripts, flags: string) =>
        rules.map((r) => ({ re: new RegExp(r.pattern, flags), kind: r.kind, signal: r.signal }));
      return {
        headers: v.headers,
        scripts: compiled(v.scripts, ''),
        titles: compiled(v.titles, 'i'),
        texts: compiled(v.texts, 'i'),
      };
    }),
);

const Words = z.array(RegexSource).min(1);

export const domSection = dataSection(
  'browser',
  'dom',
  z
    .strictObject({
      bannerNames: Words,
      documentBannerNames: Words,
      bannerDialogText: Words,
      legalLinkHints: Words,
      placeholders: z.strictObject({
        classNames: Words,
        subjects: Words,
        actions: Words,
        leadingActions: Words,
        objects: Words,
        kinds: z.array(z.strictObject({ kind: z.enum(['maps', 'video']), words: Words })).min(1),
      }),
      pageChrome: z.strictObject({
        nouns: Words,
        layoutStatePrefixes: Words,
        componentParts: Words,
        componentHeaderOnly: Words,
      }),
    })
    .transform((v) => {
      const nouns = alternation(v.pageChrome.nouns);
      const ph = v.placeholders;
      const page: DomPatterns = {
        bannerNames: alternation(v.bannerNames),
        bannerDialogText: alternation(v.bannerDialogText),
        legalLinkHints: alternation(v.legalLinkHints),
        placeholderClass: alternation(ph.classNames),
        placeholderText:
          `((${alternation(ph.subjects)})[^.]{0,40}(${alternation(ph.actions)}))|` +
          `((${alternation(ph.leadingActions)})[^.]{0,20}(${alternation(ph.objects)}))`,
        placeholderKinds: ph.kinds.map((k) => ({ kind: k.kind, source: alternation(k.words) })),
      };
      const document: DocumentPatterns = {
        bannerNames: alternation(v.documentBannerNames),
        navWrapper: `(?:^|[\\s_-])(?:${nouns})(?:$|[\\s_-])`,
        layoutState: `(?:^|[_-])(?:${alternation(v.pageChrome.layoutStatePrefixes)})[_-](?:[a-z0-9]+[_-]){0,2}(?:${nouns})$`,
        componentBar:
          `(^|[\\s_-])(?:(?:${alternation(v.pageChrome.componentParts)})[_-]+(?:header|footer)|` +
          `(?:${alternation(v.pageChrome.componentHeaderOnly)})[_-]+header)(?=$|[\\s_-])`,
      };
      return { page, document };
    }),
);

export const pagesSection = dataSection(
  'browser',
  'pages',
  z
    .strictObject({
      extraKeywords: z.array(LowerName).min(1),
      excludedPaths: z.array(RegexSource).min(1),
      fileExtensions: z.array(RegexSource).min(1),
    })
    .transform((v) => ({
      extraKeywords: v.extraKeywords as readonly string[],
      excludedPath: new RegExp(`(${alternation(v.excludedPaths)})`, 'i'),
      file: new RegExp(`\\.(${alternation(v.fileExtensions)})$`, 'i'),
    })),
);

export const loadIdentifierRules = (dataDir?: string) => loadSection(identifiersSection, dataDir);
export const loadChallengeRules = (dataDir?: string) => loadSection(challengesSection, dataDir);
export const loadDomPatterns = (dataDir?: string) => loadSection(domSection, dataDir);
export const loadPageRules = (dataDir?: string) => loadSection(pagesSection, dataDir);

export type IdentifierRules = ReturnType<typeof loadIdentifierRules>;
export type ChallengeRules = ReturnType<typeof loadChallengeRules>;
export type PageRules = ReturnType<typeof loadPageRules>;

/** The sections, for the completeness test. */
export const browserSections = [identifiersSection, challengesSection, domSection, pagesSection] as const;
