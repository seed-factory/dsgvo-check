/** Collector boundaries fail closed on unresolved destinations and redact setters and document headers.
 * Frame provenance, incomplete documents and writes after a CMP click remain observable. */
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { VerifyResult } from '../../../../src/cmp/types.ts';
import { combineVerify } from '../../../../src/collectors/browser/cmp-bridge.ts';
import { extractDocument } from '../../../../src/collectors/browser/documents.ts';
import type { RawDocument, RawStorage } from '../../../../src/collectors/browser/in-page.ts';
import { JarTracker, type Moment, mapCookie } from '../../../../src/collectors/browser/jar.ts';
import type { SetCookieOrigin } from '../../../../src/collectors/browser/recorder.ts';
import { blocks, hostClassifier, urlVerdict } from '../../../../src/collectors/browser/ssrf.ts';
import { snapshotResponseHeaders } from '../../../../src/collectors/browser/visit.ts';
import { defaultNetworkConfig, type Lookup } from '../../../../src/core/net.ts';

const target = { etld1: 'example.de', host: 'www.example.de' };
const pre: Moment = {
  phase: 'B',
  pageUrl: 'https://www.example.de/',
  tMs: 10,
  tRef: 'navigation',
  afterClick: false,
};
const post: Moment = { ...pre, tMs: 500, tRef: 'click', afterClick: true };

describe('SSRF guard: a name that does not resolve locally fails closed', () => {
  const failing: Lookup = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND metadata.internal'), { code: 'ENOTFOUND' });
  };

  it('lookup error → unresolved → blocked (a proxy could resolve the name to a private address)', async () => {
    const classify = hostClassifier({ ...defaultNetworkConfig(), lookup: failing });
    const v = await urlVerdict('http://metadata.internal/latest/', classify);
    expect(v).toBe('unresolved');
    expect(blocks(v)).toBe(true);
  });

  it('empty answer → blocked', async () => {
    const classify = hostClassifier({ ...defaultNetworkConfig(), lookup: async () => [] });
    expect(blocks(await urlVerdict('https://nodata.example.de/', classify))).toBe(true);
  });

  it('public and non-http(s) documents still pass', async () => {
    const classify = hostClassifier({
      ...defaultNetworkConfig(),
      lookup: async () => [{ address: '93.184.215.14', family: 4 }],
    });
    expect(blocks(await urlVerdict('https://www.example.de/', classify))).toBe(false);
    expect(blocks(await urlVerdict('about:blank', classify))).toBe(false);
  });

  it('a transient resolver error is retried once', async () => {
    let calls = 0;
    const lookup: Lookup = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
      return [{ address: '10.0.0.5', family: 4 }];
    };
    const classify = hostClassifier({ ...defaultNetworkConfig(), lookup });
    expect(await classify('intranet.example.test')).toBe('private');
    expect(calls).toBe(2);
  });

  it('a failed lookup is not cached: the next document to that host is classified again', async () => {
    let calls = 0;
    const lookup: Lookup = async () => {
      calls++;
      if (calls <= 2) throw new Error('getaddrinfo EAI_AGAIN');
      return [{ address: '10.0.0.5', family: 4 }];
    };
    const classify = hostClassifier({ ...defaultNetworkConfig(), lookup });
    expect(await classify('intranet.example.test')).toBe('unresolved');
    expect(await classify('intranet.example.test')).toBe('private');
  });
});

interface FakeState {
  cookies: Array<
    Pick<Cookie, 'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'>
  >;
  cookieWrites: Array<{ name: string; t: number; script: string | null; deletion: boolean }>;
  storage: RawStorage;
  storageWrites: Array<{ type: 'localStorage' | 'sessionStorage'; key: string; t: number }>;
}

function fakeBrowser(state: FakeState): { context: BrowserContext; page: Page } {
  const frame = {
    url: () => 'https://www.example.de/',
    evaluate: async (fn: (...a: unknown[]) => unknown) => {
      switch (fn.name) {
        case 'cookieWritesInPage':
          return state.cookieWrites.slice();
        case 'storageInPage':
          return state.storage;
        case 'storageWritesInPage':
          return state.storageWrites.slice();
        default:
          return null;
      }
    },
  };
  const page = { frames: () => [frame], mainFrame: () => frame } as unknown as Page;
  const context = { cookies: async () => state.cookies } as unknown as BrowserContext;
  return { context, page };
}

const emptyStorage = (): RawStorage => ({
  origin: 'https://www.example.de',
  local: [],
  session: [],
  idb: [],
});

const cookie = (name: string, value: string, expires: number) => ({
  name,
  value,
  domain: '.example.de',
  path: '/',
  expires,
  httpOnly: false,
  secure: true,
  sameSite: 'Lax' as const,
});

describe('cookie setter URLs are sanitized wherever a record is created', () => {
  it('attempted script cookie: the script URL keeps no query values', async () => {
    const state: FakeState = {
      cookies: [],
      cookieWrites: [
        {
          name: '_visitor',
          t: Date.now(),
          script: 'https://cdn.tracker.example/loader.js?account=A1&uid=u-4711&_=1730291234',
          deletion: false,
        },
      ],
      storage: emptyStorage(),
      storageWrites: [],
    };
    const { context, page } = fakeBrowser(state);
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(context, page, pre);
    jar.finalize(pre);
    const rec = jar.cookies.find((c) => c.name === '_visitor');
    expect(rec).toMatchObject({ state: 'attempted', setter: 'script', setterHost: 'cdn.tracker.example' });
    expect(rec?.setterUrl).toBe(
      'https://cdn.tracker.example/loader.js?account=[redacted]&uid=[redacted]&_=[redacted]',
    );
    expect(JSON.stringify(jar.cookies)).not.toMatch(/u-4711|A1|1730291234/);
  });

  it('mapCookie sanitizes a raw setter URL too', () => {
    const rec = mapCookie(cookie('_ga', 'GA1.1.SECRET', 2_000_000_000), pre, target, 1_800_000_000, {
      setter: 'script',
      setterHost: 'cdn.example.de',
      setterUrl: 'https://cdn.example.de/a.js?token=secret',
    });
    expect(rec.setterUrl).toBe('https://cdn.example.de/a.js?token=[redacted]');
  });
});

describe('response headers of documents are minimized before the snapshot', () => {
  const base = 'https://www.example.de/start?sid=abc';
  const raw = [
    { name: 'Content-Type', value: 'text/html; charset=utf-8' },
    { name: 'Location', value: '/next?token=secret1' },
    { name: 'Content-Location', value: 'https://www.example.de/x?token=secret2' },
    { name: 'Refresh', value: '0; url=/?sid=secret3' },
    { name: 'Link', value: '<https://cdn.example.de/app.css?token=secret4>; rel=preload; as=style' },
    {
      name: 'Content-Security-Policy',
      value: "default-src 'self'; report-uri https://r.example/csp?key=secret5",
    },
    { name: 'Strict-Transport-Security', value: 'max-age=31536000' },
    { name: 'x-amz-cf-id', value: 'secret6-per-request-id' },
    { name: 'traceparent', value: '00-secret7-01' },
    { name: 'Set-Cookie', value: 'sid=secret8; Path=/' },
  ];
  const headers = () => snapshotResponseHeaders(raw, base);
  const get = (n: string) => headers().find((h) => h.name === n)?.value;

  it('no query value, per-request id or cookie value survives', () => {
    const json = JSON.stringify(headers());
    for (const s of ['secret1', 'secret2', 'secret3', 'secret4', 'secret5', 'secret6', 'secret7', 'secret8'])
      expect(json).not.toContain(s);
  });

  it('URL-bearing headers are resolved and sanitized; security headers keep their value', () => {
    expect(get('location')).toBe('https://www.example.de/next?token=[redacted]');
    expect(get('content-location')).toBe('https://www.example.de/x?token=[redacted]');
    expect(get('refresh')).toBe('0; url=https://www.example.de/?sid=[redacted]');
    expect(get('link')).toBe('<https://cdn.example.de/app.css?token=[redacted]>; rel=preload; as=style');
    expect(get('content-security-policy')).toBe(
      "default-src 'self'; report-uri https://r.example/csp?key=[redacted]",
    );
    expect(get('strict-transport-security')).toBe('max-age=31536000');
    expect(get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('other headers are kept by name only (5.3: header `present`); Set-Cookie is not kept at all', () => {
    expect(get('x-amz-cf-id')).toBe('[redacted]');
    expect(get('traceparent')).toBe('[redacted]');
    expect(headers().some((h) => h.name === 'set-cookie')).toBe(false);
  });
});

function rawDoc(over: Partial<RawDocument>): RawDocument {
  return {
    lang: 'de',
    title: 'Datenschutzerklärung',
    h1: 'Datenschutzerklärung',
    parts: [],
    expandablesFound: 0,
    expandablesWithContent: 0,
    textLength: 0,
    truncated: false,
    ...over,
  };
}

function fakeDocPage(main: RawDocument, frames: Array<RawDocument | Error>): Page {
  const mainFrame = {
    url: () => 'https://www.example.de/datenschutz/',
    evaluate: async () => main,
  };
  const children = frames.map((f, i) => ({
    url: () => `https://www.example.de/frame-${i + 1}?sid=abc`,
    evaluate: async () => {
      if (f instanceof Error) throw f;
      return f;
    },
  }));
  return {
    url: () => 'https://www.example.de/datenschutz/',
    evaluate: async () => main,
    frames: () => [mainFrame, ...children],
    mainFrame: () => mainFrame,
  } as unknown as Page;
}

const POLICY = 'Wir verarbeiten personenbezogene Daten nach der DSGVO. '.repeat(20);
const docCtx = {
  id: 'doc-privacy-1',
  kind: 'privacy' as const,
  phase: 'A' as const,
  url: 'https://www.example.de/datenschutz/',
  foundVia: 'link' as const,
  status: 200,
  contentType: 'text/html; charset=utf-8',
};

describe('documents with same-origin frames', () => {
  it('hidden text inside a frame keeps origin hidden-irrelevant; the frame is recorded in frameUrl', async () => {
    const page = fakeDocPage(rawDoc({ parts: [{ section: '1', text: POLICY, origin: 'visible' }] }), [
      rawDoc({
        parts: [
          { section: 'Vorlage', text: 'Wir nutzen Google Analytics.', origin: 'hidden-irrelevant' },
          { section: 'Sichtbar', text: 'Kontaktformular.', origin: 'visible' },
        ],
      }),
    ]);
    const doc = await extractDocument(page, docCtx);
    const ga = doc.parts.find((p) => p.text.includes('Google Analytics'));
    expect(ga).toMatchObject({
      origin: 'hidden-irrelevant',
      frameUrl: 'https://www.example.de/frame-1?sid=[redacted]',
    });
    expect(doc.parts.find((p) => p.text === 'Kontaktformular.')).toMatchObject({ origin: 'frame' });
  });

  it('a truncated frame makes the document incomplete', async () => {
    const page = fakeDocPage(rawDoc({ parts: [{ section: '1', text: POLICY, origin: 'visible' }] }), [
      rawDoc({ parts: [{ section: '2', text: 'Teil im Frame.', origin: 'visible' }], truncated: true }),
    ]);
    const doc = await extractDocument(page, docCtx);
    expect(doc.complete).toBe(false);
    expect(doc.errors).toContain('truncated');
  });

  it('unopened expandables of a frame count in the manifest and make the document incomplete', async () => {
    const page = fakeDocPage(
      rawDoc({
        parts: [{ section: '1', text: POLICY, origin: 'visible' }],
        expandablesFound: 1,
        expandablesWithContent: 1,
      }),
      [
        rawDoc({
          parts: [{ section: '2', text: 'Akkordeon.', origin: 'visible' }],
          expandablesFound: 2,
          expandablesWithContent: 0,
        }),
      ],
    );
    const doc = await extractDocument(page, docCtx);
    expect(doc.manifest).toMatchObject({ expandablesFound: 3, expandablesOpened: 1, framesIncluded: 1 });
    expect(doc.errors).toContain('expand-failed');
    expect(doc.complete).toBe(false);
  });

  it('a same-origin frame that cannot be read makes the document incomplete', async () => {
    const page = fakeDocPage(rawDoc({ parts: [{ section: '1', text: POLICY, origin: 'visible' }] }), [
      new Error('frame.evaluate: Execution context was destroyed'),
    ]);
    const doc = await extractDocument(page, docCtx);
    expect(doc.errors).toContain('frame-unreadable');
    expect(doc.complete).toBe(false);
  });

  it('control: main document and a complete frame → complete', async () => {
    const page = fakeDocPage(rawDoc({ parts: [{ section: '1', text: POLICY, origin: 'visible' }] }), [
      rawDoc({ parts: [{ section: '2', text: 'Teil im Frame.', origin: 'visible' }] }),
    ]);
    const doc = await extractDocument(page, docCtx);
    expect(doc.errors).toEqual([]);
    expect(doc.complete).toBe(true);
  });
});

describe('writes after the click are recorded even when the key existed before', () => {
  it('cookies: a script write or a Set-Cookie after the click → an afterClick record for a known cookie', async () => {
    const clickAt = Date.now();
    const state: FakeState = {
      cookies: [
        cookie('_ga', 'GA1.1.111', 2_000_000_000),
        cookie('_fbp', 'fb.1.222', 2_000_000_000),
        cookie('_gid', 'GA1.1.333', 2_000_000_000),
        cookie('pref', 'de', 2_000_000_000),
        cookie('_late', 'L.1', 2_000_000_000),
      ],
      cookieWrites: [
        { name: '_ga', t: clickAt - 5_000, script: null, deletion: false },
        { name: '_fbp', t: clickAt - 5_000, script: null, deletion: false },
      ],
      storage: emptyStorage(),
      storageWrites: [],
    };
    const { context, page } = fakeBrowser(state);
    // The `Set-Cookie` after the click arrives as a recorder origin flagged `afterClick` (per name, domain,
    // path and partition, not by name alone).
    const origins = new Map<string, SetCookieOrigin>();
    const jar = new JarTracker(target, origins);
    await jar.snapshot(context, page, pre);
    jar.markClick(clickAt);
    // After the reject: _ga re-set by script with a new value, _fbp re-written by script with the same value, _gid
    // re-sent by the server; pref untouched; _late written by script BEFORE the click (seen only now).
    state.cookies = [
      cookie('_ga', 'GA1.1.999', 2_000_000_500),
      cookie('_fbp', 'fb.1.222', 2_000_000_000),
      cookie('_gid', 'GA1.1.333', 2_000_000_000),
      cookie('pref', 'de', 2_000_000_000),
      cookie('_late', 'L.2', 2_000_000_000),
    ];
    state.cookieWrites.push(
      { name: '_ga', t: clickAt + 50, script: null, deletion: false },
      { name: '_fbp', t: clickAt + 60, script: null, deletion: false },
      { name: '_late', t: clickAt - 10, script: null, deletion: false },
    );
    origins.set('_gid|example.de|/|', {
      name: '_gid',
      host: 'www.example.de',
      domain: 'example.de',
      url: 'https://www.example.de/',
      path: '/',
      partitioned: false,
      at: 1,
      afterClick: true,
    });
    await jar.snapshot(context, page, post);
    const flags = (n: string) => jar.cookies.filter((c) => c.name === n).map((c) => c.afterClick);
    expect(flags('_ga')).toEqual([false, true]);
    expect(flags('_fbp')).toEqual([false, true]);
    expect(flags('_gid')).toEqual([false, true]);
    expect(flags('pref')).toEqual([false]);
    expect(flags('_late')).toEqual([false]);
    expect(jar.cookies.find((c) => c.name === '_ga' && c.afterClick)).toMatchObject({
      tRef: 'click',
      state: 'accepted',
    });
    // A later snapshot does not add a third record.
    await jar.snapshot(context, page, { ...post, tMs: 900 });
    expect(flags('_ga')).toEqual([false, true]);
    expect(JSON.stringify(jar.cookies)).not.toMatch(/GA1\.1|fb\.1/);
  });

  it('storage: a key written again after the click → an afterClick record', async () => {
    const clickAt = Date.now();
    const state: FakeState = {
      cookies: [],
      cookieWrites: [],
      storage: {
        ...emptyStorage(),
        local: [
          { key: '_ga4_session', length: 20 },
          { key: 'theme', length: 4 },
        ],
      },
      storageWrites: [{ type: 'localStorage', key: '_ga4_session', t: clickAt - 1_000 }],
    };
    const { context, page } = fakeBrowser(state);
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(context, page, pre);
    jar.markClick(clickAt);
    state.storageWrites.push({ type: 'localStorage', key: '_ga4_session', t: clickAt + 20 });
    await jar.snapshot(context, page, post);
    const flags = (k: string) => jar.storage.filter((s) => s.key === k).map((s) => s.afterClick);
    expect(flags('_ga4_session')).toEqual([false, true]);
    expect(flags('theme')).toEqual([false]);
  });

  it('control: without a click nothing is duplicated', async () => {
    const state: FakeState = {
      cookies: [cookie('_ga', 'GA1.1.111', 2_000_000_000)],
      cookieWrites: [],
      storage: emptyStorage(),
      storageWrites: [],
    };
    const { context, page } = fakeBrowser(state);
    const jar = new JarTracker(target, new Map());
    await jar.snapshot(context, page, pre);
    state.cookies = [cookie('_ga', 'GA1.1.222', 2_000_000_100)];
    await jar.snapshot(context, page, { ...pre, tMs: 900 });
    expect(jar.cookies.filter((c) => c.name === '_ga')).toHaveLength(1);
  });
});

describe('verification of the reject before and after the reload', () => {
  const v = (verified: boolean, method: string[]): VerifyResult => ({
    action: 'reject',
    verified,
    method,
    stateAfter: [{ source: 'api', ready: 'ready', categories: {}, origin: verified ? 'stored' : 'action' }],
    persistedAfterReload: null,
  });

  it('not confirmed right after the click, confirmed after the reload → verified, with a limitation marker', () => {
    const out = combineVerify(v(false, ['api:not-all-denied']), v(true, ['api:all-denied']));
    expect(out).toMatchObject({ verified: true, persistedAfterReload: true });
    expect(out?.method).toContain('verified-after-reload-only');
  });

  it('confirmed right after the click and after the reload → verified, persisted', () => {
    const out = combineVerify(v(true, ['api:all-denied']), v(true, ['api:all-denied']));
    expect(out).toMatchObject({ verified: true, persistedAfterReload: true });
    expect(out?.method).not.toContain('verified-after-reload-only');
  });

  it('confirmed after the click but lost after the reload → persistedAfterReload false', () => {
    expect(combineVerify(v(true, ['api:all-denied']), v(false, []))).toMatchObject({
      verified: true,
      persistedAfterReload: false,
    });
  });

  it('no reload result → persistence unknown; nothing at all → undefined', () => {
    expect(combineVerify(v(false, []), null)).toMatchObject({ verified: false, persistedAfterReload: null });
    expect(combineVerify(null, null)).toBeUndefined();
  });
});
