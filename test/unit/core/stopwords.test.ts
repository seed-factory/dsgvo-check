/**
 * (wording guide §2): no legal verdicts in user-facing texts, de and en, in every module (data/texts/**) and
 * in the rendered reports. Rule 1 (`block`) plus rules 2, 3, 6, 10 and 13 : no claim about (missing)
 * consent, no "tracker" label, no necessity verdict outside quoted button names, no "missing imprint", no
 * obligations. Rule 3 and 6 are `label` rules: quoted button names („…“, "…") of the site are exempt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTexts } from '../../../src/core/data.ts';
import type { ReporterContext } from '../../../src/core/reporter.ts';
import { renderConsole } from '../../../src/reporters/console.ts';
import { renderHtml } from '../../../src/reporters/html.ts';
import { renderSummary } from '../../../src/reporters/summary.ts';
import { sampleFailedReport, sampleFullReport } from '../../utils/report-fixtures.ts';
import { REPO_ROOT } from '../../utils/snapshot-builder.ts';

/** Rule 1 (`block`). */
const STOP_WORDS = [
  // de
  /verstößt|verstoßen|verstoss|verstoß/i,
  /rechtswidrig/i,
  /unzulässig|unzulaessig/i,
  /dsgvo-konform|dsgvokonform|datenschutzkonform|rechtskonform|gesetzeskonform/i,
  /gesetzwidrig|illegal/i,
  // en
  /\bviolat(es|ed|ion|ing)\b/i,
  /\bunlawful\b/i,
  /\bnon-?compliant\b|\bgdpr-compliant\b/i,
  /\bin breach\b|\bbreaches\b/i,
];

/** Rules 2, 3, 6, 10, 13 of the wording guide §2, with the rule number for the failure message. */
const GUIDE_RULES: Array<[string, RegExp]> = [
  [
    '2',
    /ohne\s+(eine\s+|die\s+)?einwilligung|ohne\s+rechtsgrundlage|einwilligung\s+liegt|einwilligungslos/iu,
  ],
  ['2', /without\s+(a\s+|any\s+)?(consent|legal\s+basis)|no\s+consent\s+(was\s+)?given/i],
  ['3', /\btracker\b|tracking-cookie|spionage|überwachung|schnüffel/iu],
  ['3', /\btrackers?\b|tracking\s+cookies?|spyware|surveillance/i],
  ['6', /unbedingt\s+erforderlich|nicht\s+erforderlich|technisch\s+notwendig|\bnotwendig|essen[sz]i?ell/iu],
  ['6', /strictly\s+necessary|\bnecessary\b|\bessential\b/i],
  [
    '10',
    /impressumspflicht\s+verletzt|fehlende[ns]?\s+impressum|kein\s+impressum|datenschutzerklärung\s+fehlt|dkim\s+fehlt|dmarc\s+fehlt/iu,
  ],
  ['10', /missing\s+imprint|no\s+privacy\s+policy|dkim\s+(is\s+)?missing/i],
  ['13', /sie\s+müssen|sie\s+sind\s+verpflichtet/iu],
  ['13', /you\s+must|you\s+are\s+required\s+to|is\s+mandatory/i],
];

/** Button names of the site in typographic or plain quotes are exempt from the label rules (guide §2, allowlist). */
const unquoted = (s: string) =>
  s
    .replace(/„[^“]*“/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/"[^"]*"/g, '');

/** Every rule hit in `text`, as `rule <n>: <match>`. */
function hits(text: string): string[] {
  const out: string[] = [];
  for (const re of STOP_WORDS) {
    const m = re.exec(text);
    if (m) out.push(`rule 1: ${m[0]}`);
  }
  const free = unquoted(text);
  for (const [n, re] of GUIDE_RULES) {
    const m = re.exec(free);
    if (m) out.push(`rule ${n}: ${m[0]}`);
  }
  return out;
}

function textFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

describe('stop words in data/texts', () => {
  const files = textFiles(path.join(REPO_ROOT, 'data/texts'));

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
      'non-compliant',
    ]) {
      expect(
        STOP_WORDS.some((re) => re.test(s)),
        s,
      ).toBe(true);
    }
    expect(STOP_WORDS.some((re) => re.test('nicht gefunden in der Datenschutzerklärung'))).toBe(false);
  });

  it('the guide rules 2, 3, 6, 10, 13 catch their phrases; quoted button names are exempt', () => {
    for (const [rule, s] of [
      ['2', 'Anfrage ohne Einwilligung'],
      ['2', 'request without consent'],
      ['3', 'Tracker geladen'],
      ['3', 'a tracking cookie was set'],
      ['6', 'Cookie ist technisch notwendig'],
      ['6', 'storage is strictly necessary'],
      ['10', 'kein Impressum'],
      ['10', 'missing imprint'],
      ['13', 'Sie müssen das Banner ändern'],
      ['13', 'you must change the banner'],
    ] as const) {
      expect(hits(s), s).toContain(hits(s).find((h) => h.startsWith(`rule ${rule}:`)));
      expect(hits(s).length, s).toBeGreaterThan(0);
    }
    expect(hits('Schaltfläche „Nur technisch notwendige“ wurde betätigt')).toEqual([]);
    expect(hits('Die Erforderlichkeit wurde nicht bewertet.')).toEqual([]);
    expect(hits('First-party-Endpunkt mit Tracking-Signatur erkannt')).toEqual([]);
  });
});

describe('stop words in rendered reports', () => {
  const ctx = (lang: 'de' | 'en'): ReporterContext => ({
    texts: loadTexts(lang),
    lang,
    outDir: '/nonexistent-out',
    color: false,
  });

  it.each(['de', 'en'] as const)('%s: HTML, console and Job Summary of the sample reports', (lang) => {
    for (const report of [sampleFullReport(), sampleFailedReport()]) {
      for (const render of [renderHtml, renderConsole, renderSummary]) {
        expect(hits(render(report, ctx(lang)))).toEqual([]);
      }
    }
  });
});
