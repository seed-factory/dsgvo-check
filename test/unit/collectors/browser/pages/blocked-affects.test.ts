/** Which checks read a page that bot protection blocked, by the page's role (a fallback probe by its path). */
import { describe, expect, it } from 'vitest';
import { blockedAffects } from '../../../../../src/collectors/browser/pages/navigate.ts';
import type { VisitSpec } from '../../../../../src/collectors/browser/pages/visit.ts';

const spec = (over: Partial<VisitSpec>): VisitSpec => ({
  rawUrl: 'https://www.example.test/',
  role: 'other',
  order: 1,
  phase: 'A',
  firstVisit: true,
  ...over,
});

describe('blockedAffects', () => {
  it.each<[string, Partial<VisitSpec>, string[]]>([
    ['impressum', { role: 'impressum' }, ['LEGAL-01']],
    ['legal hop', { role: 'legal-hop' }, ['LEGAL-01']],
    ['privacy', { role: 'privacy' }, ['LEGAL-01', 'PRIV-01']],
    ['contact', { role: 'contact' }, ['EMBED-02']],
    ['start page of phase A', { role: 'start', phase: 'A' }, []],
    ['start page of phase B', { role: 'start', phase: 'B' }, ['CONSENT-04', 'CONSENT-05']],
    ['start page of phase C', { role: 'start', phase: 'C' }, ['CONSENT-04', 'CONSENT-05']],
    ['navigation page', { role: 'nav' }, []],
    ['configured page', { role: 'config' }, []],
    ['other page', { role: 'other' }, []],
    [
      'fallback probe of the privacy path',
      { role: 'fallback', rawUrl: 'https://www.example.test/datenschutz' },
      ['LEGAL-01', 'PRIV-01'],
    ],
    [
      'fallback probe of the impressum path',
      { role: 'fallback', rawUrl: 'https://www.example.test/impressum' },
      ['LEGAL-01'],
    ],
    ['fallback probe of an unparsable URL', { role: 'fallback', rawUrl: 'not a url' }, ['LEGAL-01']],
  ])('%s', (_name, over, affects) => {
    expect(blockedAffects(spec(over))).toEqual(affects);
  });

  it('returns a fresh list, so callers cannot change the table', () => {
    blockedAffects(spec({ role: 'privacy' })).push('X');
    expect(blockedAffects(spec({ role: 'privacy' }))).toEqual(['LEGAL-01', 'PRIV-01']);
  });
});
