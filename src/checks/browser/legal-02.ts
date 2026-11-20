/**
 * LEGAL-02 (P2): designations of a former legal situation in the Impressum and the privacy policy, such as "§ 5 TMG"
 * or "unter dem EU-US Privacy Shield zertifiziert". The designations, their successors and the cues of a historical
 * sentence come from test/data/legal/outdated-references.yaml. Only the wording is observed: a sentence that calls the
 * designation former ("vormals") or names its successor in the same breath is not counted, and whether a mention
 * matters is not judged.
 */
import { normalizeLegalText, pageKey } from '../../collectors/browser/legal/lexicon.ts';
import {
  compileTerm,
  containsPhrase,
  type OutdatedReferences,
  outdatedReferencesSection,
  phraseAt,
  type TermPhrase,
} from '../../collectors/browser/legal/sections.ts';
import { defineCheck, type EvidenceInput, type Observation } from '../../core/api.ts';
import type {
  DocumentKind,
  DocumentPart,
  DocumentRecord,
  DocumentsSection,
} from '../../core/snapshot/browser.ts';
import { isSupplement, usableDocument } from './documents.ts';
import { QUOTE_MAX_CHARS, splitSentences } from './policy-claims.ts';

const ID = 'LEGAL-02';
const KINDS: readonly DocumentKind[] = ['impressum', 'privacy'];
/** Quotes per observation; the mention count covers every sentence. */
const MAX_QUOTES = 3;
/** Languages the historical cues are written in; another language could mark a sentence historical unseen. */
const CUE_LANGUAGE = /^(de|en)\b/i;

interface Reference {
  data: OutdatedReferences['references'][number];
  terms: TermPhrase[];
  successors: TermPhrase[];
}

interface Dictionary {
  references: Reference[];
  cues: TermPhrase[];
  abbreviations: ReadonlySet<string>;
}

const cache = new WeakMap<object, Dictionary>();

/** The compiled dictionary of the merged `ctx.data.legal`, validated once per object. */
function dictionaryOf(legal: unknown): Dictionary {
  const key = legal !== null && typeof legal === 'object' ? legal : null;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;
  const data = outdatedReferencesSection.parse(legal);
  const dict: Dictionary = {
    references: data.references.map((r) => ({
      data: r,
      terms: r.terms.map(compileTerm),
      successors: r.successors.map(compileTerm),
    })),
    cues: [...data.historicalCues.de, ...data.historicalCues.en].map(compileTerm),
    abbreviations: new Set([...data.abbreviations.de, ...data.abbreviations.en]),
  };
  if (key) cache.set(key, dict);
  return dict;
}

/** A word of a sentence with where it stands in the sentence, so a quote can be cut around it. */
interface Word {
  w: string;
  start: number;
  end: number;
}

/** The words of a sentence, normalised like the terms; a raw word may give several (NFKC "½" → "1 2"). */
function wordsOf(sentence: string): Word[] {
  const out: Word[] = [];
  for (const m of sentence.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const norm = normalizeLegalText(m[0]);
    if (norm === '') continue;
    for (const w of norm.split(' ')) out.push({ w, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The first match of one of the terms: its span in the sentence. */
function firstMatch(
  words: readonly Word[],
  terms: readonly TermPhrase[],
): { start: number; end: number } | null {
  const plain = words.map((x) => x.w);
  for (let i = 0; i < plain.length; i++) {
    for (const t of terms) {
      if (!phraseAt(plain, t, i)) continue;
      const last = words[i + t.words.length - 1] as Word;
      return { start: (words[i] as Word).start, end: last.end };
    }
  }
  return null;
}

/** The sentence, or a part of at most QUOTE_MAX_CHARS around the match, cut at spaces and marked with "…". */
function quoteAround(sentence: string, start: number, end: number): string {
  if (sentence.length <= QUOTE_MAX_CHARS) return sentence;
  const room = QUOTE_MAX_CHARS - 2;
  let from = Math.max(0, Math.min(start - Math.floor((room - (end - start)) / 2), sentence.length - room));
  let to = Math.min(sentence.length, from + room);
  if (from > 0) {
    const space = sentence.indexOf(' ', from);
    if (space >= 0 && space < start) from = space + 1;
  }
  if (to < sentence.length) {
    const space = sentence.lastIndexOf(' ', to);
    if (space > end) to = space;
  }
  return `${from > 0 ? '…' : ''}${sentence.slice(from, to).trim()}${to < sentence.length ? '…' : ''}`;
}

/** One sentence that uses a designation without marking it as former. */
interface Mention {
  part: DocumentPart;
  sentence: string;
  start: number;
  end: number;
}

/** The documents of one page: a combined legal page is fetched once and read for both kinds. */
interface Page {
  doc: DocumentRecord;
  kind: DocumentKind | 'combined';
}

/** A sentence of the page as the matcher reads it; `historical` when it holds a cue of the former situation. */
interface Sentence {
  part: DocumentPart;
  text: string;
  words: Word[];
  plain: string[];
  historical: boolean;
}

/** The sentences of the parts the page shows; a template it does not show is no text of the page. */
function sentencesOf(doc: DocumentRecord, dict: Dictionary): Sentence[] {
  const out: Sentence[] = [];
  for (const part of doc.parts) {
    if (part.origin === 'hidden-irrelevant') continue;
    for (const text of splitSentences(part.text, dict.abbreviations, { legalStarts: true })) {
      const words = wordsOf(text);
      const plain = words.map((x) => x.w);
      out.push({ part, text, words, plain, historical: dict.cues.some((c) => containsPhrase(plain, c)) });
    }
  }
  return out;
}

/** The sentences that use the reference; one with a historical cue or a successor of it does not. */
function mentionsOf(sentences: readonly Sentence[], ref: Reference): Mention[] {
  const out: Mention[] = [];
  for (const s of sentences) {
    if (s.historical) continue;
    const at = firstMatch(s.words, ref.terms);
    if (!at || ref.successors.some((p) => containsPhrase(s.plain, p))) continue;
    out.push({ part: s.part, sentence: s.text, ...at });
  }
  return out;
}

const documentEvidence = (doc: DocumentRecord, mentions: readonly Mention[]): EvidenceInput => {
  const parts = new Map<string, { origin: string; section?: string }>();
  for (const { part } of mentions) {
    const p = { origin: part.origin, ...(part.section ? { section: part.section } : {}) };
    parts.set(JSON.stringify(p), p);
  }
  return {
    type: 'document',
    url: doc.finalUrl || doc.url,
    kind: doc.kind,
    lang: doc.lang,
    parts: [...parts.values()],
    complete: doc.complete,
    errors: doc.errors,
    phase: doc.phase,
    ...(doc.sha256 ? { sha256: doc.sha256 } : {}),
  };
};

function observationOf(page: Page, ref: Reference, mentions: readonly Mention[]): Observation {
  const { doc, kind } = page;
  const url = doc.finalUrl || doc.url;
  const first = mentions[0] as Mention;
  const quoted = new Set<string>();
  const quotes: EvidenceInput[] = [];
  for (const m of mentions) {
    if (quotes.length >= MAX_QUOTES || quoted.has(m.sentence)) continue;
    quoted.add(m.sentence);
    quotes.push({
      type: 'text-match',
      documentId: doc.id,
      section: m.part.section ?? null,
      quote: quoteAround(m.sentence, m.start, m.end),
      matchLevel: 'term',
    });
  }
  const r = ref.data;
  return {
    checkId: ID,
    variant: 'outdated-reference',
    confidence: 'medium',
    subject: `${kind}:${r.id}`,
    phases: [doc.phase],
    pages: [url],
    evidence: [documentEvidence(doc, mentions), ...quotes],
    params: {
      documentKind: kind,
      documentUrl: url,
      referenceId: r.id,
      reference: r.label,
      reason: r.reason,
      replacedBy: r.replacedBy,
      since: r.since,
      ruling: r.ruling,
      section: first.part.section ?? null,
      hasSection: first.part.section !== undefined && first.part.section !== '',
      mentionCount: mentions.length,
    },
  };
}

type Attempts = DocumentsSection['attempts'];

/** HTML in a language the cues are written in (or none stated): text the search can read. */
const searchable = (d: DocumentRecord): boolean =>
  d.format === 'html' && (!d.lang || CUE_LANGUAGE.test(d.lang));

/**
 * The documents of one kind to search, or why there is none: not found (or judged no document), only a PDF or another
 * format, a language the cues do not cover. A document cut off or with unopened parts is searched and noted.
 */
function documentsOfKind(
  docs: readonly DocumentRecord[],
  attempts: Attempts,
  kind: DocumentKind,
): { docs: DocumentRecord[]; limitation: string | null } {
  const usable = docs.filter((d) => usableDocument(d, attempts));
  if (usable.length === 0) return { docs: [], limitation: `${kind}-not-found` };
  const html = usable.filter((d) => d.format === 'html');
  if (html.length === 0) {
    const pdf = usable.some((d) => d.format === 'pdf');
    return { docs: [], limitation: `${kind}-${pdf ? 'pdf' : 'unsupported-format'}` };
  }
  const known = html.filter(searchable);
  if (known.length === 0) return { docs: [], limitation: `${kind}-language-unsupported` };
  return { docs: known, limitation: known.some((d) => !d.complete) ? `${kind}-incomplete` : null };
}

/**
 * The further privacy notices of the site to search, as PRIV-01 reads them: one that is no searchable HTML, one cut
 * off, one whose fetch failed and a language version only noted are `supplement-not-evaluated`. A link that led to an
 * error page or to a page not confirmed as a notice holds no notice text. A notice never stands in for the policy.
 */
function noticesToSearch(documents: DocumentsSection): { docs: DocumentRecord[]; unread: boolean } {
  const notices = documents.documents.filter(
    (d) => d.kind === 'privacy' && isSupplement(d) && usableDocument(d, documents.attempts),
  );
  const docs = notices.filter(searchable);
  const failed = documents.attempts.some(
    (a) =>
      a.kind === 'privacy' &&
      a.supplement === true &&
      (a.outcome === 'error' || a.outcome === 'other-language'),
  );
  return { docs, unread: failed || docs.length < notices.length || docs.some((d) => !d.complete) };
}

/** The pages to search, Impressum first; a page read for both kinds is one page. Supplements come last. */
function pagesToSearch(documents: DocumentsSection): { pages: Page[]; limitations: string[] } {
  const limitations: string[] = [];
  const found: DocumentRecord[] = [];
  for (const kind of KINDS) {
    const own = documents.documents.filter((d) => d.kind === kind && !isSupplement(d));
    const r = documentsOfKind(own, documents.attempts, kind);
    if (r.limitation) limitations.push(r.limitation);
    found.push(...r.docs);
  }
  const notices = noticesToSearch(documents);
  if (notices.unread) limitations.push('supplement-not-evaluated');
  found.push(...notices.docs);

  // One page read for both kinds has the same URL and the same text. Pages whose URLs differ only in a redacted query
  // (`index.php?page=[redacted]`) share the stored URL, not the text.
  const byPage = new Map<string, Page>();
  for (const doc of found) {
    const key = JSON.stringify([pageKey(doc.finalUrl || doc.url), doc.parts.map((p) => [p.origin, p.text])]);
    const seen = byPage.get(key);
    if (!seen) byPage.set(key, { doc, kind: doc.kind });
    else if (seen.kind !== doc.kind) seen.kind = 'combined';
  }
  return { pages: [...byPage.values()], limitations };
}

export const legal02 = defineCheck({
  id: ID,
  module: 'browser',
  requires: ['documents'],
  data: ['legal'],
  variants: [{ variant: 'outdated-reference', maxConfidence: 'medium' }],
  run({ documents }, ctx) {
    const dict = dictionaryOf(ctx.data.legal);
    const { pages, limitations } = pagesToSearch(documents);
    if (pages.length === 0)
      return { status: 'inconclusive', reason: 'no-documents', observations: [], limitations };

    // A change that lies after the scan date is no former situation yet.
    const today = ctx.now.toISOString().slice(0, 10);
    const references = dict.references.filter((r) => r.data.since <= today);

    const observations: Observation[] = [];
    for (const page of pages) {
      const sentences = sentencesOf(page.doc, dict);
      for (const ref of references) {
        const mentions = mentionsOf(sentences, ref);
        if (mentions.length > 0) observations.push(observationOf(page, ref, mentions));
      }
    }
    return { status: limitations.length > 0 ? 'partial' : 'completed', observations, limitations };
  },
});
