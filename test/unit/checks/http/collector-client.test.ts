/** Pure parts of the HTTP/TLS collectors: header redaction, outcome mapping, pacing, host variants. */
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeBody,
  HostPacer,
  outcomeOf,
  retryAfterMs,
  snapshotHeaders,
} from '../../../../src/collectors/http/client.ts';
import { hostVariants } from '../../../../src/collectors/http/index.ts';

describe('snapshotHeaders', () => {
  it('keeps names only for Set-Cookie and redacts query values in Location', () => {
    const out = snapshotHeaders({
      'Set-Cookie': ['PHPSESSID=abc123; Path=/; HttpOnly', '_pref=xyz; Max-Age=60'],
      Location: 'https://www.example.de/login?session=abc123&id=G-123',
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Multi': ['a', 'b'],
    });
    expect(out.setCookieNames).toEqual(['PHPSESSID', '_pref']);
    expect(out.headers).toEqual([
      { name: 'location', value: 'https://www.example.de/login?session=[redacted]&id=G-123' },
      { name: 'strict-transport-security', value: 'max-age=31536000' },
      { name: 'x-multi', value: '[redacted]' },
      { name: 'x-multi', value: '[redacted]' },
    ]);
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

  it('same normalizer as the browser — URL headers sanitized, values only for security headers', () => {
    const out = snapshotHeaders(
      {
        Refresh: '0; url=/next?token=s3cret',
        Link: '<https://cdn.example.de/a.css?sig=s3cret>; rel=preload',
        'Content-Location': '/doc?sid=s3cret',
        'X-Amz-Cf-Id': 'req-s3cret',
        Traceparent: '00-s3cret-01',
        'Content-Security-Policy': "default-src 'self'; report-uri https://r.example.de/csp?key=s3cret",
        'Retry-After': '120',
      },
      'https://www.example.de/start',
    );
    expect(out.headers).toEqual([
      { name: 'refresh', value: '0; url=https://www.example.de/next?token=[redacted]' },
      { name: 'link', value: '<https://cdn.example.de/a.css?sig=[redacted]>; rel=preload' },
      { name: 'content-location', value: 'https://www.example.de/doc?sid=[redacted]' },
      { name: 'x-amz-cf-id', value: '[redacted]' },
      { name: 'traceparent', value: '[redacted]' },
      {
        name: 'content-security-policy',
        value: "default-src 'self'; report-uri https://r.example.de/csp?key=[redacted]",
      },
      { name: 'retry-after', value: '120' },
    ]);
    expect(JSON.stringify(out)).not.toContain('s3cret');
  });
});

describe('decodeBody (the decoded size is bounded)', () => {
  const MiB = 1024 * 1024;
  const zeros = Buffer.alloc(64 * MiB);
  const bombs: Array<[string, Buffer]> = [
    ['gzip', zlib.gzipSync(zeros)],
    ['deflate', zlib.deflateSync(zeros)],
    ['br', zlib.brotliCompressSync(zeros)],
  ];

  it.each(bombs)('%s bomb: output stops at the limit and is marked truncated', async (enc, compressed) => {
    expect(compressed.length).toBeLessThan(512 * 1024);
    const out = await decodeBody(compressed, enc, MiB);
    expect(out.body.length).toBe(MiB);
    expect(out.truncated).toBe(true);
  });

  it.each(['gzip', 'deflate', 'br'])('%s within the limit: decoded completely', async (enc) => {
    const text = Buffer.from('<html><body>Hallo</body></html>'.repeat(100));
    const compressed =
      enc === 'gzip'
        ? zlib.gzipSync(text)
        : enc === 'deflate'
          ? zlib.deflateSync(text)
          : zlib.brotliCompressSync(text);
    const out = await decodeBody(compressed, enc, MiB);
    expect(out.body.equals(text)).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it('a cut compressed stream yields the decodable prefix', async () => {
    const text = Buffer.from('abcdefghij'.repeat(10_000));
    const gz = zlib.gzipSync(text);
    const out = await decodeBody(gz.subarray(0, Math.floor(gz.length / 2)), 'gzip', MiB);
    expect(out.body.length).toBeGreaterThan(0);
    expect(text.subarray(0, out.body.length).equals(out.body)).toBe(true);
  });

  it('identity: the body is passed through (and cut at the limit)', async () => {
    expect((await decodeBody(Buffer.from('abc'), null, 10)).body.toString()).toBe('abc');
    expect(await decodeBody(Buffer.from('abcdef'), 'identity', 4)).toMatchObject({ truncated: true });
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  it.each([
    ['60', 60_000],
    [' 0 ', 0],
    ['Fri, 30 Oct 2026 12:00:10 GMT', 10_000],
    ['Fri, 30 Oct 2026 11:00:00 GMT', 0],
    ['soon', null],
    ['', null],
    [null, null],
  ] as const)('%j → %j', (value, ms) => {
    expect(retryAfterMs(value, now)).toBe(ms);
  });
});

describe('outcomeOf', () => {
  it.each([
    ['ECONNREFUSED', 'connection-refused'],
    ['ENOTFOUND', 'dns-error'],
    ['EAI_AGAIN', 'dns-error'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['TimeoutError', 'timeout'],
    ['aborted', 'timeout'],
    ['throttled', 'throttled'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls-error'],
    ['EPROTO', 'tls-error'],
    ['ECONNRESET', 'error'],
    ['private-address', 'error'],
  ])('%s → %s', (code, outcome) => {
    expect(outcomeOf(code)).toBe(outcome);
  });
});

/**
 * Virtual time for the pacer: `sleep` registers a timer, `run` fires the timers in order; `lateBy[n]` makes the n-th
 * sleep wake up that many ms late (a blocked event loop, a busy machine).
 */
function virtualClock(lateBy: number[] = []) {
  let time = 1_000;
  let sleeps = 0;
  const timers: Array<{ at: number; wake: () => void }> = [];
  const clock = {
    now: () => time,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: time + ms + (lateBy[sleeps++] ?? 0), wake: resolve });
      }),
  };
  const settle = () => new Promise<void>((r) => setImmediate(r));
  async function run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const result = work.finally(() => {
      done = true;
    });
    await settle();
    while (!done) {
      const next = timers.sort((a, b) => a.at - b.at).shift();
      if (!next) throw new Error('pacer waits for a timer that does not exist');
      time = Math.max(time, next.at);
      next.wake();
      await settle();
    }
    return result;
  }
  return { clock, run };
}

describe('HostPacer', () => {
  it('spaces request starts per host, hosts are independent', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(60, clock);
    const starts: Record<string, number[]> = { a: [], b: [] };
    const request = async (host: string) => {
      await pacer.wait(host);
      starts[host]?.push(clock.now());
    };
    await run(Promise.all([request('a'), request('a'), request('a'), request('b')]));
    expect(starts).toEqual({ a: [1_000, 1_060, 1_120], b: [1_000] });
  });

  it('a late wake-up does not shrink the gap to the next start (slots follow the real start, not the plan)', async () => {
    // Three requests are queued at once; the wake-up of the second is 30 ms late, the third is on time.
    const { clock, run } = virtualClock([30]);
    const pacer = new HostPacer(500, clock);
    const starts: number[] = [];
    const request = async () => {
      await pacer.wait('a');
      starts.push(clock.now());
    };
    await run(Promise.all([request(), request(), request(), request()]));
    expect(starts).toEqual([1_000, 1_530, 2_030, 2_530]);
    for (let i = 1; i < starts.length; i++)
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(500);
  });

  it('a request that arrives after a late start waits for the full gap as well', async () => {
    const { clock, run } = virtualClock([30]);
    const pacer = new HostPacer(500, clock);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await run(pacer.wait('a'));
      starts.push(clock.now());
    }
    expect(starts).toEqual([1_000, 1_530, 2_030]);
  });

  it('uses the real clock by default', async () => {
    const pacer = new HostPacer(30);
    await pacer.wait('a');
    const t0 = performance.now();
    await pacer.wait('a');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it('defer: the next start to that host waits for the pause (Retry-After), other hosts do not', async () => {
    const sleeps: Array<[string, number]> = [];
    let host = '';
    const pacer = new HostPacer(60, {
      now: () => 1_000,
      sleep: async (ms) => {
        sleeps.push([host, ms]);
      },
    });
    pacer.defer('a', 5_000);
    host = 'a';
    await pacer.wait('a');
    host = 'b';
    await pacer.wait('b');
    expect(sleeps).toEqual([['a', 5_000]]);
  });

  it('aborts a pending wait', async () => {
    const pacer = new HostPacer(10_000);
    await pacer.wait('a');
    const ac = new AbortController();
    const p = pacer.wait('a', ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('hostVariants', () => {
  it.each([
    ['www.example.de', 'example.de', ['target:www.example.de', 'apex:example.de']],
    ['example.de', 'example.de', ['target:example.de', 'www:www.example.de']],
    ['shop.example.de', 'example.de', ['target:shop.example.de', 'www:www.example.de', 'apex:example.de']],
    ['203.0.113.10', null, ['target:203.0.113.10']],
  ])('%s → %j', (host, etld1, expected) => {
    expect(hostVariants(host, etld1).map((t) => `${t.hostVariant}:${t.host}`)).toEqual(expected);
  });
});
