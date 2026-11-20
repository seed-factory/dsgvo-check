import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reporterLimits } from '../../../../src/core/config/limits.ts';
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
import { findingText } from '../../../../src/reporters/report-view.ts';
import { escapeHtml } from '../../../../src/reporters/template.ts';
import { HOSTILE_TEXT, sampleFailedReport, sampleFullReport } from '../../../utils/report/fixtures.ts';
import { cspOf, htmlSafetyProblems, tagsOf } from '../../../utils/report/html-safety.ts';
import { reporterContext, withTrackerHitMessage } from '../../../utils/report/reporter-inputs.ts';
import { findingOf } from './front-page-fixtures.ts';
import { reportLabelKeys, usedReportLabelKeys } from './report-label-keys.ts';

const ctx = (lang: 'de' | 'en' = 'de', outDir = '/nonexistent-out'): ReporterContext =>
  withTrackerHitMessage(reporterContext(lang, { outDir }));

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
    expect(html.trimEnd()).toMatch(/<\/html>$/);
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
  const headings = {
    de: ['Zusammenfassung', 'Befunde', 'Diagnose', 'Messumgebung', 'Abdeckung', 'Hinweise zum Bericht'],
    en: ['Summary', 'Findings', 'Diagnostics', 'Measurement environment', 'Coverage', 'Notes on this report'],
  };

  it.each([
    ['has all sections (de) with the draft stamp', 'de', ['Textentwurf', 'keine Rechtsberatung']],
    ['uses English labels for --lang en', 'en', ['Draft text']],
  ] as const)('%s', (_label, lang, text) => {
    const html = renderHtml(sampleFullReport(), ctx(lang));
    if (lang === 'en') expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    for (const h of headings[lang]) expect(html).toMatch(new RegExp(`<h2[^>]*>${h}</h2>`));
    for (const t of text) expect(html).toContain(t);
  });

  it('summarizes status, exit code, reasons and counts', () => {
    const html = renderHtml(sampleFullReport(), ctx());

    expect(html).toContain('Exit-Code');
    expect(html).toContain('Befunde ab der eingestellten Schwelle');
    expect(html).toContain('Prüfung MAIL-01 fehlgeschlagen');
    expect(html).toMatch(/Kritisch[\s\S]{0,200}>1</);
  });

  it('shows URLs as text, never as links, with line breaks allowed only after their separators', () => {
    const html = renderHtml(sampleFullReport(), ctx());

    expect(html).toContain(
      'https://<wbr>www.google-analytics.com/<wbr>g/<wbr>collect?<wbr>v=<wbr>2&amp;<wbr>tid=<wbr>G-TEST&amp;<wbr>cid=<wbr>[redacted]',
    );
    expect(html.replaceAll('<wbr>', '')).toContain('https://www.example.de/');

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
    expect(html).toContain('Anfragen beim Verlassen einer Seite werden nicht vollständig erfasst');
    expect(html).not.toContain('pagehide-beacons');
    expect(html).toContain('nicht festgestellt');
    expect(html).toContain('linux-x64');

    expect(html).toMatch(/geplant 2 · beobachtet 2 · auswertbar 1/);
    expect(html).toContain('<td>Seite des Bot-Schutzes</td>');
    expect(html).toContain('<td>Einwilligungsbanner nicht erkannt</td>');
    expect(html).toMatch(/MAIL-01[\s\S]{0,300}Fehler/);
    expect(html).toContain('Datensätze und Attribution');
  });

  it('words the coverage notes and limitations of the checks; only a code without a text stays a code', () => {
    const r = sampleFullReport();
    r.checks[0]!.coverage = { evaluated: 4, note: 'allowlist-v2:not-evaluated=6' };
    r.checks[1]!.coverage = { evaluated: 2, note: 'negation-not-parsed' };
    r.checks[0]!.limitations = ['status:429', 'preconnect-not-observable', 'unlisted-code:x'];

    const de = renderHtml(r, ctx());
    expect(de).toContain('6 Einträge auf der Allowlist (Version 2), daher nicht bewertet');
    expect(de).toContain('Verneinungen im Text werden nicht erkannt');
    expect(de).not.toContain('allowlist-v2:not-evaluated');
    expect(de).toContain('<div>Startseite antwortete mit HTTP 429</div>');
    expect(de).toContain('<div>Verbindungen ohne Anfrage (preconnect) nicht beobachtbar</div>');
    expect(de).not.toContain('preconnect-not-observable');
    // A code without a text stays readable as the code alone.
    expect(de).toMatch(/<div><code>unlisted-code:x<\/code><\/div>/);

    const en = renderHtml(r, ctx('en'));
    expect(en).toContain('6 entries on the allowlist (version 2), therefore not assessed');
    expect(en).toContain('<div>Start page answered with HTTP 429</div>');

    // No entry on the allowlist is said so plainly, not as a double negation.
    r.checks[0]!.coverage = { note: 'allowlist-v2:not-evaluated=0' };
    expect(renderHtml(r, ctx())).toContain('kein beobachteter Eintrag auf der Allowlist (Version 2)');
  });

  it('renders evidence of every known type and unknown types generically', () => {
    const html = renderHtml(sampleFullReport(), ctx());
    const r = sampleFullReport();
    r.findings[0]!.evidenceIds = r.evidence.map((e) => e.id);
    const all = renderHtml(r, ctx());

    expect(html).toContain('_ga');
    for (const t of ['Anfrage', 'Cookie', 'Speichereintrag', 'Header', 'DNS-Eintrag', 'TLS-Verbindung']) {
      expect(all).toContain(`>${t}<`);
    }
    for (const t of ['Einwilligungsbanner', 'Einwilligungsstatus', 'Dokument', 'Textstelle', 'Seite']) {
      expect(all).toContain(`>${t}<`);
    }
    // A type the texts do not know keeps its name.
    for (const t of ['Umleitungskette', 'Link', 'mixed-content']) expect(all).toContain(`>${t}<`);
    expect(all).toContain('Wir verwenden Google Analytics');
    expect(all).toContain('sourceUrl');
  });

  const evidenceById = (r: FullReport, id: string) => r.evidence.find((e) => e.id === id)!;

  function reportShowing(...evidenceIds: string[]): FullReport {
    const r = sampleFullReport();
    r.findings[0]!.evidenceIds = evidenceIds;
    return r;
  }

  function formReport(role: 'http-form' | 'http-form-permalink', url: string): FullReport {
    const r = reportShowing('ev-page');
    Object.assign(evidenceById(r, 'ev-page'), {
      status: 200,
      role,
      evaluable: undefined,
      reason: undefined,
      url,
      formAction: 'http://www.example.de/wp-comments-post.php',
    });
    return r;
  }

  it('names where the form of a page served over http sends, on its own and in a list of pages', () => {
    const r = formReport('http-form', 'http://www.example.de/blog/post-1/');
    const single = renderHtml(r, ctx());
    expect(single).toContain('Seite mit Formular über http');
    expect(single).toContain('>Ziel des Formulars<');
    expect(single).toContain('wp-comments-post.php');

    r.evidence.push({
      ...evidenceById(r, 'ev-page'),
      id: 'ev-page-2',
      url: 'http://www.example.de/kontakt/',
    } as Evidence);
    r.findings[0]!.evidenceIds = ['ev-page', 'ev-page-2'];
    expect(renderHtml(r, ctx())).toContain('Formular sendet an http://www.example.de/wp-comments-post.php');
    const en = renderHtml(r, ctx('en'));
    expect(en).toContain('page with a form over http');
    expect(en).toContain('form sends to http://www.example.de/wp-comments-post.php');
  });

  it('labels the http address of a linked post with a form as such', () => {
    const r = formReport('http-form-permalink', 'http://www.example.de/2025/02/beitrag/');
    expect(renderHtml(r, ctx())).toContain('http-Adresse eines verlinkten Beitrags mit Formular');
    expect(renderHtml(r, ctx('en'))).toContain('http address of a linked post with a form');
  });

  it('words the match of a dictionary term and labels the kind of statement a quote makes', () => {
    const r = reportShowing('ev-match');
    Object.assign(evidenceById(r, 'ev-match'), { matchLevel: 'term', claim: 'no-connection' });

    const de = renderHtml(r, ctx());
    expect(de).toContain('>Angabe<');
    expect(de).toContain('Begriff aus der Wortliste');
    expect(de).not.toContain('>claim<');
    const en = renderHtml(r, ctx('en'));
    expect(en).toContain('>Statement<');
    expect(en).toContain('dictionary term');
  });

  it('renders a banner-like box the heuristic did not take by its features, without buttons or blocking', () => {
    const r = sampleFullReport();
    const cmp = r.evidence.find((e) => e.type === 'cmp') as CmpEvidence;
    const { buttons: _b, blocking: _bl, click: _c, viewport: _v, version: _ve, ...rest } = cmp;
    const candidate: CmpEvidence = {
      ...rest,
      candidate: {
        reason: 'keywords',
        keywordHits: 1,
        controls: ['settings', 'other'],
        cookieWording: true,
        fixed: true,
        dialog: false,
        named: false,
      },
    };
    r.evidence = r.evidence.map((e) => (e.id === cmp.id ? candidate : e));
    r.findings[0]!.evidenceIds = [cmp.id];

    const html = renderHtml(r, ctx());
    expect(html).toContain('Bannerähnlicher Kasten');
    expect(html).toContain(
      'nicht als Banner gewertet: ein Einwilligungswort ohne Bannernamen und ohne Zustimmen oder Ablehnen · Einwilligungswörter: 1 · Schaltflächen: Einstellungen, sonstige Schaltfläche · nennt Cookies · fest positioniert',
    );
    expect(html).not.toContain('>Blockierung<');
    expect(renderHtml(r, ctx('en'))).toContain('Banner-like box');
  });

  it('names what phase B recorded before its click as such, in the evidence and in the phases of the finding', () => {
    const r = reportShowing('ev-request');
    r.scan.coverage.consentActions = [{ action: 'reject', clicked: true, verified: false }];
    const request = evidenceById(r, 'ev-request');
    for (const ev of [request, evidenceById(r, 'ev-screenshot')])
      Object.assign(ev, { phase: 'B', beforeClick: true });
    r.findings[1]!.evidenceIds = ['ev-screenshot'];

    const html = renderHtml(r, ctx());
    expect(html).toContain('A (vor einer Interaktion), B (erster Bildschirm, vor dem Ablehnen)');
    expect(html).toContain('>B (erster Bildschirm, vor dem Ablehnen)<');
    expect(html).not.toContain('nach Ablehnung, vom Banner nicht bestätigt');

    // Counterexample: what B recorded after the click keeps the outcome of the click.
    delete (request as { beforeClick?: boolean }).beforeClick;
    expect(renderHtml(r, ctx())).toContain(
      'A (vor einer Interaktion), B (nach Ablehnung, vom Banner nicht bestätigt)',
    );
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
    expect(html).toContain('Website nicht erreichbar');
    expect(html).toContain('nicht verfügbar');
    for (const h of headings.de) {
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
  /** A finding of the check and variant its message id names, without evidence. */
  const finding = (n: number, messageId: string, severity: Finding['severity'], serviceId?: string) =>
    findingOf(n, messageId, severity, { legalNoteId: 'CONSENT-04', ...(serviceId ? { serviceId } : {}) });

  it('groups findings by serviceId, strongest group first, unassigned last', () => {
    const r = sampleFullReport();
    r.findings = [
      finding(10, 'CONSENT-04.banner-not-recognized', 'info'),
      finding(11, 'EMBED-01.fonts-loaded', 'warning', 'google-fonts'),
      finding(12, 'TRACK-01.inventory', 'info', 'google-analytics-4'),
      finding(13, 'CONSENT-01.tracker-hit', 'critical', 'google-analytics-4'),
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

  const screenshotHtml = (outDir: string, file: string, checksum: string) =>
    renderHtml(withScreenshot(file, checksum), ctx('de', outDir));

  it('embeds the banner screenshot as a data: URI', () => {
    const outDir = setup({ 'artifacts/banner-B.jpg': JPEG });

    const html = screenshotHtml(outDir, 'artifacts/banner-B.jpg', sha(JPEG));

    expect(html).toContain(`src="data:image/jpeg;base64,${JPEG.toString('base64')}"`);
    expect(htmlSafetyProblems(html)).toEqual([]);
  });

  it('accepts a sha256: prefix and PNG files', () => {
    const outDir = setup({ 'artifacts/banner-B.png': PNG });
    const html = screenshotHtml(outDir, 'artifacts/banner-B.png', `sha256:${sha(PNG)}`);

    expect(html).toContain('src="data:image/png;base64,');
  });

  it('does not embed files outside the artifacts directory', () => {
    const outDir = setup({ 'secret.jpg': JPEG });

    const parentTraversal = screenshotHtml(path.join(outDir, 'sub'), '../secret.jpg', sha(JPEG));
    const outsideArtifacts = screenshotHtml(outDir, 'secret.jpg', sha(JPEG));
    const absolutePath = screenshotHtml(outDir, '/etc/passwd', sha(JPEG));

    expect(parentTraversal).not.toContain('data:image');
    expect(outsideArtifacts).not.toContain('data:image');
    expect(absolutePath).not.toContain('data:image');
    expect(absolutePath).toContain('Screenshot nicht eingebettet');
  });

  it('does not follow symlinks out of the artifacts directory', () => {
    const outDir = setup({ 'outside.jpg': JPEG });
    symlinkSync(path.join(outDir, 'outside.jpg'), path.join(outDir, 'artifacts/link.jpg'));

    const html = screenshotHtml(outDir, 'artifacts/link.jpg', sha(JPEG));

    expect(html).not.toContain('data:image');
  });

  it('does not embed files with a wrong checksum or a non-image content', () => {
    const fake = Buffer.from('<svg/>');
    const outDir = setup({ 'artifacts/banner-B.jpg': JPEG, 'artifacts/fake.jpg': fake });

    const wrongChecksum = screenshotHtml(outDir, 'artifacts/banner-B.jpg', 'f'.repeat(64));
    const notAnImage = screenshotHtml(outDir, 'artifacts/fake.jpg', sha(fake));

    expect(wrongChecksum).not.toContain('data:image');
    expect(notAnImage).not.toContain('data:image');
  });

  it('degrades gracefully when the file is missing', () => {
    const html = renderHtml(sampleFullReport(), ctx());

    expect(html).toContain('Screenshot nicht eingebettet');
    expect(html).toContain('artifacts/banner-B.jpg');
  });

  it('embeds images up to the size limit of the settings and no larger ones', () => {
    const outDir = setup({ 'artifacts/banner-B.jpg': JPEG });
    const report = withScreenshot('artifacts/banner-B.jpg', sha(JPEG));
    const limits = (screenshotEmbedMaxBytes: number) => ({
      ...reporterLimits(),
      screenshotEmbedMaxBytes,
    });

    const atLimit = renderHtml(report, { ...ctx('de', outDir), limits: limits(JPEG.length) });
    const html = renderHtml(report, { ...ctx('de', outDir), limits: limits(JPEG.length - 1) });

    expect(atLimit).toContain('data:image');
    expect(html).not.toContain('data:image');
    expect(html).toContain('Screenshot nicht eingebettet');
  });
});

describe('HTML report: settings that differ from the defaults', () => {
  const withSettings = (settings: Record<string, string | number | boolean>): FullReport => {
    const r = sampleFullReport();
    r.scan.options = { ...r.scan.options!, settings };
    return r;
  };

  it('lists them in the measurement environment, as variable=value', () => {
    const html = renderHtml(
      withSettings({ DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS: 3000, DSGVO_CHECK_DNS_SERVERS: '1.1.1.1,9.9.9.9' }),
      ctx(),
    );

    expect(html).toContain('Abweichende Einstellungen');
    expect(html).toContain('<code>DSGVO_CHECK_BROWSER_QUIET_WINDOW_MS=3000</code>');
    expect(html).toContain('<code>DSGVO_CHECK_DNS_SERVERS=1.1.1.1,9.9.9.9</code>');
    expect(renderHtml(withSettings({ DSGVO_CHECK_TLS_EXPIRING_DAYS: 21 }), ctx('en'))).toContain(
      'Settings that differ from the defaults',
    );
  });

  it('shows no row when nothing differs', () => {
    expect(renderHtml(sampleFullReport(), ctx())).not.toContain('Abweichende Einstellungen');
    expect(renderHtml(withSettings({}), ctx())).not.toContain('Abweichende Einstellungen');
  });

  it('escapes hostile names and values like any external string', () => {
    const html = renderHtml(withSettings({ [`X${PAYLOAD}`]: PAYLOAD }), ctx());

    expect(htmlSafetyProblems(html)).toEqual([]);
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

// Stop words in these labels are blocked by stopwords.test.ts, which reads every text file the labels come from.
describe('report labels', () => {
  it('every label key exists in de and en data with the same parameters', () => {
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
  const readTemplate = () => readFileSync(path.join(DEFAULT_DATA_DIR, 'report', 'report.html'), 'utf8');

  it('hashes the style as browsers parse it after a Windows checkout', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'report-template-'));
    mkdirSync(path.join(dataDir, 'report'));
    const windowsSource = readTemplate().replace('<style>', '<style>\n').replace(/\r?\n/g, '\r\n');
    writeFileSync(path.join(dataDir, 'report', 'report.html'), windowsSource);

    const html = renderHtml(sampleFullReport(), { ...ctx(), dataDir });

    expect(htmlSafetyProblems(html)).toEqual([]);
  });

  it('has no executable markup, raw placeholders or external resources in the template', () => {
    const template = readTemplate();

    expect(template).not.toMatch(/{{[{&=]|<script|\son[a-z]+\s*=|\sstyle\s*=|https?:\/\/|url\s*\(|@import/i);

    const styles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(styles).toHaveLength(1);
    expect(styles[0]![1]).not.toContain('{{');

    const withoutDirectives = template
      .replace(/{{[\s\S]*?}}/g, '')
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '');
    expect(withoutDirectives).not.toMatch(/[a-zA-ZÀ-ž]/);
  });

  it('renders every JSON finding with its text and fingerprint', () => {
    const report = sampleFullReport();
    const context = ctx();
    const html = renderHtml(report, context);
    for (const finding of report.findings) {
      expect(html).toContain(escapeHtml(finding.checkId));
      expect(html).toContain(escapeHtml(sanitizeExternal(findingText(finding, context).title, 300)));
      expect(html).toContain(escapeHtml(sanitizeExternal(findingText(finding, context).body, 4000)));
      expect(html).toContain(escapeHtml(finding.fingerprint));
    }
  });
});
