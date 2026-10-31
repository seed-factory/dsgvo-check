/**
 * Pure: findings S-legal-4 of the independent review (G24). A false friend ("cookie", "settings") in the href path of a
 * link switches the path match off only when the path carries no primary key of the document: `privacy-policy-and-cookies`
 * is the privacy policy, `cookie-settings` is not. The label branch already worked like this (`primary`).
 */
import { describe, expect, it } from 'vitest';
import { legal01 } from '../../../../src/checks/browser/legal-01.ts';
import { matchLegalLink } from '../../../../src/collectors/browser/legal-lexicon.ts';
import { loadLegalLexicon } from '../../../../src/collectors/browser/legal-lexicon-file.ts';
import { type CandidateLink, findLegalLink } from '../../../../src/collectors/browser/pages.ts';
import {
  defaultDocuments,
  IMPRESSUM,
  ORIGIN,
  page,
  phase,
  START as SITE_START,
  site,
} from '../../../unit/checks/browser/helpers.ts';
import { makeLink, observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';

const lex = loadLegalLexicon();
const START = 'https://www.example.test/';
const scope = { startRaw: START, finalHost: 'www.example.test', etld1: 'example.test' };
let n = 0;
const link = (p: Partial<CandidateLink> & { raw: string; text: string }): CandidateLink => ({
  hrefKind: p.raw.startsWith('https:') ? 'https' : 'http',
  region: 'footer',
  visible: true,
  order: n++,
  ...p,
});
const u = (path: string) => `https://www.example.test${path}`;
const privacy = (text: string, path: string) => matchLegalLink(lex, 'privacy', { text, path });

describe('S-legal-4: a false friend in the path does not hide a primary privacy key', () => {
  it.each([
    ['a neutral label', 'More'],
    ['an icon without a label', ''],
  ])('%s + /privacy-policy-and-cookies: the policy, by the href slug', (_, text) => {
    expect(privacy(text, '/privacy-policy-and-cookies')).toMatchObject({
      tier: 3,
      byText: false,
      slug: true,
    });
  });

  it('the same link as a path-only candidate is a page for the collector (findLegalLink)', () => {
    const r = findLegalLink(
      [link({ raw: u('/privacy-policy-and-cookies'), text: 'More' })],
      'privacy',
      scope,
    );
    expect(r.status).toBe('page');
    expect(r.choice?.raw).toBe(u('/privacy-policy-and-cookies'));
  });

  it('German path with a primary key and a false friend: /datenschutzerklaerung-und-cookies', () => {
    expect(privacy('Mehr', '/datenschutzerklaerung-und-cookies')).toMatchObject({ tier: 3, byText: false });
  });

  it('control: the full label "Privacy Policy and Cookies" on the same path is still decided by the text', () => {
    expect(privacy('Privacy Policy and Cookies', '/privacy-policy-and-cookies')).toMatchObject({
      tier: 1,
      byText: true,
    });
  });

  it('control: the path without the false friend is unchanged (/privacy-policy → tier 3)', () => {
    expect(privacy('More', '/privacy-policy')).toMatchObject({ tier: 3, byText: false });
  });

  it.each([
    ['/cookie-settings'],
    ['/cookie-einstellungen'],
    ['/privacy-settings'],
    ['/datenschutz-einstellungen'],
    ['/datenschutz-und-cookie-einstellungen'],
  ])('counterexample: %s stays no privacy link (no primary key, only a generic word)', (path) => {
    expect(privacy('More', path)).toBeNull();
    expect(privacy('', path)).toBeNull();
    expect(findLegalLink([link({ raw: u(path), text: 'More' })], 'privacy', scope).status).toBe('none');
  });

  it('counterexample: a settings link is no privacy link in the other direction either', () => {
    expect(
      matchLegalLink(lex, 'impressum', { text: 'More', path: '/privacy-policy-and-cookies' }),
    ).toBeNull();
  });
});

describe('S-legal-4: LEGAL-01 reads the same link', () => {
  /** The Impressum is found, the policy is not; the only candidate for it is the link "More". */
  const run = (path: string) => {
    const links = [
      makeLink({ text: 'Impressum', href: IMPRESSUM, hrefKind: 'https', sameSite: true }),
      makeLink({ text: 'More', href: `${ORIGIN}${path}`, hrefKind: 'https', sameSite: true }),
    ];
    return runCheck(
      legal01,
      site({
        phases: [
          phase('A', {
            pages: [page(SITE_START, 'start', 'A', {}, links), page(IMPRESSUM, 'impressum', 'A', {}, links)],
          }),
        ],
        documents: {
          documents: defaultDocuments().documents.filter((d) => d.kind === 'impressum'),
          attempts: [],
        },
      }),
    );
  };
  const privacy = (r: ReturnType<typeof run>) => observationsOf(r).filter((o) => o.subject === 'privacy');

  it('"More" → /privacy-policy-and-cookies is a link to the policy: unresolved, not "no link at all"', () => {
    const r = run('/privacy-policy-and-cookies');
    expect(privacy(r).map((o) => o.variant)).toEqual(['unresolved']);
    expect(r.outcome?.limitations ?? []).not.toContain('privacy-search-incomplete:fallback-skipped');
  });

  it('counterexample: "More" → /cookie-settings is no link to the policy', () => {
    const r = run('/cookie-settings');
    expect(privacy(r)).toEqual([]);
    expect(r.outcome?.limitations).toContain('privacy-search-incomplete:fallback-skipped');
  });
});
