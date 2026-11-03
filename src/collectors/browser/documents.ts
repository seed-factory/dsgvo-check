/**
 * Legal documents: text of Impressum / Datenschutzerklärung by sections with provenance, without clicks and
 * independent of the consent outcome. PDF → `complete: false` (`pdf-not-evaluated`). Same-origin frames are
 * included; other frames are only reported. Pure helpers decide soft-404 and completeness.
 */
import type { Page } from 'playwright-core';
import type { DocumentKind, DocumentPart, DocumentRecord } from '../../core/snapshot-browser.ts';
import type { BrowserPhase, SanitizedUrl } from '../../core/snapshot-common.ts';
import { sanitizeRequestUrl } from './features.ts';
import { documentInPage, type RawDocument } from './in-page-document.ts';
import { isNotFoundText, type LegalLexicon, markerLanguages } from './legal-lexicon.ts';
import { loadLegalLexicon } from './legal-lexicon-file.ts';
import { normalizeText, redactFreeText, sha256Hex } from './util.ts';

const MAX_CHARS = 400_000;
/** Below this length a page without a marker has no recognisable content (soft-404); above it, it is unconfirmed. */
const MIN_TEXT: Record<DocumentKind, number> = { impressum: 100, privacy: 500 };
/** A page with an explicit error title and less text than this is an error page even if a marker is present. */
const ERROR_PAGE_MAX_TEXT = 3_000;

export type DocumentVerdict = 'ok' | 'soft-404' | 'unconfirmed';

export interface JudgeInput {
  title: string;
  h1: string;
  /** Section headings of the whole document (all levels, frames included). */
  sections?: readonly string[];
  /** Ignored: the verdict never rests on body text, a word in a footer or navigation proves nothing. */
  text?: string;
  textLength: number;
}

/**
 * Verdict on a 2xx page that was fetched as the document `kind`. The type is decided by localised markers
 * (data/legal/links.yaml) in the title, the h1 and the section headings of the whole document, not by one keyword in
 * the first characters. `ok`: marker found, `languages` lists the languages of the markers. `soft-404`: an explicit
 * error title, or a page without a marker that has no recognisable content. `unconfirmed`: a substantive page
 * without a marker (a home page whose footer links to the Impressum, a document in a language the lexicon does not
 * know): neither found nor an error page.
 */
export function judgeDocumentDetail(
  kind: DocumentKind,
  d: JudgeInput,
  lexicon: LegalLexicon = loadLegalLexicon(),
): { verdict: DocumentVerdict; languages: string[] } {
  const titles = [d.title, d.h1];
  const languages = markerLanguages(lexicon, kind, [...titles, ...(d.sections ?? [])]);
  if (titles.some((t) => isNotFoundText(lexicon, t))) {
    const titled = markerLanguages(lexicon, kind, titles).length > 0;
    if (d.textLength < ERROR_PAGE_MAX_TEXT || !titled) return { verdict: 'soft-404', languages: [] };
  }
  if (languages.length > 0) return { verdict: 'ok', languages };
  return { verdict: d.textLength >= MIN_TEXT[kind] ? 'unconfirmed' : 'soft-404', languages: [] };
}

export function judgeDocument(
  kind: DocumentKind,
  d: JudgeInput,
  lexicon: LegalLexicon = loadLegalLexicon(),
): DocumentVerdict {
  return judgeDocumentDetail(kind, d, lexicon).verdict;
}

/**
 * Language recorded for a document: the language of the markers decides, the `lang` attribute does not (a Portuguese
 * policy with `lang="en"`). German or English markers keep a de/en attribute and override another one; only foreign
 * markers name that language; without markers the attribute stays. PRIV-01 evaluates only de and en.
 */
export function documentLang(attr: string | null, languages: readonly string[]): string | null {
  const a = attr ? attr.toLowerCase() : null;
  const native = languages.filter((l) => l === 'de' || l === 'en');
  if (native.length > 0) {
    if (a && /^(de|en)\b/.test(a)) return a;
    return native.includes('de') ? 'de' : 'en';
  }
  return languages[0] ?? a;
}

/** Heading texts of the document: every element of the heading paths of the parts, in order, once. */
function headingsOf(parts: readonly DocumentPart[]): string[] {
  const seen = new Set<string>();
  for (const p of parts) {
    if (!p.section) continue;
    for (const h of p.section.split(' > ')) if (h !== '') seen.add(h);
  }
  return [...seen];
}

export interface DocumentContext {
  kind: DocumentKind;
  phase: BrowserPhase;
  url: SanitizedUrl;
  foundVia: DocumentRecord['foundVia'];
  status: number | null;
  contentType: string;
}

function partsOf(raw: RawDocument, sourceUrl: string, prefix: string, frameUrl?: string): DocumentPart[] {
  let i = 0;
  return (
    raw.parts
      // E-mail addresses, mailto: values and URL queries are masked before the text is hashed or stored.
      .map((p) => ({ ...p, text: redactFreeText(normalizeText(p.text)) }))
      .filter((p) => p.text.length > 0)
      .map((p) => ({
        id: `${prefix}-${++i}`,
        ...(p.section ? { section: redactFreeText(normalizeText(p.section)) } : {}),
        text: p.text,
        // Hidden text stays hidden-irrelevant inside a frame too (it must not count as a mention); the frame itself is
        // recorded in `frameUrl`.
        origin: p.origin === 'hidden-irrelevant' ? 'hidden-irrelevant' : frameUrl ? 'frame' : p.origin,
        sourceUrl,
        ...(frameUrl ? { frameUrl } : {}),
      }))
  );
}

export function pdfDocument(c: Omit<DocumentContext, 'contentType'> & { id: string }): DocumentRecord {
  return {
    id: c.id,
    kind: c.kind,
    url: c.url,
    finalUrl: c.url,
    status: c.status,
    foundVia: c.foundVia,
    linkedFrom: [],
    phase: c.phase,
    format: 'pdf',
    lang: null,
    parts: [],
    manifest: { expandablesFound: 0, expandablesOpened: 0, framesIncluded: 0, linkedPages: 0, textLength: 0 },
    complete: false,
    errors: ['pdf-not-evaluated'],
    sha256: null,
  };
}

/** Extract the document shown on `page` (already navigated and quiet). */
export async function extractDocument(
  page: Page,
  c: DocumentContext & { id: string },
): Promise<DocumentRecord> {
  const finalUrl = sanitizeRequestUrl(page.url());
  if (/application\/pdf/i.test(c.contentType)) return { ...pdfDocument(c), finalUrl };
  const errors: string[] = [];
  const main = await page.evaluate(documentInPage, { maxChars: MAX_CHARS });
  const parts = partsOf(main, finalUrl, `${c.id}-p`);
  // Headings of the navigation or footer prove nothing about the type of the page. The reader of the page
  // (`documentInPage`) sorts the headings into chrome and content with the rule it applies to collapsed elements.
  const chromeHeads = new Set<string>();
  const contentHeads = new Set<string>();
  const notePlaces = (places: RawDocument['headingPlaces']) => {
    for (const t of places?.chrome ?? []) chromeHeads.add(redactFreeText(normalizeText(t)));
    for (const t of places?.content ?? []) contentHeads.add(redactFreeText(normalizeText(t)));
  };
  notePlaces(main.headingPlaces);
  let framesIncluded = 0;
  let pageOrigin = '';
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {
    pageOrigin = '';
  }
  let foreignFrames = 0;
  // Completeness covers every included part: truncation, unopened expandables and unreadable frames of
  // same-origin frames count like those of the main document.
  let truncated = main.truncated;
  let expandablesFound = main.expandablesFound;
  let expandablesWithContent = main.expandablesWithContent;
  let unreadableFrames = 0;
  let framesFound = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    framesFound++;
    let origin = '';
    try {
      origin = new URL(frame.url()).origin;
    } catch {
      continue;
    }
    if (origin !== pageOrigin) {
      if (/^https?:/.test(frame.url())) foreignFrames++;
      continue;
    }
    const fr = await frame.evaluate(documentInPage, { maxChars: MAX_CHARS }).catch(() => null);
    if (!fr) {
      unreadableFrames++;
      continue;
    }
    framesIncluded++;
    notePlaces(fr.headingPlaces);
    truncated ||= fr.truncated;
    expandablesFound += fr.expandablesFound;
    expandablesWithContent += fr.expandablesWithContent;
    parts.push(...partsOf(fr, finalUrl, `${c.id}-f${framesIncluded}`, sanitizeRequestUrl(frame.url())));
  }
  const fullText = parts.map((p) => p.text).join('\n');
  const textLength = fullText.length;
  const ok = c.status !== null && c.status >= 200 && c.status < 300;
  if (!ok) errors.push(c.status === null ? 'navigation-failed' : `http-${c.status}`);
  const judged = judgeDocumentDetail(c.kind, {
    title: main.title,
    // Only an h1 of the content (the reader leaves out the h1 of a navigation, footer or hidden element).
    h1: main.h1,
    // A text that is a heading in the content as well stays (a footer column "Impressum" next to a real one).
    sections: headingsOf(parts).filter((h) => !chromeHeads.has(h) || contentHeads.has(h)),
    textLength,
  });
  if (ok && judged.verdict !== 'ok') errors.push(judged.verdict);
  if (truncated) errors.push('truncated');
  if (expandablesWithContent < expandablesFound) errors.push('expand-failed');
  if (unreadableFrames > 0) errors.push('frame-unreadable');
  if (textLength < MIN_TEXT[c.kind]) {
    errors.push(foreignFrames > 0 ? 'content-in-foreign-frame' : 'too-short');
  }
  return {
    id: c.id,
    kind: c.kind,
    url: c.url,
    finalUrl,
    status: c.status,
    foundVia: c.foundVia,
    linkedFrom: [],
    phase: c.phase,
    format: /text\/html|application\/xhtml/i.test(c.contentType) || c.contentType === '' ? 'html' : 'other',
    // The markers' language decides; the lang attribute is the fallback (it says "en" for a Portuguese policy).
    lang: documentLang(main.lang || null, ok ? judged.languages : []),
    parts,
    manifest: {
      expandablesFound,
      // Content of collapsed elements is read from the DOM without clicking (counted as opened when present).
      expandablesOpened: expandablesWithContent,
      framesIncluded,
      framesFound,
      linkedPages: 0,
      textLength,
    },
    complete: errors.length === 0,
    errors,
    sha256: textLength > 0 ? sha256Hex(fullText) : null,
  };
}
