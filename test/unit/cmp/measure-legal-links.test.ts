/**
 * L1 (review S-cmp-2, canary2 group G18): `toMeasured` picks the legal links of the banner and the covered legal
 * links of the page with the lexicon of data/legal. The in-page probe holds no legal wording and reports every
 * covered link and every link of the banner; a label counts when the collector's own matcher accepts it, so every
 * label and key of the lexicon file is honoured without a second word list.
 */
import { describe, expect, it } from 'vitest';
import { loadLexicon } from '../../../src/cmp/lexicon-file.ts';
import { toMeasured } from '../../../src/cmp/page/measure.ts';
import type { ProbeResult, RawButton } from '../../../src/cmp/page/probe.ts';
import { legalLexiconFromData } from '../../../src/collectors/browser/legal-lexicon.ts';
import { loadDataDir } from '../../../src/core/data.ts';

const BOX = { x: 10, y: 700, width: 120, height: 20 };
const PAGE = 'https://www.example.test/';

const link = (name: string, href: string | null = '/seite', p: Partial<RawButton> = {}): RawButton => ({
  role: 'link',
  name,
  tag: 'a',
  vendorRole: null,
  box: BOX,
  rendered: true,
  visibleInViewport: true,
  inViewport: true,
  enabled: true,
  hitTestOk: true,
  actionable: true,
  contrast: 7,
  fontSizePx: 14,
  selector: null,
  inShadowDom: false,
  href,
  ...p,
});

const covered = (label: string, coveredBy: 'banner' | 'overlay' = 'banner') => ({
  label,
  box: BOX,
  coveredBy,
});

function probe(p: { buttons?: RawButton[]; covered?: string[] } = {}): ProbeResult {
  return {
    found: true,
    containerCount: 1,
    visible: true,
    containerBox: { x: 0, y: 648, width: 1366, height: 120 },
    containerFixed: true,
    containerSelector: null,
    textLength: 80,
    purAbo: false,
    keywordHits: [],
    buttons: p.buttons ?? [],
    buttonsTruncated: false,
    animating: false,
    blocking: {
      overlay: false,
      scrollLock: false,
      inert: false,
      coveredRatio: 0.2,
      method: [],
      ariaModal: false,
    },
    viewport: { width: 1366, height: 768 },
    coveredLinks: (p.covered ?? []).map((l) => covered(l)),
    heuristic: null,
  };
}

const lexicon = loadLexicon();
const measure = (p: Parameters<typeof probe>[0]) => toMeasured(probe(p), lexicon, PAGE).firstLayer;

/** Every label, key and bare topic word that data/legal/links.yaml lists for the Impressum and the privacy policy. */
function lexiconPhrases(): Array<{ kind: string; lang: string; role: string; phrase: string }> {
  const raw = loadDataDir('legal') as {
    legal: {
      kinds: Record<string, { languages: Record<string, Record<string, string[] | undefined>> }>;
    };
  };
  const out: Array<{ kind: string; lang: string; role: string; phrase: string }> = [];
  for (const [kind, spec] of Object.entries(raw.legal.kinds)) {
    for (const [lang, entry] of Object.entries(spec.languages)) {
      for (const role of ['labels', 'keys', 'generic'] as const) {
        for (const phrase of entry[role] ?? []) out.push({ kind, lang, role, phrase });
      }
    }
  }
  return out;
}

describe('toMeasured: covered links are judged by the lexicon of data/legal (S-cmp-2)', () => {
  it('the lexicon file lists phrases of many languages (the scenario is real)', () => {
    const langs = new Set(lexiconPhrases().map((p) => p.lang));
    expect(langs.has('fr') && langs.has('es') && langs.has('pl')).toBe(true);
  });

  it('every label, key and topic word of the lexicon file is a covered legal link', () => {
    const missed = lexiconPhrases().filter(
      (p) => !measure({ covered: [p.phrase] }).coveredFooterLinks?.some((l) => l.label === p.phrase),
    );
    expect(missed).toEqual([]);
  });

  it('French names are covered legal links, with box and who covers them', () => {
    const layer = measure({ covered: ['Mentions légales', 'Politique de confidentialité'] });
    expect(layer.coversFooter).toBe(true);
    expect(layer.coveredFooterLinks).toEqual([
      covered('Mentions légales'),
      covered('Politique de confidentialité'),
    ]);
  });

  it('who covers is kept: the overlay as well as the banner', () => {
    const raw = probe();
    raw.coveredLinks = [covered('Impressum', 'overlay')];
    expect(toMeasured(raw, lexicon, PAGE).firstLayer.coveredFooterLinks?.[0]?.coveredBy).toBe('overlay');
  });

  it('counterexample: links that name no legal document are dropped, so nothing is covered', () => {
    const layer = measure({ covered: ['Nos produits', 'Nous contacter', 'Startseite', 'Alle akzeptieren'] });
    expect(layer.coversFooter).toBe(false);
    expect(layer.coveredFooterLinks).toEqual([]);
  });

  it('counterexample: a link to a settings dialog is no document link, in any language', () => {
    const layer = measure({
      covered: [
        'Datenschutz-Einstellungen',
        'Privacy settings',
        'Paramètres de confidentialité',
        'Cookie-Einstellungen',
      ],
    });
    expect(layer.coversFooter).toBe(false);
    expect(layer.coveredFooterLinks).toEqual([]);
  });

  it('counterexample: German and English names are still covered legal links', () => {
    const layer = measure({
      covered: ['Impressum', 'Datenschutzerklärung', 'Privacy Policy', 'Legal Notice'],
    });
    expect(layer.coveredFooterLinks?.map((l) => l.label)).toEqual([
      'Impressum',
      'Datenschutzerklärung',
      'Privacy Policy',
      'Legal Notice',
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

describe('toMeasured: legal links of the banner are judged by the lexicon of data/legal (S-cmp-2)', () => {
  it('every label and key of the lexicon file is a legal link of the banner', () => {
    const missed = lexiconPhrases().filter(
      (p) => !measure({ buttons: [link(p.phrase)] }).legalLinks?.some((l) => l.text === p.phrase),
    );
    expect(missed).toEqual([]);
  });

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

  it('counterexample: links that name no document and controls that are no links are not listed', () => {
    const layer = measure({
      buttons: [
        link('En savoir plus sur notre société'),
        link('Paramètres de confidentialité', '#parametres'),
        link('Alle akzeptieren', null),
        link('Datenschutzerklärung', null, { role: 'button', tag: 'button' }),
      ],
    });
    expect(layer.legalLinks).toEqual([]);
  });

  it('counterexample: German and English links of the banner are still listed', () => {
    const layer = measure({
      buttons: [link('Datenschutzerklärung', '/datenschutz'), link('Imprint', '/imprint')],
    });
    expect(layer.legalLinks?.map((l) => l.text)).toEqual(['Datenschutzerklärung', 'Imprint']);
  });
});
