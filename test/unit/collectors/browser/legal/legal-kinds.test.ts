/**
 * Which legal documents phase A reads a page for, whatever its role: a legal page the kinds it is queued for (a combined
 * page keeps the role of its first kind), the contact page and intermediate pages the documents neither found nor queued
 * yet, whose links they may hold and whose Impressum they may be. A block of such a page takes those documents from the
 * checks that read them (blocked-affects.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { PageQueue, type QueueItem } from '../../../../../src/collectors/browser/legal/queue.ts';
import type { LegalKind, PageChoice } from '../../../../../src/collectors/browser/pages/pages.ts';
import type { PageRole } from '../../../../../src/core/snapshot/browser.ts';
import type { SanitizedUrl } from '../../../../../src/core/snapshot/common.ts';

const ORIGIN = 'https://www.example.test';
const choice = (path: string, role: PageRole): PageChoice => ({
  raw: `${ORIGIN}${path}`,
  url: `${ORIGIN}${path}` as SanitizedUrl,
  role,
  reasons: [],
  source: 'link',
});
const CONTACT: QueueItem = { choice: choice('/kontakt/', 'contact') };
const HOP: QueueItem = { choice: choice('/ueber-uns/', 'legal-hop'), hop: true };
const IMPRESSUM: QueueItem = { choice: choice('/impressum/', 'impressum'), docKind: 'impressum' };

function queue(o: { found?: LegalKind[]; queued?: QueueItem[] } = {}): PageQueue {
  const q = new PageQueue(
    new Set(),
    { documents: [], attempts: [] },
    { startRaw: `${ORIGIN}/`, finalHost: 'www.example.test', etld1: 'example.test' },
  );
  for (const k of o.found ?? []) q.found[k] = true;
  q.items.push(...(o.queued ?? []));
  return q;
}

describe('PageQueue.legalKindsOf', () => {
  it.each<[string, QueueItem]>([
    ['contact page', CONTACT],
    ['intermediate page', HOP],
  ])('the %s is read for every legal document neither found nor queued', (_name, item) => {
    expect(queue().legalKindsOf(item)).toEqual(['impressum', 'privacy']);
    expect(queue({ found: ['impressum'] }).legalKindsOf(item)).toEqual(['privacy']);
    expect(queue({ queued: [IMPRESSUM] }).legalKindsOf(item)).toEqual(['privacy']);
    const combined: QueueItem = { ...IMPRESSUM, alsoKinds: ['privacy'] };
    expect(queue({ queued: [combined] }).legalKindsOf(item)).toEqual([]);
    expect(queue({ found: ['impressum', 'privacy'] }).legalKindsOf(item)).toEqual([]);
  });

  it.each<[string, QueueItem, LegalKind[]]>([
    ['the Impressum page', IMPRESSUM, ['impressum']],
    [
      'a privacy page that is also read as the Impressum',
      { choice: choice('/rechtliches/', 'privacy'), docKind: 'privacy', alsoKinds: ['impressum'] },
      ['impressum', 'privacy'],
    ],
    [
      'an Impressum page that is also read as the privacy policy',
      { ...IMPRESSUM, alsoKinds: ['privacy'] },
      ['impressum', 'privacy'],
    ],
  ])('%s is read for the kinds it is queued for, found or not', (_name, item, kinds) => {
    expect(queue({ found: ['impressum', 'privacy'] }).legalKindsOf(item)).toEqual(kinds);
  });

  it.each<[string, QueueItem]>([
    ['an extra page', { choice: choice('/team/', 'nav'), extra: true }],
    [
      'a further privacy notice',
      { choice: choice('/datenschutz-kurse/', 'privacy'), docKind: 'privacy', supplement: true },
    ],
  ])('counterexample: %s is read for no legal document, even with both missing', (_name, item) => {
    expect(queue().legalKindsOf(item)).toEqual([]);
  });
});
