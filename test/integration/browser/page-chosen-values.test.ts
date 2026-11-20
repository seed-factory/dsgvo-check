/**
 * The real browser collector on a site that plants values of its own choosing in attributes, request methods and
 * parameters, cookie paths, link and refresh targets, the in-page logs of the collector and the answers of its page
 * code, and whose legal pages print the visitor's cookie and storage values. None of them reaches the collector result;
 * what real sites need (the legal documents, their language, the addresses of the site, the link and script facts) is
 * still there. Markers: `zq8` in any case, `4f3a9c1d`.
 */
import { describe, expect, it } from 'vitest';
import { persisted } from './helpers.ts';
import { HOSTILE_SITE, PRINTED_COOKIE, PRINTED_STORAGE, SITE_HOST } from './hostile-values-site.ts';
import { useSite } from './site-dir.ts';

const site = useSite(HOSTILE_SITE, { host: SITE_HOST, collect: { maxPages: 4 } });

const phaseA = () => site.run.result.sections.browser?.phases.find((p) => p.phase === 'A');
const visit = (path: string) => phaseA()?.pages.find((p) => p.url === `https://${SITE_HOST}${path}`);
const documents = () => site.run.result.sections.documents?.documents ?? [];

describe('values the page chose', () => {
  it('none of them is in what the collector persists', () => {
    // The excerpts around a marker, not the whole result, so that a failure stays readable.
    expect(persisted(site.run).match(/[^"]{0,40}(?:zq8|4f3a9c1d)[^"]{0,40}/gi) ?? []).toEqual([]);
    expect(persisted(site.run)).not.toContain('alice@');
  });

  it('the start page keeps no lang, only HTML link types, hint types, a closed form method and a MIME script type', () => {
    const dom = visit('/')?.dom;
    expect(dom).toBeDefined();
    expect(dom?.lang).toBeUndefined();
    expect(dom?.links.find((l) => l.href?.endsWith('/leistungen/'))).toMatchObject({ rel: 'nofollow' });
    expect(dom?.linkRels).toEqual(
      expect.arrayContaining([
        { rel: 'stylesheet', href: `https://${SITE_HOST}/style.css`, source: 'dom' },
        { rel: 'preload', href: `https://${SITE_HOST}/style.css`, as: 'style', source: 'dom' },
      ]),
    );
    expect(dom?.forms.map((f) => f.method)).toEqual(['get']);
    expect(dom?.scripts.find((s) => s.inline && s.type)?.type).toBe('text/plain');
    // A MIME type with an id-like run, or a host with a path, is no type of the scanner's set.
    expect(dom?.scripts.filter((s) => s.inline && s.type).map((s) => s.type)).toEqual([
      'text/plain',
      'other',
      'other',
    ]);
  });

  it('a refresh to a javascript: target keeps no URL; links of other schemes keep only the scheme', () => {
    const dom = visit('/')?.dom;
    expect(dom?.metaRefresh).toEqual({ url: null, delaySec: 3600 });
    expect(dom?.links.filter((l) => l.hrefKind === 'other').map((l) => l.href)).toEqual([
      'skype:[redacted]',
      'whatsapp:[redacted]',
      'intent:[redacted]',
    ]);
  });

  it('a page that changes the objects the page code pushes gets the closed region and no visibility', () => {
    const links = visit('/')?.dom?.links ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect([l.region, l.visible]).toEqual(['other', false]);
  });

  it('requests keep a standard method only and no event name or signal of another form', () => {
    const requests = phaseA()?.requests ?? [];
    expect(requests.find((r) => r.url.endsWith('/api/ping'))?.method).toBe('OTHER');
    const beacon = requests.find((r) => r.url.endsWith('/collect'));
    expect(beacon).toBeDefined();
    expect(beacon?.eventType).toBeUndefined();
    expect(beacon?.consentSignals).toBeUndefined();
    const idBeacon = requests.find((r) => r.url.endsWith('/collect-id'));
    expect(idBeacon).toBeDefined();
    expect(idBeacon?.eventType).toBeUndefined();
  });

  it('a cookie path with a query is stored redacted; a forged entry of the cookie-write log gives no record', () => {
    const cookies = phaseA()?.cookies ?? [];
    expect(cookies.find((c) => c.name === 'pathprobe')).toMatchObject({
      path: '[redacted]',
      state: 'accepted',
    });
    expect(cookies.find((c) => c.name === 'forged')).toBeUndefined();
    expect(cookies.find((c) => c.name === 'forgedhost')).toBeUndefined();
    expect(cookies.find((c) => c.name === 'pathid')).toMatchObject({ path: '[redacted]', state: 'accepted' });
    // The browser refused the Domain= the page made up: the attempt is placed on the document host.
    expect(cookies.filter((c) => c.name === 'domainprobe').map((c) => [c.state, c.domain])).toEqual([
      ['attempted', SITE_HOST],
    ]);
    // counterexample: the cookie of the legal pages has a plain path
    expect(cookies.find((c) => c.name === 'cid')).toMatchObject({ path: '/' });
  });

  it('the legal documents are found, in German, and hold no printed value of the visitor', () => {
    expect(documents().map((d) => [d.kind, d.lang])).toEqual(
      expect.arrayContaining([
        ['impressum', 'de'],
        ['privacy', 'de'],
      ]),
    );
    for (const d of documents()) {
      const text = d.parts.map((p) => p.text).join(' ');
      // Text nodes are joined with a space: `<span>…</span>.` reads `[redacted] .`.
      expect(text).toMatch(/Ihre Einwilligungs-ID: \[redacted\] ?\. Ihre Kennung: \[redacted\] ?\./);
      expect(text).not.toContain(PRINTED_COOKIE);
      expect(text).not.toContain(PRINTED_STORAGE);
      // The IDs go; the host of the site and the domain of the tracker stay.
      expect(text).toContain(`Empfehlung: ${SITE_HOST}/r/[redacted] .`);
      expect(text).toContain('Pixel: [redacted].tracker.test .');
      expect(text).toMatch(/Sitzung: \[redacted\] \..*Startseite: \[redacted\] \./);
      expect(text).toContain('Link: https://[redacted].tracker.test/?[redacted] Ende.');
    }
    // counterexample: the Impressum details stay as they are; the host the consent cookie also holds stays in the
    // address and the link, the address without its local part
    const impressum = documents().find((d) => d.kind === 'impressum');
    const text = impressum?.parts.map((p) => p.text).join(' ') ?? '';
    expect(text).toContain('USt-IdNr.: DE123456789');
    expect(text).toContain('E-Mail: [redacted]@autohaus24online.test.');
    expect(text).toContain(`Website: https://${SITE_HOST}/de/impressum/ (Stand 2026).`);
    expect(persisted(site.run)).not.toContain('max.mustermann');
  });

  it('touches only declared hosts', () => {
    expect(site.server.unexpected).toEqual([]);
  });
});
