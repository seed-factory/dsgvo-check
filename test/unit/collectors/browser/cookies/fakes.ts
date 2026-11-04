/**
 * Fakes of Playwright pages, frames, contexts, requests and responses for the pure (no browser) tests of the
 * recorder and the jar: a page answers the in-page reads by function name, a recorder is fed `Set-Cookie` lines.
 */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Cookie, Page, Request, Response } from 'playwright-core';
import type { Moment } from '../../../../../src/collectors/browser/recording/jar.ts';
import { NetworkRecorder } from '../../../../../src/collectors/browser/recording/recorder.ts';

export const target = { etld1: 'example.de', host: 'www.example.de' };
export const START = 'https://www.example.de/';
export const moment: Moment = {
  phase: 'A',
  pageUrl: START,
  tMs: 10,
  tRef: 'navigation',
  afterClick: false,
};

interface FakeFrameSpec {
  url: string;
  cookieWrites?: Array<Record<string, unknown>>;
  /** evaluate never settles (a PDF viewer or a wedged frame). */
  hang?: boolean;
  /** Index of the parent frame in the list (`about:blank` and `about:srcdoc` frames inherit its origin). */
  parent?: number;
}

interface FakeFrame {
  url: () => string;
  parentFrame: () => FakeFrame | null;
  evaluate: (fn: (...a: unknown[]) => unknown) => Promise<unknown>;
}

export function fakePage(frames: FakeFrameSpec[]): Page {
  const list: FakeFrame[] = frames.map((f) => ({
    url: () => f.url,
    parentFrame: () => (f.parent === undefined ? null : (list[f.parent] ?? null)),
    evaluate: (fn: (...a: unknown[]) => unknown): Promise<unknown> => {
      if (f.hang) return new Promise(() => undefined);
      switch (fn.name) {
        case 'cookieWritesInPage':
          return Promise.resolve((f.cookieWrites ?? []).slice());
        case 'storageInPage':
          return Promise.resolve({
            origin: /^https?:/.test(f.url) ? new URL(f.url).origin : 'null',
            local: [],
            session: [],
            idb: [],
          });
        case 'storageWritesInPage':
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    },
  }));
  return { frames: () => list, mainFrame: () => list[0] } as unknown as Page;
}

export type JarCookie = Pick<
  Cookie,
  'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'
> & { partitionKey?: string };

export const jarCookie = (name: string, domain: string, o: Partial<JarCookie> = {}): JarCookie => ({
  name,
  value: 'SECRET_VALUE',
  domain,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: true,
  sameSite: 'None',
  ...o,
});

export const fakeContext = (cookies: JarCookie[]): BrowserContext =>
  ({ cookies: async () => cookies }) as unknown as BrowserContext;

export function fakeRequest(url: string, type = 'image'): Request {
  const frame = { parentFrame: () => null, url: () => START };
  return {
    url: () => url,
    postData: () => null,
    serviceWorker: () => null,
    frame: () => frame,
    isNavigationRequest: () => false,
    redirectedFrom: () => null,
    method: () => 'GET',
    resourceType: () => type,
    failure: () => null,
    allHeaders: async () => ({}),
  } as unknown as Request;
}

export function fakeResponse(req: Request, setCookie: string[], o: Partial<Response> = {}): Response {
  return {
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    headersArray: async () => setCookie.map((value) => ({ name: 'Set-Cookie', value })),
    serverAddr: async () => ({ ipAddress: '93.184.215.14', port: 443 }),
    ...o,
  } as unknown as Response;
}

/** A recorder fed with `Set-Cookie` responses: [response URL, Set-Cookie header lines]. */
export async function recorded(
  responses: Array<[string, string[]]>,
  options?: ConstructorParameters<typeof NetworkRecorder>[5],
) {
  const ctx = new EventEmitter();
  const counter = { limit: 2000, issued: 0, truncated: false };
  const rec = new NetworkRecorder('A', 'example.de', counter, false, undefined, options);
  rec.attach(ctx as unknown as BrowserContext);
  rec.beginNavigation(START);

  for (const [url, lines] of responses) {
    const req = fakeRequest(url);
    ctx.emit('request', req);
    ctx.emit('response', fakeResponse(req, lines));
  }
  await rec.flush();

  return rec;
}
