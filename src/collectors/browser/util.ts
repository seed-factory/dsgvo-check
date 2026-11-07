import { createHash } from 'node:crypto';
import { redactText } from '../../core/redaction/redact.ts';
import { REQUEST_QUERY_ALLOWLIST } from './config.ts';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** The underlying promise keeps running; callers must tolerate that. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** NFC + whitespace collapse; case and umlauts stay. */
export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Redaction of free text before it is stored, hashed or used as evidence: addresses lose their local part, URLs get the
// collector's query allowlist, matrix parameters and addresses in paths are masked. Use it for every string copied from
// a page. Idempotent.
export function redactFreeText(s: string): string {
  return redactText(s, REQUEST_QUERY_ALLOWLIST);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Exception texts are cut here before they enter the snapshot. */
export const ERROR_MESSAGE_MAX_CHARS = 300;

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Failures of Playwright and the browser a call into the page can meet, by the fixed text they are reported with. */
const PAGE_CALL_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Timeout \d+ ?ms exceeded/i, 'timed out'],
  [/Execution context was destroyed/i, 'execution context destroyed'],
  [/Target page, context or browser has been closed|Target closed|page closed/i, 'page closed'],
  [/frame (?:was|got) detached/i, 'frame detached'],
];

/**
 * The kind of a failed call into the page (CMP adapters, the cookie and storage reads), never the error's own text:
 * an error the page throws there may carry its data, a consent ID or a cookie or storage value, which must not reach
 * the snapshot or the logs.
 */
export function pageCallFailure(err: unknown): string {
  if (err instanceof TimeoutError) return err.message;
  const text = errorText(err);
  return PAGE_CALL_FAILURES.find(([re]) => re.test(text))?.[1] ?? 'evaluation failed';
}

/** The prefix Playwright gives the errors of its calls into the page or its handles. */
const PAGE_API_ERROR = /^(?:page|frame|locator|elementHandle|jsHandle|worker)\.[A-Za-z$]+:/;

/**
 * An exception that ended a phase: the kind of failure when it came from a call into the page (see pageCallFailure),
 * else the first line of the scanner's own error, which carries no page data and is what debugging needs.
 */
export function phaseFailure(err: unknown): string {
  const text = errorText(err);
  if (!(err instanceof Error) || err instanceof TimeoutError || PAGE_API_ERROR.test(text))
    return pageCallFailure(err);
  return text.split('\n')[0] ?? '';
}
