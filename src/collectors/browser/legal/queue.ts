/** Legal documents of phase A: the queue of pages behind the legal links and the record of what each page held. */
import {
  type DocumentRecord,
  type DocumentsSection,
  isHttpHref,
  type PhaseRecord,
} from '../../../core/snapshot/browser.ts';
import type { SanitizedUrl } from '../../../core/snapshot/common.ts';
import type { BrowserCollection, Session } from '../collector.ts';
import { THROTTLE_STATUSES } from '../pages/navigate.ts';
import {
  type CandidateLink,
  findLegalLink,
  type LegalKind,
  type LegalLinkResult,
  type PageChoice,
  pageKey,
} from '../pages/pages.ts';
import { navigationErrorCode, type VisitResult } from '../pages/visit.ts';
import { sanitizeRequestUrl } from '../recording/features.ts';
import { errorText, withTimeout } from '../util.ts';
import { extractDocument, pdfDocument } from './documents.ts';

/** Per scan: pages tried after a legal link led to a page of the wrong type (≤ 3 GET). */
const MAX_CANDIDATE_RETRIES = 3;
/** Linking pages kept per document. */
const MAX_LINKING_PAGES = 20;

type Attempt = DocumentsSection['attempts'][number];
type DocumentOutcome = Extract<Attempt['outcome'], 'found' | 'unconfirmed' | 'soft-404'>;

/** What the caller learns about a fetched page; a soft-404 is "no" for the caller, the attempt keeps the detail. */
const RESULT_BY_OUTCOME = { found: 'found', unconfirmed: 'unconfirmed', 'soft-404': 'no' } as const;

export interface QueueItem {
  choice: PageChoice;
  docKind?: LegalKind;
  /** Other kinds whose links lead to this page (a combined legal page): fetched once, read per kind. */
  alsoKinds?: LegalKind[];
  foundVia?: DocumentRecord['foundVia'];
  extra?: boolean;
  hop?: boolean;
  pool?: readonly CandidateLink[];
}

interface Scope {
  startRaw: string;
  finalHost: string;
  etld1: string | null;
}

/** A page behind the links of two kinds stays one navigation; the other kind is read from it too. */
function addAlsoKind(queued: QueueItem, kind: LegalKind): void {
  if (queued.docKind && queued.docKind !== kind && !queued.alsoKinds?.includes(kind)) {
    queued.alsoKinds = [...(queued.alsoKinds ?? []), kind];
  }
}

/** A PDF found as a document: recorded without a navigation, no text is read. */
function recordPdf(
  documents: DocumentsSection,
  pdf: {
    kind: LegalKind;
    url: SanitizedUrl;
    foundVia: DocumentRecord['foundVia'];
    attemptVia: Attempt['via'];
  },
): void {
  documents.documents.push(
    pdfDocument({
      id: `doc-${pdf.kind}-${documents.documents.length + 1}`,
      kind: pdf.kind,
      phase: 'A',
      url: pdf.url,
      foundVia: pdf.foundVia,
      status: null,
    }),
  );
  documents.attempts.push({
    kind: pdf.kind,
    via: pdf.attemptVia,
    url: pdf.url,
    status: null,
    outcome: 'found',
  });
}

export class PageQueue {
  readonly items: QueueItem[] = [];
  readonly found: Record<LegalKind, boolean> = { impressum: false, privacy: false };
  private readonly tried: Record<LegalKind, Set<string>> = { impressum: new Set(), privacy: new Set() };
  private candidateRetries = 0;
  private readonly visited: Set<string>;
  private readonly documents: DocumentsSection;
  private readonly scope: Scope;

  constructor(visited: Set<string>, documents: DocumentsSection, scope: Scope) {
    this.visited = visited;
    this.documents = documents;
    this.scope = scope;
  }

  pending(k: LegalKind): boolean {
    return this.items.some((q) => q.docKind === k || q.alsoKinds?.includes(k));
  }

  handleLink(
    lr: LegalLinkResult,
    via: 'link' | 'hop',
    from: string | null,
    pool: readonly CandidateLink[],
  ): void {
    if (lr.status === 'page' && lr.choice) {
      this.queuePage(lr.kind, lr.choice, via, from, pool);
    } else if (lr.status === 'pdf' && lr.choice) {
      this.found[lr.kind] = true;
      recordPdf(this.documents, { kind: lr.kind, url: lr.choice.url, foundVia: via, attemptVia: via });
    } else if ((lr.status === 'unresolved' || lr.status === 'offsite') && lr.link && via === 'link') {
      this.documents.attempts.push({
        kind: lr.kind,
        via,
        url: isHttpHref(lr.link.hrefKind)
          ? sanitizeRequestUrl(lr.link.raw)
          : sanitizeRequestUrl(this.scope.startRaw),
        status: null,
        outcome: 'unresolved',
      });
    }
  }

  private queuePage(
    kind: LegalKind,
    found: PageChoice,
    via: 'link' | 'hop',
    from: string | null,
    pool: readonly CandidateLink[],
  ): void {
    const key = pageKey(found.raw);
    this.tried[kind].add(key);
    if (this.visited.has(key)) return;

    const queued = this.items.find((q) => pageKey(q.choice.raw) === key);
    if (queued) {
      addAlsoKind(queued, kind);
      return;
    }

    const choice: PageChoice =
      via === 'hop' ? { ...found, source: 'hop', reasons: [...found.reasons, `via:${from}`] } : found;
    const item: QueueItem = { choice, docKind: kind, foundVia: via, pool };
    if (via === 'hop') this.items.unshift(item);
    else this.items.push(item);
  }

  // The page behind a legal link is substantive but not of the expected type: the next best link of the same page is
  // tried, within `MAX_CANDIDATE_RETRIES` extra GETs.
  tryNextCandidate(item: QueueItem): void {
    const kind = item.docKind;
    if (!kind || !item.pool || this.candidateRetries >= MAX_CANDIDATE_RETRIES) return;

    const rest = item.pool.filter((l) => !this.tried[kind].has(pageKey(l.raw)));
    const next = findLegalLink(rest, kind, this.scope);
    if (next.status !== 'page' || !next.choice) return;
    const key = pageKey(next.choice.raw);
    if (this.visited.has(key)) return;

    const choice: PageChoice = { ...next.choice, reasons: [...next.choice.reasons, 'next-candidate'] };
    const via = item.foundVia === 'hop' ? 'hop' : 'link';
    const queuedAt = this.items.findIndex((q) => pageKey(q.choice.raw) === key);
    if (queuedAt < 0) {
      this.candidateRetries++;
      this.handleLink({ ...next, choice }, via, item.choice.role, item.pool);
      return;
    }

    const q = this.items[queuedAt] as QueueItem;
    if (q.docKind) {
      // Already queued as a candidate: it stays where it is and is read for this kind too (a combined page behind two
      // links); taking it out would lose that document.
      this.tried[kind].add(key);
      addAlsoKind(q, kind);
      return;
    }

    // The page is already queued as a plain page (e.g. a navigation link): it becomes the candidate, next in line.
    this.items.splice(queuedAt, 1);
    this.tried[kind].add(key);
    this.candidateRetries++;
    this.items.unshift({ ...q, choice, docKind: kind, foundVia: via, pool: item.pool });
  }
}

// `found`: expected type; `unconfirmed`: a substantive page whose type could not be confirmed (neither found nor
// soft-404: the caller may try the next candidate, LEGAL-01 reports a limitation); `no`: nothing usable.
export async function recordDocument(
  c: BrowserCollection,
  s: Session,
  r: VisitResult,
  kind: LegalKind,
  url: SanitizedUrl,
  via: DocumentRecord['foundVia'],
): Promise<'found' | 'unconfirmed' | 'no'> {
  const attemptVia = via === 'config' ? 'link' : via;
  const status = r.visit.navigation.status;

  if (r.error) {
    if (navigationErrorCode(r.error) === 'download') {
      recordPdf(c.documents, { kind, url, foundVia: via, attemptVia });
      return 'found';
    }
    c.documents.attempts.push({ kind, via: attemptVia, url, status: null, outcome: 'error' });
    return 'no';
  }

  if (status !== null && status >= 400) {
    // 429/503: the server refused to answer now — that proves nothing about the document (no false links-broken).
    const outcome = THROTTLE_STATUSES.has(status) ? 'error' : 'not-found';
    c.documents.attempts.push({ kind, via: attemptVia, url, status, outcome });
    return 'no';
  }

  const doc = await extractBounded(c, s, r, { kind, url, via, status });
  if (!doc) {
    c.documents.attempts.push({ kind, via: attemptVia, url, status, outcome: 'error' });
    return 'no';
  }

  const outcome = outcomeOf(doc);
  // A fallback hit that is not the document (e.g. a CMS 200 page) is not recorded as a document.
  if (outcome === 'found' || via !== 'fallback') c.documents.documents.push(doc);
  c.documents.attempts.push({ kind, via: attemptVia, url, status, outcome });
  return RESULT_BY_OUTCOME[outcome];
}

/** Reads the document of the current page; null (and an error entry in the phase record) when the read fails. */
async function extractBounded(
  c: BrowserCollection,
  s: Session,
  r: VisitResult,
  page: { kind: LegalKind; url: SanitizedUrl; via: DocumentRecord['foundVia']; status: number | null },
): Promise<DocumentRecord | null> {
  try {
    // A page that does not answer must not hold the phase: the read is bounded like every other in-page call.
    return await withTimeout(
      extractDocument(s.page, {
        id: `doc-${page.kind}-${c.documents.documents.length + 1}`,
        kind: page.kind,
        phase: 'A',
        url: page.url,
        foundVia: page.via,
        status: page.status,
        contentType: r.contentType,
      }),
      c.timing.cmpCallTimeoutMs,
      'document extraction',
    );
  } catch (err) {
    s.record.errors.push({
      code: 'document-extract-failed',
      message: errorText(err).slice(0, 300),
      phase: 'A',
      url: page.url,
    });
    return null;
  }
}

function outcomeOf(doc: DocumentRecord): DocumentOutcome {
  if (doc.errors.includes('soft-404')) return 'soft-404';
  // `keyword-missing` is the older code for the same state as `unconfirmed`.
  if (doc.errors.includes('unconfirmed') || doc.errors.includes('keyword-missing')) return 'unconfirmed';
  return 'found';
}

export function linkDocuments(phases: readonly PhaseRecord[], documents: DocumentsSection): void {
  const visits = phases.flatMap((p) => p.pages);
  for (const doc of documents.documents) {
    const key = pageKey(doc.url);
    const from: Array<{ pageUrl: SanitizedUrl; text: string }> = [];
    for (const v of visits) {
      for (const l of v.dom?.links ?? []) {
        if (!l.href || pageKey(l.href) !== key) continue;
        if (from.some((f) => f.pageUrl === v.url && f.text === l.text)) continue;
        from.push({ pageUrl: v.url, text: l.text || l.accessibleName || '' });
      }
    }
    doc.linkedFrom = from.slice(0, MAX_LINKING_PAGES);
  }
}
