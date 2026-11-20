/** Schema and loader of test/data/http/html.yaml: the wording the HTTP collector acts on in an HTML prefix. */
import { z } from 'zod';
import { loadSection } from '../../core/data/load.ts';
import { dataSection, LowerName, RegexSource } from '../../core/data/parse.ts';

const Fragments = z.array(RegexSource).min(1);
const alternation = (fragments: readonly string[]): string => fragments.join('|');

export const htmlSection = dataSection(
  'http',
  'html',
  z
    .strictObject({
      form: z.strictObject({
        searchFieldNames: z.array(LowerName).min(1),
        searchFormMarkers: Fragments,
      }),
      legalLinks: z.strictObject({
        impressumText: Fragments,
        impressumPath: Fragments,
        privacyText: Fragments,
        privacyPath: Fragments,
        settingsText: Fragments,
      }),
    })
    .transform((v) => ({
      searchFieldNames: new Set(v.form.searchFieldNames) as ReadonlySet<string>,
      searchForm: new RegExp(alternation(v.form.searchFormMarkers), 'i'),
      impressumText: new RegExp(`\\b(${alternation(v.legalLinks.impressumText)})\\b`, 'i'),
      impressumPath: new RegExp(alternation(v.legalLinks.impressumPath), 'i'),
      privacyText: new RegExp(alternation(v.legalLinks.privacyText), 'i'),
      privacyPath: new RegExp(alternation(v.legalLinks.privacyPath), 'i'),
      settingsText: new RegExp(alternation(v.legalLinks.settingsText), 'i'),
    })),
);

export const loadHtmlRules = (dataDir?: string) => loadSection(htmlSection, dataDir);
export type HtmlRules = ReturnType<typeof loadHtmlRules>;

/** The sections, for the completeness test. */
export const httpSections = [htmlSection] as const;
