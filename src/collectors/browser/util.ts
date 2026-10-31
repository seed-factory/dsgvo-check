/** Small async helpers for the browser collector. */
import { createHash } from 'node:crypto';
import { redactText } from '../../core/redact.ts';
import { REQUEST_QUERY_ALLOWLIST } from './config.ts';

/** Sleep that resolves early (without throwing) when the signal aborts. */
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

/** Reject after `ms` (the underlying promise keeps running; callers must tolerate that). */
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

/** NFC + whitespace collapse (documents keep case and umlauts; matching normalization is done by derive/checks). */
export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Redaction of free text before it is stored, hashed or used for evidence (D20): e-mail addresses and `mailto:` values
 * lose their local part, URLs in the text get the query allowlist of the collector, matrix parameters and addresses
 * in their path are masked. Use it for every string copied from a page (link text, accessible names, titles,
 * document parts). Idempotent.
 */
export function redactFreeText(s: string): string {
  return redactText(s, REQUEST_QUERY_ALLOWLIST);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
