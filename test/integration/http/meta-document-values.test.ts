/**
 * the `<meta>` facts of the start document. They come from the markup of the document,
 * not from inert elements (`<template>`, `<noscript>`), and what is stored is reduced like a response header: URLs
 * sanitized, a value outside the allowlist `[redacted]`, a cookie never stored (AGENTS rule 2: the collector edits
 * before it writes). The collector runs for real against a local server; HDR-01 reads the section it produced.
 * Every marker starts with `zq7`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hdr01 } from '../../../src/checks/http/hdr-01.ts';
import { createHttpCollector } from '../../../src/collectors/http/index.ts';
import type { HttpSection } from '../../../src/collectors/http/types.ts';
import { MAX_HEADER_VALUE } from '../../../src/core/headers.ts';
import { type FixtureServer, startFixtureServer } from '../../fixture-server/server.ts';
import { makeSnapshot, makeTarget, runCheck } from '../../utils/snapshot-builder.ts';
import { closedPort, collectorContext, withRoutes } from './helpers.ts';
import { GOOD_HEADERS, page } from './sites.ts';

/** The page sends no anti-framing, no CSP and no referrer policy by header: only its meta tags could. */
const BARE_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

const httpPage = (host: string, body: string) => ({
  host,
  scheme: 'http' as const,
  path: '/',
  status: 200,
  headers: BARE_HEADERS,
  body: page('Start', body),
});

let server: FixtureServer;
let closed: number;
const collector = createHttpCollector({ minIntervalMs: 20 });

beforeAll(async () => {
  server = await startFixtureServer({
    routes: [
      httpPage(
        'www.metaval.test',
        [
          '<meta http-equiv="refresh" content="0; url=/next?email=zq7alice@mail.invalid&amp;sid=zq7session">',
          '<meta http-equiv="content-security-policy" content="frame-ancestors portal.invalid/users/zq7alice%40mail.invalid">',
          '<meta http-equiv="set-cookie" content="zq7id=zq7cookievalue; path=/">',
          '<meta http-equiv="x-ua-compatible" content="IE=edge">',
          '<meta name="referrer" content="no-referrer, zq7bob@mail.invalid">',
        ].join(''),
      ),
      httpPage(
        'www.metainert.test',
        [
          '<template><meta http-equiv="content-security-policy" content="frame-ancestors \'none\'">',
          '<meta name="referrer" content="unsafe-url"></template>',
          '<noscript><meta http-equiv="content-security-policy" content="default-src \'self\'"></noscript>',
        ].join(''),
      ),
      // counterexample: the same tags outside any inert element are the document's own
      httpPage(
        'www.metareal.test',
        [
          '<meta http-equiv="content-security-policy" content="frame-ancestors \'none\'">',
          '<meta name="referrer" content="unsafe-url">',
        ].join(''),
      ),
      // 56 000-character values of untrusted markup must not hold up the event loop.
      httpPage(
        'www.metaredos-refresh.test',
        `<meta http-equiv="refresh" content="0;x${' '.repeat(56_000)}y">`,
      ),
      httpPage('www.metaredos-link.test', `<meta http-equiv="link" content="${'<'.repeat(56_000)}">`),
      httpPage(
        'www.metaredos-referrer.test',
        `<meta name="referrer" content="${'a,'.repeat(28_000)}no-referrer">`,
      ),
      // A tag of about 56 KB made of tokens that are no Referrer-Policy keyword, and one made of keywords
      httpPage('www.metareferrer-junk.test', `<meta name="referrer" content="${'a,'.repeat(28_000)}">`),
      httpPage(
        'www.metareferrer-many.test',
        `<meta name="referrer" content="${'no-referrer,'.repeat(4_500)}origin">`,
      ),
      // Names of http-equiv tags are untrusted text too: long ones, ones with an address, a thousand distinct short ones
      httpPage(
        'www.metaequiv-junk.test',
        [
          '<meta http-equiv="content-security-policy" content="frame-ancestors \'none\'">',
          `<meta http-equiv="${'x'.repeat(30_000)}zq7bob@mail.invalid" content="v">`,
          `<meta http-equiv="zq7alice@mail.invalid" content="v">`,
          ...Array.from({ length: 800 }, (_, i) => `<meta http-equiv="h${i}-yyyyy" content="v">`),
        ].join(''),
      ),
      {
        host: 'www.metagood.test',
        scheme: 'http' as const,
        path: '/',
        status: 200,
        headers: GOOD_HEADERS,
        body: page(
          'Start',
          '<meta http-equiv="x-ua-compatible" content="IE=edge"><meta name="referrer" content="origin">',
        ),
      },
    ],
  });
  closed = await closedPort();
});

afterAll(async () => {
  await server?.close();
});

async function collectHttpOnly(host: string): Promise<HttpSection> {
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

const start = (http: HttpSection) => http.documents.find((d) => d.role === 'start');

describe('the meta values of the document are stored reduced', () => {
  it('no marker of the page survives in the section; the facts the check reads are still there', async () => {
    const http = await collectHttpOnly('www.metaval.test');
    expect(JSON.stringify(http)).not.toContain('zq7');
    const doc = start(http);
    const by = (name: string) => doc?.metaHttpEquiv.find((m) => m.name === name);
    // the refresh keeps its delay and the path, the query is redacted
    expect(by('refresh')?.value).toMatch(/^0; url=http:\/\/www\.metaval\.test\/next\?/);
    // the CSP keeps its directives; the path of the scheme-less source is gone
    expect(by('content-security-policy')?.value).toBe('frame-ancestors portal.invalid');
    // a cookie of a meta tag is no stored value at all
    expect(by('set-cookie')?.value).toBe('[redacted]');
    expect(by('x-ua-compatible')?.value).toBe('[redacted]');
    // the referrer keeps its policy keyword, the rest is dropped
    expect(doc?.metaReferrer).toBe('no-referrer');
    expect(server.unexpected).toEqual([]);
  });

  it('HDR-01 still reads the meta CSP as a hint and the referrer policy of the meta tag', async () => {
    const http = await collectHttpOnly('www.metaval.test');
    const r = runCheck(hdr01, makeSnapshot({ target: makeTarget('http://www.metaval.test/'), http }));
    const params = (r.outcome?.observations ?? []).map((o) => [o.variant, o.params]);
    expect(params).toContainEqual(['anti-framing-missing', expect.objectContaining({ hint: 'meta-csp' })]);
    // the effective policy is no-referrer: no referrer finding
    expect(params.map(([v]) => v)).not.toContain('referrer-policy-permissive');
  });

  it('counterexample: a clean meta set is stored as read (keyword referrer, allowlisted nothing to reduce)', async () => {
    const http = await collectHttpOnly('www.metagood.test');
    const doc = start(http);
    expect(doc?.metaReferrer).toBe('origin');
    expect(doc?.metaHttpEquiv.map((m) => m.name)).toEqual(['x-ua-compatible']);
    expect(server.unexpected).toEqual([]);
  });
});

describe('inert meta tags are no facts of the document', () => {
  it('a meta inside a template or a noscript counts neither as CSP nor as referrer', async () => {
    const http = await collectHttpOnly('www.metainert.test');
    const doc = start(http);
    expect(doc?.metaHttpEquiv).toEqual([]);
    expect(doc?.metaReferrer).toBeNull();
    const r = runCheck(hdr01, makeSnapshot({ target: makeTarget('http://www.metainert.test/'), http }));
    const variants = (r.outcome?.observations ?? []).map((o) => `${o.variant}:${o.subject}`);
    // no CSP anywhere: the missing header is reported, the inert meta does not hide it
    expect(variants).toContain('header-missing:content-security-policy');
    expect(server.unexpected).toEqual([]);
  });

  it('counterexample: the same tags outside any inert element are the facts of the document', async () => {
    const http = await collectHttpOnly('www.metareal.test');
    const doc = start(http);
    expect(doc?.metaHttpEquiv.map((m) => m.name)).toEqual(['content-security-policy']);
    expect(doc?.metaReferrer).toBe('unsafe-url');
    const r = runCheck(hdr01, makeSnapshot({ target: makeTarget('http://www.metareal.test/'), http }));
    const variants = (r.outcome?.observations ?? []).map((o) => o.variant);
    expect(variants).toContain('referrer-policy-permissive');
    expect(server.unexpected).toEqual([]);
  });
});

/**
 * The longest gap between two ticks of a 10 ms timer while `run` works. A synchronous stall (a backtracking regular
 * expression) shows up as one big gap, past every deadline timer of the scan: the quadratic parsers took 7 s here.
 */
async function longestStall<T>(run: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    const value = await run();
    return { value, stallMs: Math.max(worst, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

describe('large meta values of the start document are read in linear time', () => {
  const STALL_LIMIT_MS = 1000;

  it('a refresh of 56 000 characters: stored cut and flagged, the loop is not held up', async () => {
    const { value: http, stallMs } = await longestStall(() => collectHttpOnly('www.metaredos-refresh.test'));
    expect(stallMs).toBeLessThan(STALL_LIMIT_MS);
    const refresh = start(http)?.metaHttpEquiv.find((m) => m.name === 'refresh');
    expect(refresh?.value.startsWith('0; url=http://www.metaredos-refresh.test/x%20%20')).toBe(true);
    expect(refresh?.truncated).toBe(true);
    expect(server.unexpected).toEqual([]);
  });

  it('a link of 56 000 opening brackets: stored cut and flagged, the loop is not held up', async () => {
    const { value: http, stallMs } = await longestStall(() => collectHttpOnly('www.metaredos-link.test'));
    expect(stallMs).toBeLessThan(STALL_LIMIT_MS);
    const link = start(http)?.metaHttpEquiv.find((m) => m.name === 'link');
    expect(link?.truncated).toBe(true);
    expect(link?.value.length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
    expect(server.unexpected).toEqual([]);
  });

  it('a referrer of 28 000 tokens: the loop is not held up, the keyword is kept and the filler is not', async () => {
    const { value: http, stallMs } = await longestStall(() => collectHttpOnly('www.metaredos-referrer.test'));
    expect(stallMs).toBeLessThan(STALL_LIMIT_MS);
    // Unrecognized `a` tokens must not enlarge the stored policy or hide its last recognized keyword.
    expect(start(http)?.metaReferrer).toBe('no-referrer');
    expect(server.unexpected).toEqual([]);
  });

  it('a referrer of 56 KB without any keyword stores nothing, so the snapshot does not grow with the tag', async () => {
    const http = await collectHttpOnly('www.metareferrer-junk.test');
    expect(start(http)?.metaReferrer).toBeNull();
    expect(JSON.stringify(http).length).toBeLessThan(20_000);
    expect(server.unexpected).toEqual([]);
  });

  it('a referrer of 54 KB of keywords stores the last eight, and HDR-01 reads the policy in force', async () => {
    const http = await collectHttpOnly('www.metareferrer-many.test');
    const stored = start(http)?.metaReferrer ?? '';
    expect(stored).toBe(`${Array(7).fill('no-referrer').join(', ')}, origin`);
    expect(JSON.stringify(http).length).toBeLessThan(20_000);
    const r = runCheck(
      hdr01,
      makeSnapshot({ target: makeTarget('http://www.metareferrer-many.test/'), http }),
    );
    const variants = (r.outcome?.observations ?? []).map((o) => `${o.variant}:${o.subject}`);
    // the policy in force is `origin`: neither a permissive one nor a missing one
    expect(variants).not.toContain('header-missing:referrer-policy');
    expect(variants.some((v) => v.startsWith('referrer-policy-permissive'))).toBe(false);
    expect(server.unexpected).toEqual([]);
  });

  it('ignores invalid http-equiv names and bounds the stored records', async () => {
    const http = await collectHttpOnly('www.metaequiv-junk.test');
    const doc = start(http);
    expect(JSON.stringify(http)).not.toContain('zq7');
    expect(doc?.metaHttpEquiv.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(http).length).toBeLessThan(20_000);
    // the record the check reads is still the first one
    expect(doc?.metaHttpEquiv[0]?.name).toBe('content-security-policy');
    expect(server.unexpected).toEqual([]);
  });

  it('counterexample: a refresh of the same shape and ordinary size is read as before', async () => {
    const http = await collectHttpOnly('www.metaval.test');
    expect(start(http)?.metaHttpEquiv.find((m) => m.name === 'refresh')?.value).toMatch(
      /^0; url=http:\/\/www\.metaval\.test\/next\?/,
    );
  });
});
