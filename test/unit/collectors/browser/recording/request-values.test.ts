/**
 * A page can send any request to any host with any method and any parameters. Its record keeps the method only from
 * the standard set, the event name only as a GA4 or Meta event name and the Consent Mode signals only in the forms the
 * tags send. Markers start with `zq8`.
 */
import type { Request } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { extractRequestFeatures } from '../../../../../src/collectors/browser/recording/features.ts';
import { fakeRecorder, fakeRequest, START } from '../fakes.ts';

describe('event names and Consent Mode signals', () => {
  it.each([
    ['https://t.example.net/c?en=alice@example.com', null],
    ['https://t.example.net/c?ev=4f3a9c1d2e7b8a9f0c1d', null],
    ['https://t.example.net/c', 'en=zq8%20secret&ev=zq8-4f3a9c1d'],
    ['https://t.example.net/c', 'en=qx7k2m9q4w8e1r5t3'],
  ])('%s with body %j has no event type', (url, body) => {
    expect(extractRequestFeatures(url, body).eventType).toBeUndefined();
  });

  it('the first valid event name wins over a value of another form', () => {
    const f = extractRequestFeatures('https://t.example.net/c?en=zq8.4f3a9c1d', 'en=page_view');
    expect(f.eventType).toBe('page_view');
  });

  it('signals of another form are dropped one by one, those of the tag form stay', () => {
    const f = extractRequestFeatures(
      'https://www.google-analytics.com/g/collect?gcs=4f3a9c1d2e7b-consent&npa=zq8SECRET&gcd=13l3l3l3l1&dma=0',
      null,
    );
    expect(f.consentSignals).toEqual({ gcd: '13l3l3l3l1', dma: '0' });
  });

  it('a body of signals in another form gives none', () => {
    const f = extractRequestFeatures('https://t.example.net/c', 'gcs=zq8&gcd=zq8&npa=2&dma=yes');
    expect(f.consentSignals).toBeUndefined();
  });
});

describe('request methods', () => {
  const withMethod = (method: string): Request =>
    ({
      ...fakeRequest('https://www.example.de/x', { type: 'fetch' }),
      method: () => method,
    }) as unknown as Request;

  it.each([
    ['POST', 'POST'],
    ['PATCH', 'PATCH'],
    ['X-4f3a9c1d2e7b8a9f', 'OTHER'],
  ])('fetch with method %j is recorded as %j', async (method, recorded) => {
    const { ctx, rec } = fakeRecorder({ start: START });
    ctx.emit('request', withMethod(method));
    await rec.flush();
    expect(rec.records.map((r) => r.method)).toEqual([recorded]);
  });
});
