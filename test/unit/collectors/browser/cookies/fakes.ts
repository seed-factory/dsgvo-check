/**
 * Fakes of Playwright pages, frames, contexts, requests and responses for the pure (no browser) tests of the
 * recorder and the jar: a page answers the in-page reads by function name, a recorder is fed `Set-Cookie` lines.
 */
import { EventEmitter } from 'node:events';
import type { BrowserContext, Cookie, Page, Request, Response } from 'playwright-core';
import { JarTracker, type Moment } from '../../../../../src/collectors/browser/recording/jar.ts';
import {
  NetworkRecorder,
  type RecorderOptions,
  type RequestCounter,
  type ScanClock,
  type SetCookieOrigin,
} from '../../../../../src/collectors/browser/recording/recorder.ts';
import type { BrowserPhase } from '../../../../../src/core/snapshot/common.ts';

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

interface PageFrame {
  url: () => string;
  parentFrame: () => PageFrame | null;
  evaluate: (fn: (...a: unknown[]) => unknown) => Promise<unknown>;
}

export function fakePage(frames: FakeFrameSpec[]): Page {
  const list: PageFrame[] = frames.map((f) => ({
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

/** The jar of `target` after one snapshot of the page `frames` and the jar `cookies` at `moment`, not finalized. */
export async function jarOf(
  frames: FakeFrameSpec[],
  cookies: JarCookie[] = [],
  origins: ReadonlyMap<string, SetCookieOrigin> = new Map(),
) {
  const jar = new JarTracker(target, origins);
  await jar.snapshot(fakeContext(cookies), fakePage(frames), moment);
  return jar;
}

/** The frame of a request. The recorder reads its URL only for subframes and knows the main frame by identity. */
export interface FakeFrame {
  parentFrame: () => FakeFrame | null;
  url: () => string;
}

export const fakeFrame = (parent: FakeFrame | null = null, url = START): FakeFrame => ({
  parentFrame: () => parent,
  url: () => url,
});

export interface FakeRequestSpec {
  /** Without it the request gets a frame of its own: pass one object where the main frame must stay the same. */
  frame?: FakeFrame;
  nav?: boolean;
  from?: Request;
  type?: string;
  failure?: string;
  allHeaders?: () => Promise<Record<string, string>>;
}

export function fakeRequest(url: string, o: FakeRequestSpec = {}): Request {
  const frame = o.frame ?? fakeFrame();
  return {
    url: () => url,
    postData: () => null,
    serviceWorker: () => null,
    frame: () => frame,
    isNavigationRequest: () => o.nav ?? false,
    redirectedFrom: () => o.from ?? null,
    method: () => 'GET',
    resourceType: () => o.type ?? 'image',
    failure: () => (o.failure ? { errorText: o.failure } : null),
    allHeaders: o.allHeaders ?? (async () => ({})),
  } as unknown as Request;
}

export function fakeResponse(req: Request, setCookie: string[] = [], o: Partial<Response> = {}): Response {
  return {
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    headersArray: async () => setCookie.map((value) => ({ name: 'Set-Cookie', value })),
    serverAddr: async () => ({ ipAddress: '93.184.215.14', port: 443 }),
    ...o,
  } as unknown as Response;
}

export interface FakeRecorderSpec {
  phase?: BrowserPhase;
  etld1?: string;
  counter?: RequestCounter;
  clock?: ScanClock;
  options?: RecorderOptions;
  /** The navigation to this URL has begun. */
  start?: string;
}

/**
 * A recorder attached to a fake context. `respond` emits a request and its response with `Set-Cookie` lines, `send`
 * also waits for the handlers (one request at a time, like the collector).
 */
export function fakeRecorder(o: FakeRecorderSpec = {}) {
  const { phase = 'A', etld1 = target.etld1, clock, options } = o;
  const ctx = new EventEmitter();
  const counter = o.counter ?? { limit: 2000, issued: 0, truncated: false };
  const rec = new NetworkRecorder(phase, etld1, counter, false, clock, options);
  rec.attach(ctx as unknown as BrowserContext);
  if (o.start) rec.beginNavigation(o.start);

  const respond = (url: string, lines: string[]) => {
    const req = fakeRequest(url);
    ctx.emit('request', req);
    ctx.emit('response', fakeResponse(req, lines));
  };
  const send = async (url: string, lines: string[]) => {
    respond(url, lines);
    await rec.flush();
  };
  return { ctx, rec, respond, send };
}

/** A recorder fed with `Set-Cookie` responses: [response URL, Set-Cookie header lines]. */
export async function recorded(responses: Array<[string, string[]]>, options?: RecorderOptions) {
  const { rec, respond } = fakeRecorder({ options, start: START });
  for (const [url, lines] of responses) respond(url, lines);
  await rec.flush();
  return rec;
}
