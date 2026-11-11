/** Measured banner and covered page links use the localized legal-link lexicon. */
import { describe, expect, it } from 'vitest';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import { toMeasured } from '../../../src/cmp/page/measure.ts';
import type { ProbeResult, RawButton } from '../../../src/cmp/page/probe-types.ts';
import { legalLexiconFromData } from '../../../src/collectors/browser/legal/lexicon.ts';
import { BUTTON_BOX, rawButton, rawProbe } from './fakes.ts';

const PAGE = 'https://www.example.test/';

const link = (name: string, href: string | null = '/seite', over: Partial<RawButton> = {}) =>
  rawButton({ role: 'link', tag: 'a', name, href, ...over });

const covered = (label: string, coveredBy: 'banner' | 'overlay' = 'banner') => ({
  label,
  box: BUTTON_BOX,
  coveredBy,
});

function probe(p: { buttons?: RawButton[]; covered?: string[] } = {}): ProbeResult {
  return rawProbe({
    found: true,
    containerCount: 1,
    visible: true,
    containerBox: { x: 0, y: 648, width: 1366, height: 120 },
    containerFixed: true,
    textLength: 80,
    buttons: p.buttons ?? [],
    blocking: { ...rawProbe().blocking, coveredRatio: 0.2 },
    coveredLinks: (p.covered ?? []).map((l) => covered(l)),
  });
}

const lexicon = loadLexicon();
const measure = (p: Parameters<typeof probe>[0]) => toMeasured(probe(p), lexicon, PAGE).firstLayer;

describe('toMeasured: covered links are judged by the lexicon of test/data/legal', () => {
  it('who covers is kept: the overlay as well as the banner', () => {
    const raw = probe();
    raw.coveredLinks = [covered('Impressum', 'overlay')];
    expect(toMeasured(raw, lexicon, PAGE).firstLayer.coveredFooterLinks).toEqual([
      covered('Impressum', 'overlay'),
    ]);
  });

  it('keeps the order of the page and reports at most five', () => {
    const names = [
      'Impressum',
      'Produkte',
      'Datenschutz',
      'Mentions légales',
      'Aviso legal',
      'Imprint',
      'Privacy',
      'Colofon',
    ];
    const layer = measure({ covered: names });
    expect(layer.coveredFooterLinks?.map((l) => l.label)).toEqual([
      'Impressum',
      'Datenschutz',
      'Mentions légales',
      'Aviso legal',
      'Imprint',
    ]);
  });

  it('the covered links come from the measurement that saw the banner (the page around a consent frame)', () => {
    const inner = probe({ buttons: [link('Politique de confidentialité')] });
    const outer = probe({ covered: ['Mentions légales'] });
    const layer = toMeasured(inner, lexicon, PAGE, { blockingFrom: outer }).firstLayer;
    expect(layer.coveredFooterLinks?.map((l) => l.label)).toEqual(['Mentions légales']);
    expect(layer.legalLinks?.map((l) => l.text)).toEqual(['Politique de confidentialité']);
  });

  it('the words come from the lexicon that is used: a lexicon with one invented label knows only that', () => {
    const own = legalLexiconFromData({
      version: 'test',
      fallbackPaths: { impressum: '/impressum', privacy: '/datenschutz' },
      kinds: {
        impressum: { languages: { xx: { labels: ['Zzquux'] } } },
        privacy: { languages: {} },
      },
      navigation: { contact: [], hop: [] },
      notFound: [],
    });
    const layer = toMeasured(probe({ covered: ['Impressum', 'Zzquux'] }), lexicon, PAGE, {
      legal: own,
    }).firstLayer;
    expect(layer.coveredFooterLinks?.map((l) => l.label)).toEqual(['Zzquux']);
  });
});

describe('toMeasured: legal links of the banner are judged by the lexicon of test/data/legal', () => {
  it('a French privacy link is listed with its sanitized absolute address', () => {
    const layer = measure({
      buttons: [link('Politique de confidentialité', '/confidentialite?session=abc123')],
    });
    expect(layer.legalLinks).toEqual([
      {
        text: 'Politique de confidentialité',
        href: 'https://www.example.test/confidentialite?session=[redacted]',
      },
    ]);
  });

  it('a button with a legal label is not a legal link', () => {
    const layer = measure({
      buttons: [link('Datenschutzerklärung', null, { role: 'button', tag: 'button' })],
    });
    expect(layer.legalLinks).toEqual([]);
  });
});
