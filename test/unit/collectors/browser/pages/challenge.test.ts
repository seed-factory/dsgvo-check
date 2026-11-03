/** WAF / challenge detection on a navigated page (pure): WAF, challenge or 403 → SCAN-BLOCKED. */
import { describe, expect, it } from 'vitest';
import { detectChallenge } from '../../../../../src/collectors/browser/pages/challenge.ts';

const base = {
  status: 200,
  headers: [],
  title: 'Beispiel GmbH',
  text: 'Willkommen bei uns. '.repeat(50),
  scripts: [],
};

describe('detectChallenge', () => {
  it('a normal page is not a challenge', () => {
    expect(detectChallenge(base)).toEqual({ detected: false, signals: [] });
  });

  it('Cloudflare "Just a moment" interstitial', () => {
    const c = detectChallenge({
      ...base,
      status: 403,
      title: 'Just a moment...',
      headers: [{ name: 'cf-mitigated', value: 'challenge' }],
      text: 'Checking your browser',
      scripts: ['https://www.example.test/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'],
    });
    expect(c.detected).toBe(true);
    expect(c.kind).toBe('cloudflare');
    expect(c.signals).toEqual(
      expect.arrayContaining([
        'status:403',
        'title:just a moment',
        'header:cf-mitigated',
        'script:challenge-platform',
      ]),
    );
  });

  it('plain 403 is a block', () => {
    const c = detectChallenge({ ...base, status: 403, title: 'Forbidden', text: 'Forbidden' });
    expect(c).toMatchObject({ detected: true, kind: 'http-403' });
  });

  it('Akamai / generic access denied pages', () => {
    expect(
      detectChallenge({ ...base, status: 200, title: 'Access Denied', text: 'Reference #18.abc' }),
    ).toMatchObject({ detected: true, kind: 'akamai' });
  });

  it('a long article mentioning "just a moment" in body text is not a challenge', () => {
    expect(detectChallenge({ ...base, text: `Just a moment, please read on. ${base.text}` }).detected).toBe(
      false,
    );
  });
});
