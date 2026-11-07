/**
 * No legal verdicts in user-facing texts: de and en texts of every module and the rendered reports. Stop words are
 * blocked everywhere; the label rules (consent claims, "tracker" labels, necessity verdicts, absence claims such as
 * "missing imprint" or "DMARC fehlt", obligations) exempt quoted button names („…“, "…") of the site.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { renderConsole } from '../../../../src/reporters/console.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { renderSummary } from '../../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';
import { reporterContext } from '../../../utils/report/reporter-inputs.ts';
import { REPO_ROOT } from '../../../utils/snapshot-builder.ts';

/** Verdict wording that is blocked everywhere. */
const STOP_WORDS = [
  // de
  /verstößt|verstoßen|verstoss|verstoß/i,
  /rechtswidrig/i,
  /unzulässig|unzulaessig/i,
  /dsgvo-konform|dsgvokonform|datenschutzkonform|rechtskonform|gesetzeskonform/i,
  /gesetzwidrig|illegal/i,
  // en: every form of the word, "violate" and "unlawfully" included
  /violat/i,
  /unlawful/i,
  /non-?compliant|\bgdpr-compliant\b/i,
  /in breach|\bbreaches\b/i,
];

/** Phrases that state a consent, necessity, absence or obligation verdict, with a label for the failure message. */
const LABEL_RULES: Array<[string, RegExp]> = [
  [
    'consent claim',
    /ohne\s+(eine\s+|die\s+)?einwilligung|ohne\s+rechtsgrundlage|einwilligung\s+liegt|einwilligungslos/iu,
  ],
  ['consent claim', /without\s+(a\s+|any\s+)?(consent|legal\s+basis)|no\s+consent\s+(was\s+)?given/i],
  ['tracker label', /\btracker\b|tracking-cookie|spionage|überwachung|schnüffel/iu],
  ['tracker label', /\btrackers?\b|tracking\s+cookies?|spyware|surveillance/i],
  [
    'necessity verdict',
    /unbedingt\s+erforderlich|nicht\s+erforderlich|technisch\s+notwendig|\bnotwendig|essen[sz]i?ell/iu,
  ],
  ['necessity verdict', /strictly\s+necessary|\bnecessary\b|\bessential\b/i],
  [
    'absence claim',
    /impressumspflicht\s+verletzt|fehlende[ns]?\s+impressum|kein\s+impressum|datenschutzerklärung\s+fehlt|dkim\s+fehlt|dmarc\s+fehlt/iu,
  ],
  ['absence claim', /missing\s+imprint|no\s+privacy\s+policy|dkim\s+(is\s+)?missing/i],
  ['obligation', /sie\s+müssen|sie\s+sind\s+verpflichtet/iu],
  ['obligation', /you\s+must|you\s+are\s+required\s+to|is\s+mandatory/i],
];

/** Button names of the site in typographic or plain quotes are exempt from the label rules: they are quoted, not claimed. */
const unquoted = (s: string) =>
  s
    .replace(/„[^“]*“/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/"[^"]*"/g, '');

/** Every rule hit in `text`, as `<label>: <match>`. */
function hits(text: string): string[] {
  const out: string[] = [];
  for (const re of STOP_WORDS) {
    const m = re.exec(text);
    if (m) out.push(`stop word: ${m[0]}`);
  }
  const free = unquoted(text);
  for (const [label, re] of LABEL_RULES) {
    const m = re.exec(free);
    if (m) out.push(`${label}: ${m[0]}`);
  }
  return out;
}

function textFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

describe('stop words in test/data/texts', () => {
  const files = textFiles(path.join(REPO_ROOT, 'test/data/texts'));

  it('finds the text files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(REPO_ROOT, f), f]))('%s has no stop words', (_rel, file) => {
    // Comment lines are ignored; a folded YAML value is checked as one text, so a phrase across lines is caught.
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(hits(text)).toEqual([]);
  });

  it('the matcher catches forbidden words', () => {
    for (const s of [
      'Die Website verstößt gegen',
      'rechtswidrig',
      'nicht DSGVO-konform',
      'violates GDPR',
      'may violate the GDPR',
      'processed unlawfully',
      'non-compliant',
    ]) {
      expect(
        STOP_WORDS.some((re) => re.test(s)),
        s,
      ).toBe(true);
    }
    expect(STOP_WORDS.some((re) => re.test('nicht gefunden in der Datenschutzerklärung'))).toBe(false);
  });

  it('the label rules catch their phrases; quoted button names are exempt', () => {
    for (const [label, s] of [
      ['consent claim', 'Anfrage ohne Einwilligung'],
      ['consent claim', 'request without consent'],
      ['tracker label', 'Tracker geladen'],
      ['tracker label', 'a tracking cookie was set'],
      ['necessity verdict', 'Cookie ist technisch notwendig'],
      ['necessity verdict', 'storage is strictly necessary'],
      ['absence claim', 'kein Impressum'],
      ['absence claim', 'missing imprint'],
      ['obligation', 'Sie müssen das Banner ändern'],
      ['obligation', 'you must change the banner'],
    ] as const) {
      expect(hits(s), s).toContain(hits(s).find((h) => h.startsWith(`${label}:`)));
      expect(hits(s).length, s).toBeGreaterThan(0);
    }
    expect(hits('Schaltfläche „Nur technisch notwendige“ wurde betätigt')).toEqual([]);
    expect(hits('Die Erforderlichkeit wurde nicht bewertet.')).toEqual([]);
    expect(hits('First-party-Endpunkt mit Tracking-Signatur erkannt')).toEqual([]);
  });
});

/** Every string of the parsed texts with its key path. */
function leaves(v: unknown, key = ''): Array<[string, string]> {
  if (typeof v === 'string') return [[key, v]];
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => leaves(x, key ? `${key}.${k}` : k));
}

describe('stop words in the parsed texts', () => {
  // The raw scan above reads the YAML source: a stop word written as an escape sequence, or a block-scalar
  // line that starts with "#", only shows up in the parsed value that the reports render.
  it.each(['de', 'en'] as const)('%s: messages, legal notes, labels and actions', (lang) => {
    const found = leaves(loadTexts(lang)).flatMap(([key, s]) => hits(s).map((h) => `${key}: ${h}`));
    expect(found).toEqual([]);
  });
});

describe('stop words in rendered reports', () => {
  it.each(['de', 'en'] as const)('%s: HTML, console and Job Summary of the sample reports', (lang) => {
    for (const report of [sampleFullReport(), sampleFailedReport()]) {
      for (const render of [renderHtml, renderConsole, renderSummary]) {
        expect(hits(render(report, reporterContext(lang)))).toEqual([]);
      }
    }
  });
});
