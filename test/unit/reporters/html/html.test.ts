import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATA_DIR, loadTexts } from '../../../../src/core/data/load.ts';
import { templateParams } from '../../../../src/core/data/messages.ts';
import { sanitizeExternal } from '../../../../src/core/redaction/sanitize.ts';
import type { ReporterContext } from '../../../../src/core/report/reporter.ts';
import type {
  CmpEvidence,
  DnsEvidence,
  Evidence,
  Finding,
  FullReport,
  RedirectChainEvidence,
} from '../../../../src/core/report/schema.ts';
import { renderHtml } from '../../../../src/reporters/html.ts';
import { buildReportView, findingText } from '../../../../src/reporters/report-view.ts';
import { escapeHtml } from '../../../../src/reporters/template.ts';
import { HOSTILE_TEXT, sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';
import { cspOf, htmlSafetyProblems, tagsOf } from '../../../utils/report/html-safety.ts';
import { reportLabelKeys, usedReportLabelKeys } from './report-label-keys.ts';

const ctx = (lang: 'de' | 'en' = 'de', outDir = '/nonexistent-out'): ReporterContext => {
  const texts = loadTexts(lang);
  // A template with external params, so escaping of params is exercised (browser texts may include external parameters).
  texts.messages['CONSENT-01.tracker-hit'] = {
    title: 'Tracker {service} auf {host} beobachtet',
    body: 'Anfrage an {host} vor einer Einwilligung beobachtet.',
    draft: true,
  };
  return { texts, lang, outDir, color: false };
};

const fp = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

const XSS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg/onload=alert(2)>",
  'javascript:alert(3)',
  '</style><script>alert(4)</script>',
  '<a href="https://evil.example/">x</a>',
  '<!-- comment --><meta http-equiv="refresh" content="0;url=https://evil.example/">',
];
const PAYLOAD = XSS.join(' ');

/** Put hostile strings into every place where external data can appear. */
function hostileReport(): FullReport {
  const r = sampleFullReport();
  r.scan.target = `https://www.example.de/?q=${PAYLOAD}`;
  r.scan.finalUrl = `https://www.example.de/${PAYLOAD}`;
  r.scan.environment.userAgent.browser = `Chrome ${PAYLOAD}`;
  r.scan.environment.egress.source = PAYLOAD;
  r.scan.environment.knownGaps.push(PAYLOAD);
  r.scan.coverage.pages[1]!.url = `https://www.example.de/${PAYLOAD}`;
  r.scan.coverage.pages[1]!.reason = PAYLOAD;
  r.scan.coverage.collectors.http = { status: 'error', reason: PAYLOAD };
  const f = r.findings[0]!;
  f.pages = [`https://www.example.de/${PAYLOAD}`, 'javascript:alert(5)'];
  f.params = { service: PAYLOAD, host: PAYLOAD, count: 2 };
  f.serviceId = `unknown:${PAYLOAD}`;
  f.provider = { name: PAYLOAD, country: 'US' };
  f.trigger = PAYLOAD;
  r.checks[2]!.error = { code: 'check-exception', message: PAYLOAD };
  r.checks[1]!.limitations = [PAYLOAD];
  r.diagnostics[0]!.params = { signal: PAYLOAD };
  for (const ev of r.evidence) {
    const e = ev as Record<string, unknown>;
    for (const key of ['url', 'name', 'key', 'quote', 'href', 'text', 'host', 'subject', 'origin', 'value']) {
      if (typeof e[key] === 'string') e[key] = `${e[key] as string}${PAYLOAD}`;
    }
    if (ev.type === 'cmp') (ev as CmpEvidence).buttons![0]!.name = PAYLOAD;
    if (ev.type === 'dns') (ev as DnsEvidence).records = [PAYLOAD];
    if (ev.type === 'redirect-chain') {
      (ev as RedirectChainEvidence).hops[0]!.location = `https://evil.example/${PAYLOAD}`;
    }
    if (ev.type === 'mixed-content') e.sourceUrl = PAYLOAD;
  }
  f.evidenceIds = r.evidence.map((e) => e.id);
  return r;
}

describe('HTML report: document and CSP', () => {
  it('is a single self-contained document that passes the safety checks', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    expect(htmlSafetyProblems(html)).toEqual([]);
    expect(html).toMatch(/^<!doctype html>\n<html lang="de">/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('declares the offline CSP: no scripts, no network, hashed style block', () => {
    const csp = cspOf(renderHtml(sampleFullReport(), ctx()));
    expect(csp).toMatch(
      /^default-src 'none'; img-src data:; style-src 'sha256-[A-Za-z0-9+/]+=*'; base-uri 'none'; form-action 'none'$/,
    );
  });

  it('loads nothing over the network: no http(s) URL in src/href/link/script', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    for (const tag of tagsOf(html)) {
      expect(['script', 'link', 'iframe', 'object', 'embed', 'form', 'base']).not.toContain(tag.name);
      for (const a of tag.attrs) expect(a.value, tag.raw).not.toMatch(/https?:|\/\//);
    }
    expect(html).not.toMatch(/@import|url\(/);
  });

  it('is deterministic', () => {
    expect(renderHtml(sampleFullReport(), ctx())).toBe(renderHtml(sampleFullReport(), ctx()));
  });
});

describe('HTML report: sections and content', () => {
  it('has all sections (de) with the draft stamp', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    for (const h of ['Zusammenfassung', 'Befunde', 'Diagnose', 'Messumgebung', 'Abdeckung', 'Hinweis']) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${h}</h2>`));
    }
    expect(html).toContain('Textentwurf');
    expect(html).toContain('Keine Rechtsberatung');
  });

  it('uses English labels for --lang en', () => {
    const html = renderHtml(sampleFullReport(), ctx('en'));
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    for (const h of ['Summary', 'Findings', 'Diagnostics', 'Measurement environment', 'Coverage', 'Notice']) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${h}</h2>`));
    }
    expect(html).toContain('Draft text');
  });

  it('summarizes status, exit code, reasons and counts', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    expect(html).toContain('Exit-Code');
    expect(html).toContain('threshold');
    expect(html).toContain('check-error:MAIL-01');
    expect(html).toMatch(/kritisch[\s\S]{0,200}>1</);
  });

  it('shows URLs as text, never as links', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    expect(html).toContain(
      'https://www.google-analytics.com/g/collect?v=2&amp;tid=G-TEST&amp;cid=[redacted]',
    );
    expect(html).toContain('https://www.example.de/');
    const hrefs = tagsOf(html).flatMap((t) => t.attrs.filter((a) => a.name === 'href').map((a) => a.value));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^#/);
  });

  it('renders the diagnostics, the measurement environment and the coverage', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    expect(html).toContain('SCAN-BOTMODE');
    expect(html).toContain('Einwilligungsbanner verhält sich wie gegenüber einem Bot');
    expect(html).toContain('rcb:accept-all-for-bots');
    expect(html).toContain('156.0.8078.4');
    expect(html).toContain('ThirdPartyStoragePartitioning');
    expect(html).toContain('pagehide-beacons');
    expect(html).toContain('nicht festgestellt');
    expect(html).toContain('linux-x64');
    expect(html).toMatch(/geplant 2 · beobachtet 2 · auswertbar 1/);
    expect(html).toContain('challenge');
    expect(html).toContain('banner-not-recognized');
    expect(html).toMatch(/MAIL-01[\s\S]{0,300}Fehler/);
    expect(html).toContain('Datensätze und Attribution');
  });

  it('renders evidence of every known type and unknown types generically', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    const r = sampleFullReport();
    r.findings[0]!.evidenceIds = r.evidence.map((e) => e.id);
    const all = renderHtml(r, ctx());
    expect(html).toContain('_ga');
    for (const t of ['request', 'cookie', 'storage', 'header', 'dns', 'tls', 'cmp', 'consent-state']) {
      expect(all).toContain(`>${t}<`);
    }
    for (const t of ['document', 'text-match', 'page', 'redirect-chain', 'link', 'mixed-content']) {
      expect(all).toContain(`>${t}<`);
    }
    expect(all).toContain('Wir verwenden Google Analytics');
    expect(all).toContain('sourceUrl');
  });

  it('never renders crmCode or other T[0-9]_ strings, even from external data', () => {
    const r = sampleFullReport();
    (r.evidence[1] as { name: string }).name = 'T1_TRACKING_COOKIE';
    r.findings[0]!.params = { service: 'T2_SOMETHING' };
    const html = renderHtml(r, ctx());
    expect(html).not.toMatch(/T[0-9]_/);
    // displayed as "T1_TRACKING_COOKIE", but the literal crm pattern never appears in the file
    expect(html).toContain('T1&#95;TRACKING_COOKIE');
    expect(html).not.toContain('crmCode');
  });

  it('does not render cookie or storage values even if a report carries them', () => {
    const r = sampleFullReport();
    (r.evidence[1] as Record<string, unknown>).value = 'SECRET-COOKIE-VALUE';
    (r.evidence[2] as Record<string, unknown>).value = 'SECRET-STORAGE-VALUE';
    (r.evidence[2] as Record<string, unknown>).valueSha256 = 'SECRET-HASH';
    const html = renderHtml(r, ctx());
    expect(html).not.toContain('SECRET-');
  });

  it('renders the failed report', () => {
    const html = renderHtml(sampleFailedReport(), ctx());
    expect(htmlSafetyProblems(html)).toEqual([]);
    expect(html).toContain('target-nxdomain');
    expect(html).toContain('Zielhost konnte nicht aufgelöst werden.');
    expect(html).toContain('unreachable');
    expect(html).toContain('nicht verfügbar');
    for (const h of ['Zusammenfassung', 'Befunde', 'Diagnose', 'Messumgebung', 'Abdeckung', 'Hinweis']) {
      expect(html).toContain(`>${h}</h2>`);
    }
  });

  it('says that no findings were observed without claiming compliance', () => {
    const r = sampleFullReport();
    r.findings = [];
    const html = renderHtml(r, ctx());
    expect(html).toContain('Keine Befunde beobachtet');
  });

  it('shows the sandbox-off warning', () => {
    const r = sampleFullReport();
    r.scan.environment.sandbox = { mode: 'off', active: false };
    expect(renderHtml(r, ctx())).toContain('--sandbox off');
  });
});

describe('HTML report: grouping by service', () => {
  const finding = (n: number, p: Partial<Finding>): Finding => ({
    ...sampleFullReport().findings[1]!,
    fingerprint: fp(n),
    evidenceIds: [],
    related: [],
    ...p,
  });

  it('groups findings by serviceId, strongest group first, unassigned last', () => {
    const r = sampleFullReport();
    r.findings = [
      finding(10, { checkId: 'CONSENT-04', variant: 'banner-not-recognized', severity: 'info' }),
      finding(11, {
        checkId: 'EMBED-01',
        variant: 'fonts-loaded',
        messageId: 'EMBED-01.fonts-loaded',
        severity: 'warning',
        serviceId: 'google-fonts',
      }),
      finding(12, {
        checkId: 'TRACK-01',
        variant: 'inventory',
        messageId: 'TRACK-01.inventory',
        severity: 'info',
        serviceId: 'google-analytics-4',
      }),
      finding(13, {
        checkId: 'CONSENT-01',
        variant: 'tracker-hit',
        messageId: 'CONSENT-01.tracker-hit',
        severity: 'critical',
        serviceId: 'google-analytics-4',
      }),
    ];
    const html = renderHtml(r, ctx());
    const ga = html.indexOf('Dienst: google-analytics-4');
    const fonts = html.indexOf('Dienst: google-fonts');
    const other = html.indexOf('Ohne Dienstzuordnung');
    expect(ga).toBeGreaterThan(0);
    expect(fonts).toBeGreaterThan(ga);
    expect(other).toBeGreaterThan(fonts);
    // inside the GA group, the critical finding comes first
    const c01 = html.indexOf('CONSENT-01', ga);
    const t01 = html.indexOf('TRACK-01', ga);
    expect(c01).toBeGreaterThan(ga);
    expect(t01).toBeGreaterThan(c01);
    expect(t01).toBeLessThan(fonts);
  });
});

describe('HTML report: contextual escaping (XSS)', () => {
  it('escapes hostile strings everywhere and keeps the document structure intact', () => {
    const html = renderHtml(hostileReport(), ctx());
    expect(htmlSafetyProblems(html)).toEqual([]);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toMatch(/<a href="https/);
    expect(html).not.toMatch(/<!-- comment/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&#39;&gt;&lt;svg/onload=alert(2)&gt;');
    expect(tagsOf(html).filter((t) => t.name === 'style' && !t.closing)).toHaveLength(1);
    expect(tagsOf(html).filter((t) => t.name === 'meta')).toHaveLength(4);
  });

  it('escapes the failed report too', () => {
    const r = sampleFailedReport();
    r.scan.target = PAYLOAD;
    r.scan.failure.message = PAYLOAD;
    const html = renderHtml(r, ctx('en'));
    expect(htmlSafetyProblems(html)).toEqual([]);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('removes ANSI, bidi overrides and control characters from external strings', () => {
    const r = sampleFullReport();
    r.scan.target = HOSTILE_TEXT;
    r.findings[0]!.pages = [HOSTILE_TEXT];
    const html = renderHtml(r, ctx());
    expect(html).not.toContain('\u001b');
    expect(html).not.toContain('‮');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(htmlSafetyProblems(html)).toEqual([]);
  });
});

describe('HTML report: banner screenshots', () => {
  const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
  ]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  function setup(files: Record<string, Buffer>) {
    const outDir = mkdtempSync(path.join(tmpdir(), 'html-out-'));
    mkdirSync(path.join(outDir, 'artifacts'));
    for (const [name, data] of Object.entries(files)) writeFileSync(path.join(outDir, name), data);
    return outDir;
  }

  function withScreenshot(p: string, sha256: string): FullReport {
    const r = sampleFullReport();
    const ev = r.evidence.find((e) => e.type === 'screenshot') as Extract<Evidence, { type: 'screenshot' }>;
    ev.path = p;
    ev.sha256 = sha256;
    return r;
  }

  it('embeds the banner screenshot as a data: URI', () => {
    const outDir = setup({ 'artifacts/banner-B.jpg': JPEG });
    const html = renderHtml(withScreenshot('artifacts/banner-B.jpg', sha(JPEG)), ctx('de', outDir));
    expect(html).toContain(`src="data:image/jpeg;base64,${JPEG.toString('base64')}"`);
    expect(htmlSafetyProblems(html)).toEqual([]);
  });

  it('accepts a sha256: prefix and PNG files', () => {
    const outDir = setup({ 'artifacts/banner-B.png': PNG });
    const html = renderHtml(
      withScreenshot('artifacts/banner-B.png', `sha256:${sha(PNG)}`),
      ctx('de', outDir),
    );
    expect(html).toContain('src="data:image/png;base64,');
  });

  it('does not embed files outside the artifacts directory', () => {
    const outDir = setup({ 'secret.jpg': JPEG });
    const html = renderHtml(withScreenshot('../secret.jpg', sha(JPEG)), ctx('de', path.join(outDir, 'sub')));
    expect(html).not.toContain('data:image');
    const html2 = renderHtml(withScreenshot('secret.jpg', sha(JPEG)), ctx('de', outDir));
    expect(html2).not.toContain('data:image');
    const html3 = renderHtml(withScreenshot('/etc/passwd', sha(JPEG)), ctx('de', outDir));
    expect(html3).not.toContain('data:image');
    expect(html3).toContain('Screenshot nicht eingebettet');
  });

  it('does not follow symlinks out of the artifacts directory', () => {
    const outDir = setup({ 'outside.jpg': JPEG });
    symlinkSync(path.join(outDir, 'outside.jpg'), path.join(outDir, 'artifacts/link.jpg'));
    const html = renderHtml(withScreenshot('artifacts/link.jpg', sha(JPEG)), ctx('de', outDir));
    expect(html).not.toContain('data:image');
  });

  it('does not embed files with a wrong checksum or a non-image content', () => {
    const outDir = setup({ 'artifacts/banner-B.jpg': JPEG, 'artifacts/fake.jpg': Buffer.from('<svg/>') });
    expect(
      renderHtml(withScreenshot('artifacts/banner-B.jpg', 'f'.repeat(64)), ctx('de', outDir)),
    ).not.toContain('data:image');
    const fake = Buffer.from('<svg/>');
    expect(renderHtml(withScreenshot('artifacts/fake.jpg', sha(fake)), ctx('de', outDir))).not.toContain(
      'data:image',
    );
  });

  it('degrades gracefully when the file is missing', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    expect(html).toContain('Screenshot nicht eingebettet');
    expect(html).toContain('artifacts/banner-B.jpg');
  });
});

describe('report labels', () => {
  const STOP = [
    /verstößt|verstoß/i,
    /rechtswidrig/i,
    /unzulässig/i,
    /dsgvo-konform/i,
    /datenschutzkonform/i,
    /rechtskonform/i,
    /illegal/i,
    /violat/i,
    /unlawful/i,
    /non-compliant/i,
    /in breach/i,
  ];

  it('every label key exists in de and en data with the same parameters and no stop words', () => {
    const params = (t: string) => templateParams(t).sort();
    const de = loadTexts('de').ui;
    const en = loadTexts('en').ui;
    const keys = reportLabelKeys(de);
    const usedKeys = usedReportLabelKeys();
    expect(keys, 'de report keys must match the template, view, Summary and CLI/PDF consumers').toEqual(
      usedKeys,
    );
    expect(reportLabelKeys(en), 'en report keys must match the same consumers').toEqual(usedKeys);
    for (const key of keys) {
      const d = de[key]?.text;
      const e = en[key]?.text;
      expect(d, `de ${key}`).toBeTypeOf('string');
      expect(e, `en ${key}`).toBeTypeOf('string');
      expect(params(e as string), key).toEqual(params(d as string));
      for (const re of STOP) {
        expect(d, key).not.toMatch(re);
        expect(e, key).not.toMatch(re);
      }
    }
  });

  it('labels can be overridden from test/data/texts ui keys (report.*)', () => {
    const c = ctx();
    c.texts = {
      ...c.texts,
      ui: { ...c.texts.ui, 'report.section.findings': { text: 'Beobachtungen', draft: true } },
    };
    expect(renderHtml(sampleFullReport(), c)).toContain('>Beobachtungen</h2>');
  });
});

describe('HTML report: template and presentation data', () => {
  it('hashes the style as browsers parse it after a Windows checkout', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'report-template-'));
    mkdirSync(path.join(dataDir, 'report'));
    const source = readFileSync(path.join(DEFAULT_DATA_DIR, 'report', 'report.html'), 'utf8');
    const windowsSource = source.replace('<style>', '<style>\n').replace(/\r?\n/g, '\r\n');
    writeFileSync(path.join(dataDir, 'report', 'report.html'), windowsSource);
    expect(htmlSafetyProblems(renderHtml(sampleFullReport(), { ...ctx(), dataDir }))).toEqual([]);
  });

  it('has no executable markup, raw placeholders or external resources in the template', () => {
    const template = readFileSync(path.join(DEFAULT_DATA_DIR, 'report', 'report.html'), 'utf8');
    expect(template).not.toMatch(/{{[{&=]|<script|\son[a-z]+\s*=|\sstyle\s*=|https?:\/\/|url\s*\(|@import/i);
    const styles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(styles).toHaveLength(1);
    expect(styles[0]![1]).not.toContain('{{');
    expect(styles[0]![1]).toContain('size:A4');
    expect(styles[0]![1]).toContain('details::details-content');
    for (const match of template.matchAll(/{{t "([^"]+)"/g)) {
      for (const lang of ['de', 'en'] as const) expect(loadTexts(lang).ui[match[1]!], match[1]).toBeDefined();
    }
    const withoutDirectives = template
      .replace(/{{[\s\S]*?}}/g, '')
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '');
    expect(withoutDirectives).not.toMatch(/[a-zA-ZÀ-ž]/);
  });

  it('every JSON finding is represented and the view never copies crmCode fields', () => {
    const report = sampleFullReport();
    const context = ctx();
    const view = buildReportView(report, context);
    const keys: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        visit(child);
      }
    };
    visit(view);
    expect(keys).not.toContain('crmCode');
    const html = renderHtml(report, context);
    for (const finding of report.findings) {
      expect(html).toContain(escapeHtml(finding.checkId));
      expect(html).toContain(escapeHtml(sanitizeExternal(findingText(finding, context).title, 300)));
      expect(html).toContain(escapeHtml(sanitizeExternal(findingText(finding, context).body, 4000)));
      expect(html).toContain(escapeHtml(finding.fingerprint));
    }
  });
});
