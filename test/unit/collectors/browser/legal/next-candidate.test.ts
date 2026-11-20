/**
 * The next candidate after a legal page that was not confirmed as the document: the next link of the same kind on the
 * same page, but never another language version of the policy after a page of the start page's language; that one is
 * noted without a navigation, as beside a policy that was found.
 */
import { describe, expect, it } from 'vitest';
import { PageQueue } from '../../../../../src/collectors/browser/legal/queue.ts';
import type { CandidateLink } from '../../../../../src/collectors/browser/pages/pages.ts';
import type { DocumentsSection } from '../../../../../src/core/snapshot/browser.ts';
import { link, plan, scope as site, u } from '../../../../utils/candidate-links.ts';

const scope = { ...site, startRaw: u('/de/') };

/** The queue after the policy link of `links` was taken from it, as phase A takes it to visit. */
function afterFirstPolicy(links: CandidateLink[]) {
  const sel = plan(links, { ...scope, startLang: 'de' });
  const documents: DocumentsSection = { documents: [], attempts: [] };
  const queue = new PageQueue(new Set([u('/de/')]), documents, scope, { language: sel.language, max: 1 });
  queue.handleLink(sel.privacy, 'link', null, links);
  const item = queue.items.shift();
  if (!item) throw new Error('no policy queued');
  return { queue, documents, item };
}

describe('PageQueue.tryNextCandidate', () => {
  it('after an unconfirmed policy page of the start language, an English version is noted, not visited', () => {
    const { queue, documents, item } = afterFirstPolicy([
      link({ raw: u('/de/impressum/'), text: 'Impressum' }),
      link({ raw: u('/de/datenschutz/'), text: 'Datenschutz' }),
      link({ raw: u('/en/privacy/'), text: 'Privacy Policy', hreflang: 'en' }),
    ]);
    expect(item.choice.url).toBe(u('/de/datenschutz/'));

    queue.tryNextCandidate(item);
    expect(queue.items.map((q) => q.choice.url)).not.toContain(u('/en/privacy/'));
    expect(documents.attempts).toEqual([
      {
        kind: 'privacy',
        via: 'link',
        url: u('/en/privacy/'),
        status: null,
        outcome: 'other-language',
        supplement: true,
      },
    ]);
  });

  it('counterexample: a further link of the start language is visited as the next candidate', () => {
    const { queue, documents, item } = afterFirstPolicy([
      link({ raw: u('/de/datenschutz/'), text: 'Datenschutz' }),
      link({ raw: u('/de/datenschutzerklaerung/'), text: 'Datenschutzhinweise' }),
    ]);
    queue.tryNextCandidate(item);
    expect(queue.items.map((q) => [q.choice.url, q.docKind, q.choice.reasons.at(-1)])).toEqual([
      [u('/de/datenschutzerklaerung/'), 'privacy', 'next-candidate'],
    ]);
    expect(documents.attempts).toEqual([]);
  });
});
