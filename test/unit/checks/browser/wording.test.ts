/**
 * Beyond the stop words, finding texts of the browser module only describe what was observed: no claims about
 * consent, "tracker" labels, necessity verdicts, evaluative terms, "missing imprint" or obligations. Legal notes are
 * exempt.
 */
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';

/** Phrase patterns per language, each with a label for the failure message. */
const RULES: Record<'de' | 'en', Array<[string, RegExp]>> = {
  de: [
    [
      'consent claim',
      /ohne\s+(eine\s+|die\s+)?\p{L}*(einwilligung|zustimmung)|ohne\s+rechtsgrundlage|einwilligung\s+liegt|einwilligungslos/iu,
    ],
    ['consent claim', /vor\s+(einer\s+|der\s+)?(einwilligung|zustimmung)\b/iu],
    ['tracker label', /\btracker|tracking-cookie|spionage|überwachung|schnüffel/iu],
    ['tracker label', /tracking-(?!signatur)\p{L}+/iu],
    [
      'necessity verdict',
      /unbedingt\s+erforderlich|nicht\s+erforderlich|technisch\s+notwendig|\bnotwendig(e[nmrs]?)?\b|essen[sz]i?ell/iu,
    ],
    ['evaluative term', /manipulativ|dark\s+pattern|täuschend|irreführend|nudging|versteckt/iu],
    [
      'missing imprint',
      /fehlende[ns]?\s+impressum|impressum\s+fehlt|kein\s+impressum|datenschutzerklärung\s+fehlt|keine\s+datenschutzerklärung|impressumspflicht/iu,
    ],
    ['obligation', /sie\s+müssen|sie\s+sind\s+verpflichtet|\bpflicht\b|\bmuss\b/iu],
    [
      'consent state',
      /einwilligung\s+erteilt|erteilte[nmrs]?\s+einwilligung|zugestimmt|zustimmung\s+erfolgt/iu,
    ],
  ],
  en: [
    [
      'consent claim',
      /without\s+(a\s+|any\s+)?(\w+\s+)?(consent|legal\s+basis)|no\s+consent\s+(was\s+)?given/i,
    ],
    ['consent claim', /before\s+(any\s+)?consent\b/i],
    [
      'tracker label',
      /\btrackers?\b|tracking\s+(cookie|identifier|storage|endpoint)s?|spyware|surveillance/i,
    ],
    ['necessity verdict', /strictly\s+necessary|\bnecessary\b|\bessential\b/i],
    ['evaluative term', /manipulative|dark\s+pattern|deceptive|misleading|nudging|\bhidden\b/i],
    ['missing imprint', /missing\s+(imprint|legal\s+notice|privacy\s+policy)|no\s+privacy\s+policy/i],
    ['obligation', /you\s+must|you\s+are\s+required|is\s+mandatory/i],
    ['consent state', /consent\s+(was\s+)?given|user\s+agreed|granted\s+consent/i],
  ],
};

/** Quoted button labels („Nur notwendige“, “…”) may contain otherwise restricted words. */
const unquote = (s: string) => s.replace(/„[^“]*“|“[^”]*”|"[^"]*"/g, '""');

describe('browser finding texts only describe observations', () => {
  for (const lang of ['de', 'en'] as const) {
    const texts = loadTexts(lang);
    const keys = browserChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
    it.each(keys)(`${lang}: %s`, (key) => {
      const m = texts.messages[key];
      expect(m, `${key} has no ${lang} text`).toBeDefined();
      const text = unquote(`${m?.title ?? ''}\n${m?.body ?? ''}`);
      const hits = RULES[lang].filter(([, re]) => re.test(text)).map(([label, re]) => `${label}: ${re}`);
      expect(hits).toEqual([]);
    });
  }
});
