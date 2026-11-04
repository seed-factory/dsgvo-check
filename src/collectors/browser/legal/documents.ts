// Legal documents: text of Impressum / Datenschutzerklärung by sections with provenance, without clicks and independent
// of the consent outcome. PDF → `complete: false`; same-origin frames are included, other frames only reported.
import type { Page } from 'playwright-core';
import type { DocumentKind, DocumentPart, DocumentRecord } from '../../../core/snapshot/browser.ts';
import type { BrowserPhase, SanitizedUrl } from '../../../core/snapshot/common.ts';
import { type DocumentPatterns, documentInPage, type RawDocument } from '../in-page/document.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { loadDomPatterns } from '../rules.ts';
import { normalizeText, redactFreeText, sha256Hex } from '../util.ts';
import { isNotFoundText, type LegalLexicon, markerLanguages } from './lexicon.ts';
import { loadLegalLexicon } from './lexicon-file.ts';

const MAX_CHARS = 400_000;
/** Below this length a page without a marker is a soft-404; above it, unconfirmed. */
const MIN_TEXT: Record<DocumentKind, number> = { impressum: 100, privacy: 500 };
/** An explicit error title with less text than this is an error page even if a marker is present. */
const ERROR_PAGE_MAX_TEXT = 3_000;

export type DocumentVerdict = 'ok' | 'soft-404' | 'unconfirmed';

export interface JudgeInput {
  title: string;
  h1: string;
  sections?: readonly string[];
  /** Ignored: the verdict never rests on body text (a word in a footer proves nothing). */
  text?: string;
  textLength: number;
}

// Verdict on a 2xx page fetched as the document `kind`, decided by localised markers (test/data/legal/links.yaml) in
// title, h1 and section headings. `ok`: marker found; `soft-404`: explicit error title, or no marker and no
// recognisable content; `unconfirmed`: a substantive page without a marker (a home page linking to the Impressum, an
// unknown language): neither found nor an error page.
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

// The markers' language decides, not the `lang` attribute (a Portuguese policy with `lang="en"`). German or English
// markers keep a de/en attribute and override another one; foreign markers name their language; without markers the
// attribute stays. PRIV-01 evaluates only de and en.
export function documentLang(attr: string | null, languages: readonly string[]): string | null {
  const a = attr ? attr.toLowerCase() : null;
  const native = languages.filter((l) => l === 'de' || l === 'en');
  if (native.length > 0) {
    if (a && /^(de|en)\b/.test(a)) return a;
    return native.includes('de') ? 'de' : 'en';
  }
  return languages[0] ?? a;
}

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
        // Hidden text stays hidden-irrelevant inside a frame too; the frame itself is recorded in `frameUrl`.
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

/** Everything read from the main document and its same-origin frames. */
interface ReadDocument {
  parts: DocumentPart[];
  /** Headings of navigation or footer prove nothing about the page type; `documentInPage` sorts them into chrome and content. */
  chromeHeads: Set<string>;
  contentHeads: Set<string>;
  // Completeness covers every included part: truncation, unopened expandables and unreadable same-origin frames count
  // like the main document's.
  truncated: boolean;
  expandablesFound: number;
  expandablesWithContent: number;
  framesFound: number;
  framesIncluded: number;
  /** Other-origin http(s) frames: only reported, never read. */
  foreignFrames: number;
  unreadableFrames: number;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function noteHeadingPlaces(read: ReadDocument, places: RawDocument['headingPlaces']): void {
  for (const t of places?.chrome ?? []) read.chromeHeads.add(redactFreeText(normalizeText(t)));
  for (const t of places?.content ?? []) read.contentHeads.add(redactFreeText(normalizeText(t)));
}

async function readParts(
  page: Page,
  c: DocumentContext & { id: string },
  main: RawDocument,
  finalUrl: SanitizedUrl,
  patterns: DocumentPatterns,
): Promise<ReadDocument> {
  const read: ReadDocument = {
    parts: partsOf(main, finalUrl, `${c.id}-p`),
    chromeHeads: new Set(),
    contentHeads: new Set(),
    truncated: main.truncated,
    expandablesFound: main.expandablesFound,
    expandablesWithContent: main.expandablesWithContent,
    framesFound: 0,
    framesIncluded: 0,
    foreignFrames: 0,
    unreadableFrames: 0,
  };
  noteHeadingPlaces(read, main.headingPlaces);

  const pageOrigin = originOf(page.url());
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    read.framesFound++;

    const origin = originOf(frame.url());
    if (origin === null) continue;
    if (origin !== pageOrigin) {
      if (/^https?:/.test(frame.url())) read.foreignFrames++;
      continue;
    }

    const fr = await frame.evaluate(documentInPage, { maxChars: MAX_CHARS, patterns }).catch(() => null);
    if (!fr) {
      read.unreadableFrames++;
      continue;
    }
    read.framesIncluded++;
    noteHeadingPlaces(read, fr.headingPlaces);
    read.truncated ||= fr.truncated;
    read.expandablesFound += fr.expandablesFound;
    read.expandablesWithContent += fr.expandablesWithContent;
    read.parts.push(
      ...partsOf(fr, finalUrl, `${c.id}-f${read.framesIncluded}`, sanitizeRequestUrl(frame.url())),
    );
  }
  return read;
}

function documentErrors(p: {
  kind: DocumentKind;
  status: number | null;
  verdict: DocumentVerdict;
  read: ReadDocument;
  textLength: number;
}): string[] {
  const errors: string[] = [];
  const ok = p.status !== null && p.status >= 200 && p.status < 300;
  if (!ok) errors.push(p.status === null ? 'navigation-failed' : `http-${p.status}`);
  if (ok && p.verdict !== 'ok') errors.push(p.verdict);
  if (p.read.truncated) errors.push('truncated');
  if (p.read.expandablesWithContent < p.read.expandablesFound) errors.push('expand-failed');
  if (p.read.unreadableFrames > 0) errors.push('frame-unreadable');
  if (p.textLength < MIN_TEXT[p.kind]) {
    errors.push(p.read.foreignFrames > 0 ? 'content-in-foreign-frame' : 'too-short');
  }
  return errors;
}

export async function extractDocument(
  page: Page,
  c: DocumentContext & { id: string },
): Promise<DocumentRecord> {
  const finalUrl = sanitizeRequestUrl(page.url());
  if (/application\/pdf/i.test(c.contentType)) return { ...pdfDocument(c), finalUrl };

  const patterns = loadDomPatterns().document;
  const main = await page.evaluate(documentInPage, { maxChars: MAX_CHARS, patterns });
  const read = await readParts(page, c, main, finalUrl, patterns);
  const { parts } = read;

  const fullText = parts.map((p) => p.text).join('\n');
  const textLength = fullText.length;
  const ok = c.status !== null && c.status >= 200 && c.status < 300;
  const judged = judgeDocumentDetail(c.kind, {
    title: main.title,
    // Only an h1 of the content (the reader leaves out navigation, footer and hidden elements).
    h1: main.h1,
    // A text that is a heading in the content as well stays (a footer column "Impressum" next to a real one).
    sections: headingsOf(parts).filter((h) => !read.chromeHeads.has(h) || read.contentHeads.has(h)),
    textLength,
  });
  const errors = documentErrors({
    kind: c.kind,
    status: c.status,
    verdict: judged.verdict,
    read,
    textLength,
  });

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
    // The markers' language decides; `lang` is the fallback.
    lang: documentLang(main.lang || null, ok ? judged.languages : []),
    parts,
    manifest: {
      expandablesFound: read.expandablesFound,
      // Collapsed content is read from the DOM without clicking (counted as opened when present).
      expandablesOpened: read.expandablesWithContent,
      framesIncluded: read.framesIncluded,
      framesFound: read.framesFound,
      linkedPages: 0,
      textLength,
    },
    complete: errors.length === 0,
    errors,
    sha256: textLength > 0 ? sha256Hex(fullText) : null,
  };
}
