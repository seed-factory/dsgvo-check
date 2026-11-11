/**
 * Provider details of an Impressum in the text the collector read (LEGAL-01): blocks of a document and the kinds of
 * details (test/data/legal/provider-details.yaml) each holds. Only the number of kinds counts, never a value.
 */
import {
  type LegalLexicon,
  matchLegalLink,
  normalizeLegalText,
} from '../../collectors/browser/legal/lexicon.ts';
import { type ProviderDetails, providerDetailsSection } from '../../collectors/browser/legal/sections.ts';
import type { DocumentPart, DocumentPartPlace, DocumentRecord } from '../../core/snapshot/browser.ts';

/** Per kind of details, its phrases as normalised words. */
export type DetailsMatcher = readonly (readonly (readonly string[])[])[];

export function detailsMatcher(data: ProviderDetails): DetailsMatcher {
  return Object.values(data.groups).map((byLang) =>
    Object.values(byLang)
      .flat()
      .map((p) => normalizeLegalText(p).split(' '))
      .filter((words) => words[0] !== ''),
  );
}

const cache = new WeakMap<object, DetailsMatcher>();

/** The matcher of the merged `test/data/legal` object (`ctx.data.legal`), validated once per object. */
export function detailsMatcherOf(legal: unknown): DetailsMatcher {
  const key = legal !== null && typeof legal === 'object' ? legal : null;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const m = detailsMatcher(providerDetailsSection.parse(legal));
  if (key) cache.set(key, m);
  return m;
}

function containsWords(words: readonly string[], phrase: readonly string[]): boolean {
  for (let i = 0; i + phrase.length <= words.length; i++) {
    let j = 0;
    while (j < phrase.length && words[i + j] === phrase[j]) j++;
    if (j === phrase.length) return true;
  }
  return false;
}

/** Indexes of the kinds of details whose phrases occur as whole words in a row in `text`. */
export function detailKinds(m: DetailsMatcher, text: string): Set<number> {
  const norm = normalizeLegalText(text);
  const words = norm === '' ? [] : norm.split(' ');
  const kinds = new Set<number>();
  m.forEach((phrases, kind) => {
    if (phrases.some((p) => containsWords(words, p))) kinds.add(kind);
  });
  return kinds;
}

/**
 * A section with its subsections, inside one place (content or chrome) and one frame: the parts in a row under the
 * heading path `path`. Text before the first heading forms blocks of its own, with an empty path.
 */
export interface Block {
  doc: DocumentRecord;
  /** The first part of the block. */
  first: DocumentPart;
  path: string;
  /** The innermost heading of `path` ('' for text before the first heading). */
  heading: string;
  depth: number;
  place: DocumentPartPlace;
  kinds: number;
}

const placeOf = (p: DocumentPart): DocumentPartPlace => p.place ?? 'content';
const headingsOf = (p: DocumentPart): string[] => (p.section ? p.section.split(' > ') : []);

/** An empty path holds only the parts without a heading; any other path every part whose headings start with it. */
function under(part: readonly string[], path: readonly string[]): boolean {
  if (path.length === 0) return part.length === 0;
  return part.length >= path.length && path.every((h, i) => part[i] === h);
}

/**
 * Every block of the document with the number of kinds of details it holds. Only the text of the parts counts, hidden
 * text left out: the reader puts the visible text of a heading into the part it opens, while the heading path keeps
 * the whole text of the heading element, hidden words included. `sums` says whether the section of a heading holds the
 * details of its subsections too; a section whose heading does not sum holds only the text under that heading itself,
 * so the heading of a whole page does not add up the details of its unrelated sections.
 */
export function blocksOf(
  doc: DocumentRecord,
  m: DetailsMatcher,
  sums: (heading: string) => boolean = () => true,
): Block[] {
  const parts = doc.parts.filter((p) => p.origin !== 'hidden-irrelevant');
  const heads = parts.map(headingsOf);
  // The kinds in each part, computed once for all blocks.
  const textKinds = parts.map((p) => detailKinds(m, p.text));
  const sameRun = (a: number, b: number) =>
    placeOf(parts[a] as DocumentPart) === placeOf(parts[b] as DocumentPart) &&
    parts[a]?.frameUrl === parts[b]?.frameUrl;

  const blocks: Block[] = [];
  for (let i = 0; i < parts.length; i++) {
    const own = heads[i] as string[];
    for (let depth = own.length === 0 ? 0 : 1; depth <= own.length; depth++) {
      const path = own.slice(0, depth);
      // A block starts where the run under its heading starts, not in the middle of it.
      if (i > 0 && under(heads[i - 1] as string[], path) && sameRun(i - 1, i)) continue;

      const nested = depth === 0 || sums(path[depth - 1] as string);
      const kinds = new Set<number>();
      for (let j = i; j < parts.length && under(heads[j] as string[], path) && sameRun(i, j); j++) {
        if (!nested && (heads[j] as string[]).length !== depth) continue;
        for (const k of textKinds[j] as Set<number>) kinds.add(k);
      }
      blocks.push({
        doc,
        first: parts[i] as DocumentPart,
        path: path.join(' > '),
        heading: path[path.length - 1] ?? '',
        depth,
        place: placeOf(parts[i] as DocumentPart),
        kinds: kinds.size,
      });
    }
  }
  return blocks;
}

/** A heading longer than this is a sentence, not a section title. */
export const MAX_HEADING_CHARS = 80;

/** The heading is exactly one of the Impressum labels ("Impressum", "Anbieterkennzeichnung"). */
export function isImpressumHeading(lex: LegalLexicon, heading: string): boolean {
  if (heading === '' || heading.length > MAX_HEADING_CHARS) return false;
  return matchLegalLink(lex, 'impressum', { text: heading, path: '' })?.tier === 0;
}

/**
 * The heading that names the block in a text. Chrome text without a heading of its own carries the heading of the
 * content section in front of it; when the record says which headings belong to the content, that one is left out.
 */
export function shownHeading(b: Block): string | null {
  if (b.heading === '' || b.heading.length > MAX_HEADING_CHARS) return null;
  if (b.place === 'chrome' && b.doc.contentHeadings?.includes(b.heading)) return null;
  return b.heading;
}

/** More kinds first; with as many kinds, the innermost heading names the details most precisely. */
export function bestBlock(blocks: readonly Block[]): Block | null {
  let best: Block | null = null;
  for (const b of blocks) {
    if (!best || b.kinds > best.kinds || (b.kinds === best.kinds && b.depth > best.depth)) best = b;
  }
  return best;
}
