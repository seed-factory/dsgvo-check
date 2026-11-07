/** WAF / challenge detection on a navigated page (pure): WAF, challenge or 403 → SCAN-BLOCKED. */
import { describe, expect, it } from 'vitest';
import { detectChallenge } from '../../../../../src/collectors/browser/pages/challenge.ts';
import { challengesSection } from '../../../../../src/collectors/browser/rules.ts';

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

describe('detectChallenge: the signatures are data (test/data/browser/challenges.yaml)', () => {
  it.each([
    ['a header with a value', 'cf-mitigated', 'challenge', 200, true],
    ['a header without a value is no signal', 'cf-mitigated', '', 200, false],
    ['x-datadome with the status it belongs to', 'x-datadome', '', 403, true],
    ['x-datadome on a page that was delivered', 'x-datadome', 'protected', 200, false],
  ])('%s', (_name, header, value, status, detected) => {
    const c = detectChallenge({ ...base, status, headers: [{ name: header, value }] });
    expect(c.signals.includes(`header:${header}`)).toBe(detected);
  });

  it('script signatures are case-sensitive, title and text signatures are not', () => {
    expect(detectChallenge({ ...base, text: 'x', scripts: ['/_incapsula_resource?x=1'] }).detected).toBe(
      false,
    );
    expect(detectChallenge({ ...base, text: 'x', scripts: ['/_Incapsula_Resource?x=1'] })).toMatchObject({
      detected: true,
      kind: 'waf-block',
    });
    expect(detectChallenge({ ...base, title: 'JUST A MOMENT...', text: 'x' }).kind).toBe('cloudflare');
  });

  it('rules given by the caller replace the file: a new vendor needs no code', () => {
    const rules = challengesSection.parse({
      challenges: {
        headers: [],
        scripts: [],
        titles: [{ pattern: '^vendor check$', kind: 'captcha', signal: 'title:vendor' }],
        texts: [],
      },
    });
    const page = { ...base, title: 'Vendor Check', text: 'x' };
    expect(detectChallenge(page, rules)).toMatchObject({ detected: true, kind: 'captcha' });
    expect(detectChallenge({ ...base, title: 'Just a moment...', text: 'x' }, rules).detected).toBe(false);
  });
});
