/**
 * a fake GA4 tag fires before any consent. Phase A must show the hit with the identifier redacted, the
 * identifier name and stored-identifier match extracted before redaction, and the _ga cookie without its value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_URL } from '../../../src/core/user-agent.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { type CollectRun, collect, persisted, TEST_SANDBOX } from './helpers.ts';

let server: FixtureServer;
let run: CollectRun;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/ga4'] });
  run = await collect(server);
});

afterAll(async () => {
  await server?.close();
});

describe('GA4 before consent (phase A)', () => {
  it('records the hit with cid redacted and safe features kept', () => {
    expect(run.result.status).toBe('ok');
    const hit = run.requests.find((r) => r.host === 'www.google-analytics.com');
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({
      phase: 'A',
      pageUrl: 'https://www.example.test/',
      method: 'POST',
      resourceType: 'fetch',
      tRef: 'navigation',
      afterClick: false,
      identifierPresent: true,
      identifierNames: ['cid'],
      eventType: 'page_view',
      consentSignals: { gcs: 'G111' },
      matchesStoredIdentifier: true,
      state: 'completed',
      delivery: 'sent',
      status: 204,
      isMainFrame: true,
    });
    expect(hit?.url).toBe(
      'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST123&gcs=G111&cid=[redacted]&en=page_view&dl=[redacted]',
    );
    expect(hit?.tStartMs).toBeGreaterThanOrEqual(0);
    const loader = run.requests.find((r) => r.host === 'www.googletagmanager.com');
    expect(loader).toMatchObject({
      resourceType: 'script',
      url: 'https://www.googletagmanager.com/gtag/js?id=G-TEST123',
    });
  });

  it('records _ga without its value', () => {
    const phaseA = run.result.sections.browser?.phases.find((p) => p.phase === 'A');
    const ga = phaseA?.cookies.find((c) => c.name === '_ga');
    expect(ga).toMatchObject({
      domain: 'www.example.test',
      firstParty: true,
      state: 'accepted',
      setter: 'script',
      length: 'GA1.1.987654321.1700000000'.length,
      lifetime: { kind: 'persistent' },
    });
    expect(ga?.setterUrl).toBe('https://www.googletagmanager.com/gtag/js?id=G-TEST123');
    const text = persisted(run);
    expect(text).not.toContain('987654321');
    expect(text).not.toContain('1700000000');
  });

  it('uses the real Chrome UA plus the repository token, new headless, de-DE, 1366×768, sandbox per option', () => {
    const b = run.result.sections.browser;
    expect(b?.engine).toMatchObject({
      name: 'chromium',
      channel: 'chromium',
      headless: 'new',
      sandbox: TEST_SANDBOX === 'require',
    });
    expect(b?.engine.userAgent).toMatch(/Chrome\/\d+/);
    expect(b?.engine.userAgent).not.toContain('HeadlessChrome');
    expect(b?.engine.userAgent).toContain(REPO_URL);
    expect(b?.engine.disabledFeatures).toContain('ThirdPartyStoragePartitioning');
    expect(b).toMatchObject({
      viewport: { width: 1366, height: 768 },
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
    });
    const seen = server.requestsTo('www.example.test').filter((r) => r.path === '/');
    expect(seen[0]?.userAgent).toBe(b?.engine.userAgent);
  });

  it('selects start, legal pages and Kontakt with reasons and extracts the documents', () => {
    const plan = run.result.sections.plan;
    expect(plan?.pages.map((p) => [p.url, p.role, p.reasons])).toEqual([
      ['https://www.example.test/', 'start', ['start']],
      ['https://www.example.test/impressum/', 'impressum', ['footer-link:impressum']],
      ['https://www.example.test/datenschutz/', 'privacy', ['footer-link:datenschutz']],
      ['https://www.example.test/kontakt/', 'contact', ['nav-link:kontakt']],
    ]);
    const docs = run.result.sections.documents?.documents ?? [];
    expect(docs.map((d) => [d.kind, d.foundVia, d.complete, d.format])).toEqual([
      ['impressum', 'link', true, 'html'],
      ['privacy', 'link', true, 'html'],
    ]);
    expect(run.result.sections.finalUrl).toBe('https://www.example.test/');
  });

  it('every page of phase A is a fresh-profile visit with the quiet algorithm', () => {
    const a = run.result.sections.browser?.phases[0];
    expect(a?.profile).toBe('persistent-tmp');
    expect(a?.pages[0]).toMatchObject({ role: 'start', firstVisit: true, evaluable: true });
    expect(a?.pages.slice(1).every((p) => p.firstVisit === false)).toBe(true);
    for (const p of a?.pages ?? []) expect(p.navigation.dwellMs).toBeGreaterThanOrEqual(400);
    expect(server.unexpected).toEqual([]);
  });
});
