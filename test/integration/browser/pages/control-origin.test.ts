/**
 * Control pages on the origin of the click page: B and C click on the start page of the apex host, so its pages come
 * before a www page with a stronger signal, which is taken only when the apex pages run out and is marked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { collect } from '../helpers.ts';

const START = 'https://example.test/';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ sites: ['browser/control-origin'] });
});

afterAll(async () => {
  await server?.close();
});

describe('control pages and the origin of the click page', () => {
  it('pages of the start origin come first; the www page with the map is left out', async () => {
    const run = await collect(server, { url: START });
    const plan = run.result.sections.plan;

    expect(plan?.pages.find((p) => p.role === 'contact')?.url).toBe('https://www.example.test/kontakt/');
    expect(plan?.controlPages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://example.test/team/', ['replication']],
      ['https://example.test/impressum/', ['replication']],
    ]);
    expect(server.unexpected).toEqual([]);
  });

  it('a page of another origin is taken once the start origin has none left, and is marked', async () => {
    const run = await collect(server, { url: START, config: { browser: { maxControlPages: 5 } } });

    expect(run.result.sections.plan?.controlPages.map((p) => [p.url, p.reasons])).toEqual([
      ['https://example.test/team/', ['replication']],
      ['https://example.test/impressum/', ['replication']],
      ['https://example.test/datenschutz/', ['replication']],
      [
        'https://www.example.test/kontakt/',
        ['iframe-signal', 'network-signal', 'embed-signal', 'role:contact', 'other-origin'],
      ],
    ]);
  });
});
