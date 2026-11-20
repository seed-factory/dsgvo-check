import type { Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { visitPage } from '../../../../src/collectors/browser/pages/visit.ts';
import { NetworkRecorder } from '../../../../src/collectors/browser/recording/recorder.ts';
import { useFixtureServer } from '../../../fixture-server/use-fixture-server.ts';
import { launchTestBrowser } from '../../../utils/browser.ts';
import { FAST_TIMING } from '../helpers.ts';

const HOST = 'navigation.example.test';
const ORIGIN = `https://${HOST}`;
const redirect =
  '<script>addEventListener("load", () => setTimeout(() => location.href = "/final", 80))</script>';
const reload = '<script>addEventListener("load", () => setTimeout(() => location.reload(), 80))</script>';
const INITIAL = '<title>Initial document</title>';
const FINAL = '<title>Final document</title>';
const initialHeaders = { 'content-type': 'text/html', 'set-cookie': 'initial_cookie=sample' };
const finalHeaders = {
  'content-type': 'text/html',
  'set-cookie': 'final_cookie=sample',
  'retry-after': '5',
  'x-vercel-mitigated': 'challenge',
};
const server = useFixtureServer(() => {
  const loads = new Map<string, number>();
  return {
    routes: [
      { host: HOST, path: '/start', headers: initialHeaders, body: INITIAL + redirect },
      { host: HOST, path: '/plain', headers: initialHeaders, body: INITIAL },
      { host: HOST, path: '/final', status: 429, headers: finalHeaders, body: FINAL },
      {
        host: HOST,
        path: '/spa',
        headers: initialHeaders,
        body: `${INITIAL}<script>history.pushState({}, "", "/spa-view")</script>`,
      },
    ],
    handlers: [
      {
        host: HOST,
        path: /^\/(reload|no-content)$/,
        handle(_req, res, { url }) {
          const count = (loads.get(url.pathname) ?? 0) + 1;
          loads.set(url.pathname, count);
          if (count === 1) {
            res.writeHead(200, initialHeaders);
            res.end(INITIAL + reload);
          } else if (url.pathname === '/reload') {
            res.writeHead(429, finalHeaders);
            res.end(FINAL);
          } else {
            res.writeHead(204, finalHeaders);
            res.end();
          }
        },
      },
    ],
  };
});

async function visit(path: string, prepare?: (page: Page) => void) {
  const browser = await launchTestBrowser(server());
  const recorder = new NetworkRecorder(
    'A',
    'example.test',
    { limit: 100, issued: 0, truncated: false },
    false,
  );
  recorder.attach(browser.context);
  try {
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    prepare?.(page);
    const result = await visitPage(
      {
        page,
        recorder,
        timing: FAST_TIMING,
        phaseTiming: { minDwellMs: 400, hardCapMs: 1_500 },
        signal: new AbortController().signal,
        target: { etld1: 'example.test', host: HOST },
        now: () => new Date(),
      },
      { rawUrl: ORIGIN + path, role: 'start', order: 0, phase: 'A', firstVisit: true },
    );
    expect(server().unexpected).toEqual([]);
    return { result, requests: recorder.records };
  } finally {
    recorder.dispose();
    await browser.close();
  }
}

it.each([
  ['a JavaScript redirect', '/start', '/final'],
  ['a same-URL reload', '/reload', '/reload'],
])('uses the final response with the DOM after %s', async (_name, path, finalPath) => {
  const { result } = await visit(path);
  expect(result).toMatchObject({
    retryAfterMs: 5_000,
    visit: {
      finalUrl: ORIGIN + finalPath,
      navigation: { status: 429, ok: false },
      challenge: { detected: true, kind: 'waf-block', signals: ['header:x-vercel-mitigated'] },
      evaluable: false,
      notEvaluableReason: 'challenge',
      dom: { title: 'Final document' },
      setCookieNames: ['final_cookie'],
    },
  });
});

it('keeps the document response when the app changes the URL in place', async () => {
  const { result } = await visit('/spa');
  expect(result.visit).toMatchObject({
    finalUrl: `${ORIGIN}/spa-view`,
    navigation: { status: 200, ok: true },
    evaluable: true,
    dom: { title: 'Initial document' },
    setCookieNames: ['initial_cookie'],
  });
});

it('keeps the committed response when a same-URL navigation has no document', async () => {
  const { result, requests } = await visit('/no-content');
  expect(requests.filter((r) => r.isNavigation).map((r) => r.status)).toEqual([200, 204]);
  expect(result.visit).toMatchObject({
    finalUrl: `${ORIGIN}/no-content`,
    navigation: { status: 200, ok: true },
    evaluable: true,
    dom: { title: 'Initial document' },
    setCookieNames: ['initial_cookie'],
  });
  expect(result.retryAfterMs).toBeUndefined();
});

it('reads a matching response and DOM when navigation commits during the DOM read', async () => {
  let redirected = false;
  const { result } = await visit('/plain', (page) => {
    const evaluate = page.evaluate.bind(page);
    vi.spyOn(page, 'evaluate').mockImplementation(async (fn, arg) => {
      const value = await evaluate(fn, arg);
      if (
        !redirected &&
        value &&
        typeof value === 'object' &&
        'title' in value &&
        value.title === 'Initial document'
      ) {
        redirected = true;
        await page.goto(`${ORIGIN}/final`, { waitUntil: 'load' });
      }
      return value;
    });
  });
  expect(redirected).toBe(true);
  expect(result.visit).toMatchObject({
    finalUrl: `${ORIGIN}/final`,
    navigation: { status: 429, ok: false },
    challenge: { detected: true, kind: 'waf-block', signals: ['header:x-vercel-mitigated'] },
    evaluable: false,
    dom: { title: 'Final document' },
    setCookieNames: ['final_cookie'],
  });
});
