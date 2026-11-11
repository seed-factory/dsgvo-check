/** Bot and WAF challenges the HTTP probe recognises by the header signatures of test/data/browser/challenges.yaml. */
import { describe, expect, it } from 'vitest';
import { challengesSection } from '../../../../src/collectors/browser/rules.ts';
import { httpChallenge } from '../../../../src/collectors/http/challenge.ts';
import { snapshotHeaders } from '../../../../src/collectors/http/response-head.ts';

/** A response as the client hands it over: stored records and the names of headers sent empty. */
const response = (status: number, raw: Record<string, string>) => ({ status, ...snapshotHeaders(raw) });

describe('httpChallenge', () => {
  it.each([
    [
      'Vercel challenge (429)',
      429,
      { 'X-Vercel-Mitigated': 'challenge' },
      'waf-block',
      ['header:x-vercel-mitigated'],
    ],
    ['Vercel deny (403)', 403, { 'x-vercel-mitigated': 'deny' }, 'waf-block', ['header:x-vercel-mitigated']],
    ['Cloudflare', 403, { 'cf-mitigated': 'challenge' }, 'cloudflare', ['header:cf-mitigated']],
    ['DataDome with its status, value empty', 403, { 'x-datadome': '' }, 'captcha', ['header:x-datadome']],
  ] as const)('%s', (_, status, raw, kind, signals) => {
    expect(httpChallenge(response(status, raw))).toEqual({ kind, signals: [...signals] });
  });

  it.each([
    ['a header sent without a value', 403, { 'cf-mitigated': '' }],
    ['DataDome on a page that was delivered', 200, { 'x-datadome': 'protected' }],
    ['a 429 without a signature (plain rate limit)', 429, { 'retry-after': '30' }],
    ['an ordinary page', 200, { 'content-type': 'text/html' }],
  ] as const)('counterexample: %s', (_, status, raw) => {
    expect(httpChallenge(response(status, raw))).toBeNull();
  });

  it('the redacted stored value does not hide an empty header', () => {
    const r = response(403, { 'cf-mitigated': '' });
    expect(r.headers).toEqual([{ name: 'cf-mitigated', value: '[redacted]' }]);
    expect(r.blankHeaderNames).toEqual(['cf-mitigated']);
  });

  it('a header sent twice, once with a value, is not blank', () => {
    const r = { status: 403, ...snapshotHeaders({ 'cf-mitigated': ['', 'challenge'] }) };
    expect(r.blankHeaderNames).toEqual([]);
    expect(httpChallenge(r)?.signals).toEqual(['header:cf-mitigated']);
  });

  it('the signatures are data', () => {
    const rules = challengesSection.parse({
      challenges: {
        headers: [{ name: 'x-shield', kind: 'waf-block', signal: 'header:x-shield', status: 429 }],
        scripts: [],
        titles: [],
        texts: [],
      },
    });
    expect(httpChallenge(response(429, { 'x-shield': '1' }), rules)?.signals).toEqual(['header:x-shield']);
    expect(httpChallenge(response(429, { 'x-vercel-mitigated': 'challenge' }), rules)).toBeNull();
  });
});
