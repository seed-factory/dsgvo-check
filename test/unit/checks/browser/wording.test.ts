/**
 * finding texts of the browser module follow the wording guide docs/legal/wording-guide.md §2 beyond the
 * stop words of rule 1 (test/unit/core/stopwords.test.ts): no claim about (missing) consent (rule 2), no
 * qualification as "tracker"/"Tracking-…" without evidence of purpose (rule 3; only "Tracking-Signatur" in
 * "First-party-Endpunkt mit Tracking-Signatur"), no necessity verdict outside quotes (rule 6), no evaluative terms
 * (rule 7), no "missing imprint" (rule 10), no obligations (rule 13), no statement that consent was given (rule 17).
 * Rendered titles and bodies are checked for every browser variant (legal notes quote statutes and are exempt).
 */
import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../../src/checks/browser/index.ts';
import { loadTexts } from '../../../../src/core/data.ts';

const RULES: Record<'de' | 'en', Array<[string, RegExp]>> = {
  de: [
    [
      '2',
      /ohne\s+(eine\s+|die\s+)?\p{L}*(einwilligung|zustimmung)|ohne\s+rechtsgrundlage|einwilligung\s+liegt|einwilligungslos/iu,
    ],
    ['2', /vor\s+(einer\s+|der\s+)?(einwilligung|zustimmung)\b/iu],
    ['3', /\btracker|tracking-cookie|spionage|überwachung|schnüffel/iu],
    ['3', /tracking-(?!signatur)\p{L}+/iu],
    [
      '6',
      /unbedingt\s+erforderlich|nicht\s+erforderlich|technisch\s+notwendig|\bnotwendig(e[nmrs]?)?\b|essen[sz]i?ell/iu,
    ],
    ['7', /manipulativ|dark\s+pattern|täuschend|irreführend|nudging|versteckt/iu],
    [
      '10',
      /fehlende[ns]?\s+impressum|impressum\s+fehlt|kein\s+impressum|datenschutzerklärung\s+fehlt|keine\s+datenschutzerklärung|impressumspflicht/iu,
    ],
    ['13', /sie\s+müssen|sie\s+sind\s+verpflichtet|\bpflicht\b|\bmuss\b/iu],
    ['17', /einwilligung\s+erteilt|erteilte[nmrs]?\s+einwilligung|zugestimmt|zustimmung\s+erfolgt/iu],
  ],
  en: [
    ['2', /without\s+(a\s+|any\s+)?(\w+\s+)?(consent|legal\s+basis)|no\s+consent\s+(was\s+)?given/i],
    ['2', /before\s+(any\s+)?consent\b/i],
    ['3', /\btrackers?\b|tracking\s+(cookie|identifier|storage|endpoint)s?|spyware|surveillance/i],
    ['6', /strictly\s+necessary|\bnecessary\b|\bessential\b/i],
    ['7', /manipulative|dark\s+pattern|deceptive|misleading|nudging|\bhidden\b/i],
    ['10', /missing\s+(imprint|legal\s+notice|privacy\s+policy)|no\s+privacy\s+policy/i],
    ['13', /you\s+must|you\s+are\s+required|is\s+mandatory/i],
    ['17', /consent\s+(was\s+)?given|user\s+agreed|granted\s+consent/i],
  ],
};

/** Quoted button labels („Nur notwendige“, “…”) may contain otherwise restricted words (rule 6). */
const unquote = (s: string) => s.replace(/„[^“]*“|“[^”]*”|"[^"]*"/g, '""');

describe('browser finding texts follow the wording guide', () => {
  for (const lang of ['de', 'en'] as const) {
    const texts = loadTexts(lang);
    const keys = browserChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
    it.each(keys)(`${lang}: %s`, (key) => {
      const m = texts.messages[key];
      expect(m, `${key} has no ${lang} text`).toBeDefined();
      const text = unquote(`${m?.title ?? ''}\n${m?.body ?? ''}`);
      const hits = RULES[lang].filter(([, re]) => re.test(text)).map(([rule, re]) => `rule ${rule}: ${re}`);
      expect(hits).toEqual([]);
    });
  }
});
