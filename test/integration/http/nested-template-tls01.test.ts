/**
 * An inert `<meta http-equiv="refresh">` inside nested `<template>` elements of an http page is no redirect, so TLS-01
 * stays `https-unavailable` (critical) instead of `client-side-redirect-only` (warning). The collector runs for real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tls01 } from '../../../src/checks/http/tls-01.ts';
import { createHttpCollector } from '../../../src/collectors/http/index.ts';
import type { HttpSection } from '../../../src/core/snapshot/http.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { makeSnapshot, makeTarget, runCheck, variantsOf } from '../../utils/snapshot-builder.ts';
import { closedPort, collectorContext, withRoutes } from './helpers.ts';
import { GOOD_HEADERS, page } from './sites.ts';

const META = (host: string) => `<meta http-equiv="refresh" content="0; url=https://${host}/next">`;

const httpPage = (host: string, body: string) => ({
  host,
  scheme: 'http' as const,
  path: '/',
  status: 200,
  headers: GOOD_HEADERS,
  body: page('Start', body),
});

let server: FixtureServer;
let closed: number;
const collector = createHttpCollector({ minIntervalMs: 20 });

beforeAll(async () => {
  server = await startFixtureServer({
    routes: [
      // The only meta is inert: it sits inside the outer template, after the closing tag of the inner one.
      httpPage(
        'www.nestedtpl.test',
        `<template><template></template>${META('www.nestedtpl.test')}</template>`,
      ),
      // Counterexample: the meta comes after the outer template and is the page's own redirect.
      httpPage('www.realmeta.test', `<template><template></template></template>${META('www.realmeta.test')}`),
    ],
  });
  closed = await closedPort();
});

afterAll(async () => {
  await server?.close();
});

async function collectHttpOnly(host: string): Promise<HttpSection> {
  // https of the host and of its apex refuse connections: the http page is all there is.
  const bare = host.replace(/^www\./, '');
  const res = await collector(
    collectorContext(
      `http://${host}/`,
      withRoutes(server.network(), { [`${host}:443`]: closed, [bare]: closed }),
    ),
  );
  expect(res.fatal).toBeUndefined();
  return res.sections.http as HttpSection;
}

const httpHop = (http: HttpSection) =>
  http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'http')?.final;

describe('TLS-01 with an inert refresh in nested templates', () => {
  it('http page, https refused: the nested-template meta is no redirect → https-unavailable (critical)', async () => {
    const http = await collectHttpOnly('www.nestedtpl.test');
    const hop = httpHop(http);
    expect(hop).toMatchObject({ status: 200, bodyKind: 'html' });
    expect(hop?.clientRedirect).toBeUndefined();
    const https = http.chains.find((c) => c.hostVariant === 'target' && c.scheme === 'https');
    expect(https).toMatchObject({ outcome: 'connection-refused', hops: [] });

    const result = runCheck(tls01, makeSnapshot({ target: makeTarget('http://www.nestedtpl.test/'), http }));
    expect(variantsOf(result)).toEqual(['https-unavailable']);
    expect(result.outcome?.observations[0]?.params).toMatchObject({ reason: 'unavailable' });
    expect(server.unexpected).toEqual([]);
  });

  it('counterexample: a real meta after the outer template is still the redirect → client-side-redirect-only', async () => {
    const http = await collectHttpOnly('www.realmeta.test');
    expect(httpHop(http)?.clientRedirect).toEqual({
      kind: 'meta',
      url: 'https://www.realmeta.test/next',
    });
    const result = runCheck(tls01, makeSnapshot({ target: makeTarget('http://www.realmeta.test/'), http }));
    expect(variantsOf(result)).toEqual(['client-side-redirect-only']);
    expect(server.unexpected).toEqual([]);
  });
});
