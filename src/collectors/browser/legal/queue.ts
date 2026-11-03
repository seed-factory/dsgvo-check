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
      this.tried[lr.kind].add(pageKey(lr.choice.raw));
      if (this.visited.has(pageKey(lr.choice.raw))) return;
      const queued = this.items.find((q) => pageKey(q.choice.raw) === pageKey(lr.choice!.raw));
      if (queued) {
        // The same page behind the links of two kinds: it stays one navigation, the other kind is read from it too.
        if (queued.docKind && queued.docKind !== lr.kind && !queued.alsoKinds?.includes(lr.kind)) {
          queued.alsoKinds = [...(queued.alsoKinds ?? []), lr.kind];
        }
        return;
      }
      const choice: PageChoice =
        via === 'hop'
          ? { ...lr.choice, source: 'hop', reasons: [...lr.choice.reasons, `via:${from}`] }
          : lr.choice;
      const item: QueueItem = { choice, docKind: lr.kind, foundVia: via, pool };
      if (via === 'hop') this.items.unshift(item);
      else this.items.push(item);
    } else if (lr.status === 'pdf' && lr.choice) {
      this.found[lr.kind] = true;
      this.documents.documents.push(
        pdfDocument({
          id: `doc-${lr.kind}-${this.documents.documents.length + 1}`,
          kind: lr.kind,
          phase: 'A',
          url: lr.choice.url,
          foundVia: via,
          status: null,
        }),
      );
      this.documents.attempts.push({
        kind: lr.kind,
        via,
        url: lr.choice.url,
        status: null,
        outcome: 'found',
      });
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
    const queued = this.items.findIndex((q) => pageKey(q.choice.raw) === key);
    if (queued >= 0) {
      const q = this.items[queued] as QueueItem;
      if (q.docKind) {
        // Already queued as a candidate: it stays where it is and is read for this kind too (a combined page behind two
        // links); taking it out would lose that document.
        this.tried[kind].add(key);
        if (q.docKind !== kind && !q.alsoKinds?.includes(kind)) q.alsoKinds = [...(q.alsoKinds ?? []), kind];
        return;
      }
      // The page is already queued as a plain page (e.g. a navigation link): it becomes the candidate, next in line.
      this.items.splice(queued, 1);
      this.tried[kind].add(key);
      this.candidateRetries++;
      this.items.unshift({ ...q, choice, docKind: kind, foundVia: via, pool: item.pool });
      return;
    }
    this.candidateRetries++;
    this.handleLink({ ...next, choice }, via, item.choice.role, item.pool);
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
    const code = navigationErrorCode(r.error);
    if (code === 'download') {
      c.documents.documents.push(
        pdfDocument({
          id: `doc-${kind}-${c.documents.documents.length + 1}`,
          kind,
          phase: 'A',
          url,
          foundVia: via,
          status: null,
        }),
      );
      c.documents.attempts.push({ kind, via: attemptVia, url, status: null, outcome: 'found' });
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
  let doc: DocumentRecord;
  try {
    // A page that does not answer must not hold the phase: the read is bounded like every other in-page call.
    doc = await withTimeout(
      extractDocument(s.page, {
        id: `doc-${kind}-${c.documents.documents.length + 1}`,
        kind,
        phase: 'A',
        url,
        foundVia: via,
        status,
        contentType: r.contentType,
      }),
      c.deps.timing.cmpCallTimeoutMs,
      'document extraction',
    );
  } catch (err) {
    s.record.errors.push({
      code: 'document-extract-failed',
      message: errorText(err).slice(0, 300),
      phase: 'A',
      url,
    });
    c.documents.attempts.push({ kind, via: attemptVia, url, status, outcome: 'error' });
    return 'no';
  }
  // `keyword-missing` is the older code for the same state as `unconfirmed`.
  const soft404 = doc.errors.includes('soft-404');
  const unconfirmed =
    !soft404 && (doc.errors.includes('unconfirmed') || doc.errors.includes('keyword-missing'));
  // A fallback hit that is not the document (e.g. a CMS 200 page) is not recorded as a document.
  if (!((soft404 || unconfirmed) && via === 'fallback')) c.documents.documents.push(doc);
  c.documents.attempts.push({
    kind,
    via: attemptVia,
    url,
    status,
    outcome: soft404 ? 'soft-404' : unconfirmed ? 'unconfirmed' : 'found',
  });
  return soft404 ? 'no' : unconfirmed ? 'unconfirmed' : 'found';
}

/** At most 20 linking pages per document. */
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
    doc.linkedFrom = from.slice(0, 20);
  }
}
