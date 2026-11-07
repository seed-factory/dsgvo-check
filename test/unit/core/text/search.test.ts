/**
 * The word search that the browser collector (consent dialog) and PRIV-01 (privacy policy) share: one search form for
 * text and term, a term found only as whole words, the terms that name a catalog service in their order.
 */
import { describe, expect, it } from 'vitest';
import {
  containsTerm,
  firstTermIn,
  normalizeText,
  serviceNameTerms,
} from '../../../../src/core/text/search.ts';

describe('the search form', () => {
  it('folds like a word search: NFKC, case, umlauts, ß, soft hyphen, combining marks and punctuation', () => {
    expect(normalizeText('Goo\u00ADgle-Analytics, „Übersicht“ Straße')).toBe(
      ' google analytics uebersicht strasse ',
    );
    expect(normalizeText('Google U\u0308bersetzer')).toBe(normalizeText('Google Übersetzer'));
  });
});

describe('a term in a text', () => {
  it.each([
    ['written with hyphens', 'Name Google-Tag-Manager Anbieter', 'Google Tag Manager', true],
    ['with umlauts spelled out', 'Name Google Uebersetzer', 'Google Übersetzer', true],
    ['at the start of a longer name', 'Name Google AdSense Anbieter', 'Google Ads', false],
    ['inside a word', 'Wix-Seiten und Wixelemente', 'Wixel', false],
    ['an empty term', 'Name Google Ads', ' – ', false],
  ])('%s', (_, text, term, found) => {
    expect(containsTerm(normalizeText(text), term)).toBe(found);
  });

  it('the first of the terms in their order, null when none is there', () => {
    const text = normalizeText('Cookie-Details Name Google AdWords Anbieter Google Ireland Limited');
    expect(firstTermIn(text, ['Google Ads', 'Google AdWords', 'Google Ireland Limited'])).toBe(
      'Google AdWords',
    );
    expect(firstTermIn(text, ['Google Ads'])).toBeNull();
  });

  it('a service is named by its name, then its German and English aliases', () => {
    expect(
      serviceNameTerms({ name: 'Google Translate', aliasesDe: ['Google Übersetzer'], aliasesEn: [] }),
    ).toEqual(['Google Translate', 'Google Übersetzer']);
    expect(serviceNameTerms({ name: 'Matomo' })).toEqual(['Matomo']);
  });
});
