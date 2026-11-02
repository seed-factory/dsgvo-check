/**
 * SSRF boundary of the prototype — documents (top-level, frames, popups) to loopback, link-local/metadata and
 * private addresses, or to names that do not resolve locally, are not loaded when `allowPrivateAddresses` is false.
 * Fixture hosts are declared public by a fake lookup; `intranet.example.test` resolves to a private address and
 * `unresolvable.example.test` does not resolve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lookup } from '../../../src/core/net.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { collect } from './helpers.ts';
import { stubCmpApi } from './stub-cmp.ts';

const lookup: Lookup = async (host) => {
  if (host === 'unresolvable.example.test')
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return host === 'intranet.example.test'
    ? [{ address: '10.0.0.5', family: 4 }]
    : [{ address: '93.184.215.14', family: 4 }];
};

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/ssrf'] });
});

afterAll(async () => {
  await server?.close();
});

const metadataHits = () => server.requestsTo('169.254.169.254').map((r) => r.path);

describe('SSRF guard (documents and frames)', () => {
  it('blocks frames to 169.254.169.254, 127.0.0.1, a private address and an unresolvable name', async () => {
    const run = await collect(server, { network: { allowPrivateAddresses: false, lookup } });
    expect(run.result.status).toBe('ok');
    const blocked = run.requests.filter((r) => r.blockedByGuard);
    expect(blocked.map((r) => r.url).sort()).toEqual([
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      // nested inside a cross-site (out-of-process) frame: covered by the browser-level session
      'http://169.254.169.254/latest/meta-data/nested',
      'https://intranet.example.test/',
      'https://unresolvable.example.test/',
    ]);
    for (const r of blocked)
      expect(r).toMatchObject({ state: 'blocked-by-browser', delivery: 'blocked-by-browser' });
    expect(server.requestsTo('intranet.example.test')).toEqual([]);
    expect(server.requestsTo('unresolvable.example.test')).toEqual([]);
    expect(metadataHits()).toEqual([]);
    expect(run.result.sections.browser?.guard).toMatchObject({ enabled: true, blocked: 5 });
    // One diagnostic; its params name the address classes, `unresolved` separately .
    const diag = run.result.diagnostics?.find((d) => d.code === 'SCAN-PRIVATE-REQUEST-BLOCKED');
    expect(diag).toMatchObject({ affects: [], params: { count: 5 } });
    expect(String(diag?.params?.addressClass).split(', ')).toEqual([
      'loopback',
      'metadata',
      'private',
      'unresolved',
    ]);
    expect(run.result.sections.browser?.knownGaps).toContain('ssrf-guard-subresources-unchecked');
    // The public target itself is loaded normally.
    expect(run.result.sections.browser?.phases[0]?.pages[0]).toMatchObject({ evaluable: true });
  });

  it('a start page redirecting to the metadata address ends the scan as invalid input', async () => {
    const run = await collect(server, {
      url: 'https://redir.example.test/',
      network: { allowPrivateAddresses: false, lookup },
    });
    expect(run.result.status).toBe('error');
    expect(run.result.fatal).toMatchObject({ reason: 'invalid-input', code: 'start-page-not-public' });
    expect(run.result.fatal?.message).toMatch(/leitet .* weiter/);
    const nav = run.requests.find((r) => r.url.startsWith('http://169.254.169.254'));
    expect(nav).toMatchObject({ blockedByGuard: true, isNavigation: true, isMainFrame: true });
  });

  it('a start host that itself is not public is named as such, without a redirect that did not happen', async () => {
    const run = await collect(server, {
      url: 'https://intranet.example.test/',
      maxPages: 1,
      network: { allowPrivateAddresses: false, lookup },
    });
    expect(run.result.fatal).toMatchObject({ reason: 'invalid-input', code: 'start-page-not-public' });
    expect(run.result.fatal?.message).not.toMatch(/leitet/);
    expect(server.requestsTo('intranet.example.test')).toEqual([]);
  });

  it('is off when private addresses are allowed (tests only)', async () => {
    const run = await collect(server, { maxPages: 1 });
    expect(run.result.sections.browser?.guard).toEqual({ enabled: false, blocked: 0 });
    expect(server.requestsTo('intranet.example.test').length).toBeGreaterThan(0);
  });
});

describe('SSRF guard covers new windows', () => {
  it('window.open / target=_blank without a user gesture never reach internal addresses', async () => {
    server.reset();
    const run = await collect(server, {
      url: 'https://popup.example.test/',
      maxPages: 1,
      network: { allowPrivateAddresses: false, lookup },
    });
    expect(run.result.status).not.toBe('error');
    expect(metadataHits()).toEqual([]);
    expect(server.requestsTo('intranet.example.test')).toEqual([]);
    // Popup documents do not appear as page traffic of the scan either.
    expect(run.requests.filter((r) => r.url.includes('via-popup') || r.url.includes('via-form'))).toEqual([]);
  });

  it('a popup opened by the CMP click (user gesture) is blocked as well', async () => {
    server.reset();
    const run = await collect(server, {
      url: 'https://popup-click.example.test/',
      maxPages: 1,
      deps: { cmp: stubCmpApi(), phases: ['A', 'B'] },
      network: { allowPrivateAddresses: false, lookup },
    });
    const b = run.result.sections.browser?.phases.find((p) => p.phase === 'B');
    expect(b?.click).toMatchObject({ action: 'reject', success: true });
    expect(metadataHits()).toEqual([]);
    expect(run.result.sections.browser?.guard?.blocked).toBeGreaterThanOrEqual(1);
  });
});
