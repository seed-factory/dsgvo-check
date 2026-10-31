/** Pure helpers of the browser collector: cookie mapping, launch errors, Link header, documents, guard, CMP facts. */
import { describe, expect, it } from 'vitest';
import type { CmpFacts } from '../../../../src/cmp/types.ts';
import { normalizeFacts } from '../../../../src/collectors/browser/cmp-bridge.ts';
import { judgeDocument } from '../../../../src/collectors/browser/documents.ts';
import { parseLinkHeader } from '../../../../src/collectors/browser/dom.ts';
import { mapCookie } from '../../../../src/collectors/browser/jar.ts';
import { classifyLaunchError } from '../../../../src/collectors/browser/launch.ts';
import { blocks, hostClassifier, urlVerdict } from '../../../../src/collectors/browser/ssrf.ts';
import { navigationErrorCode } from '../../../../src/collectors/browser/visit.ts';
import { defaultNetworkConfig } from '../../../../src/core/net.ts';
import { makeCmpFacts } from '../../../utils/snapshot-builder.ts';

const moment = {
  phase: 'A' as const,
  pageUrl: 'https://www.example.de/',
  tMs: 10,
  tRef: 'navigation' as const,
  afterClick: false,
};
const target = { etld1: 'example.de', host: 'www.example.de' };
const NOW = 1_800_000_000;

describe('mapCookie (D20)', () => {
  it('keeps name, domain, flags, lifetime and length — never the value', () => {
    const rec = mapCookie(
      {
        name: '_ga',
        value: 'GA1.1.SECRET.123',
        domain: '.example.de',
        path: '/',
        expires: NOW + 2 * 86_400,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      },
      moment,
      target,
      NOW,
      { setter: 'script' },
    );
    expect(rec).toEqual({
      name: '_ga',
      domain: 'example.de',
      firstParty: true,
      path: '/',
      partitionKey: null,
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
      lifetime: { kind: 'persistent', days: 2 },
      length: 16,
      setter: 'script',
      state: 'accepted',
      phase: 'A',
      pageUrl: 'https://www.example.de/',
      tMs: 10,
      tRef: 'navigation',
      afterClick: false,
    });
    expect(JSON.stringify(rec)).not.toContain('SECRET');
  });

  it('third-party, partitioned, session cookies', () => {
    const rec = mapCookie(
      {
        name: 'IDE',
        value: 'x',
        domain: '.doubleclick.net',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        partitionKey: 'https://example.de',
      },
      moment,
      target,
      NOW,
      { setter: 'unknown' },
    );
    expect(rec).toMatchObject({
      firstParty: false,
      partitionKey: 'https://example.de',
      lifetime: { kind: 'session' },
      sameSite: 'None',
    });
  });
});

describe('classifyLaunchError (5.2)', () => {
  it('missing browser → browser-unavailable', () => {
    expect(
      classifyLaunchError(
        new Error("browserType.launchPersistentContext: Executable doesn't exist at /x"),
        'require',
      ),
    ).toMatchObject({ reason: 'browser-unavailable', code: 'browser-not-installed' });
  });

  it('sandbox failure under require → sandbox-unavailable; the same text with off is a launch failure', () => {
    const err = new Error('Failed to launch: No usable sandbox! Update your kernel or see …');
    expect(classifyLaunchError(err, 'require')).toMatchObject({
      reason: 'sandbox-unavailable',
      code: 'sandbox-failed',
    });
    expect(classifyLaunchError(err, 'off')).toMatchObject({
      reason: 'browser-unavailable',
      code: 'browser-launch-failed',
    });
  });

  it('inside the dsgvo-check image the message names the seccomp profile and the exact docker run line (D25)', () => {
    const err = new Error('Failed to launch: No usable sandbox!');
    const inImage = classifyLaunchError(err, 'require', { DSGVO_CHECK_CONTAINER: '1' });
    expect(inImage.message).toContain('seccomp-profile > dsgvo-check-seccomp.json');
    expect(inImage.message).toContain('--security-opt seccomp=dsgvo-check-seccomp.json');
    expect(classifyLaunchError(err, 'require', {}).message).not.toContain('docker run');
  });
});

describe('navigationErrorCode', () => {
  it.each([
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/', 'ERR_NAME_NOT_RESOLVED'],
    ['page.goto: net::ERR_CERT_DATE_INVALID at https://x/', 'ERR_CERT_DATE_INVALID'],
    ['page.goto: Timeout 30000ms exceeded.', 'timeout'],
    ['page.goto: Download is starting', 'download'],
    ['something else', 'navigation-error'],
  ])('%s → %s', (msg, code) => {
    expect(navigationErrorCode(msg)).toBe(code);
  });
});

describe('parseLinkHeader', () => {
  it('extracts preconnect / preload entries with absolute, sanitized URLs', () => {
    expect(
      parseLinkHeader(
        '<https://fonts.gstatic.com>; rel=preconnect; crossorigin, </app.css?v=1&token=abc>; rel="preload"; as=style, </x>; rel=canonical',
        'https://www.example.de/page',
      ),
    ).toEqual([
      { rel: 'preconnect', href: 'https://fonts.gstatic.com/', source: 'header' },
      {
        rel: 'preload',
        href: 'https://www.example.de/app.css?v=1&token=[redacted]',
        as: 'style',
        source: 'header',
      },
    ]);
  });
});

describe('judgeDocument', () => {
  const long = 'Text. '.repeat(100);
  it('soft-404 by title/h1 on short pages; no marker on a substantive page is unconfirmed (G20)', () => {
    expect(
      judgeDocument('privacy', { title: 'Seite nicht gefunden', h1: '', text: 'x', textLength: 1 }),
    ).toBe('soft-404');
    expect(
      judgeDocument('privacy', { title: 'Start', h1: 'Willkommen', text: long, textLength: long.length }),
    ).toBe('unconfirmed');
    expect(
      judgeDocument('impressum', {
        title: 'Impressum',
        h1: 'Impressum',
        text: long,
        textLength: long.length,
      }),
    ).toBe('ok');
    // The statutory phrase counts as a heading; in the body text alone it proves nothing (footer small print).
    expect(
      judgeDocument('impressum', {
        title: 'Kontakt',
        h1: '',
        sections: ['Angaben gemäß § 5 DDG'],
        textLength: 700,
      }),
    ).toBe('ok');
    expect(
      judgeDocument('impressum', {
        title: 'Kontakt',
        h1: '',
        text: `Angaben gemäß § 5 DDG ${long}`,
        textLength: 700,
      }),
    ).toBe('unconfirmed');
  });
});

describe('SSRF guard verdicts', () => {
  const classify = hostClassifier({
    ...defaultNetworkConfig(),
    lookup: async (h) =>
      h === 'intern.example.de'
        ? [{ address: '192.168.1.10', family: 4 }]
        : [{ address: '93.184.215.14', family: 4 }],
  });
  it.each([
    ['http://169.254.169.254/latest/', true],
    ['http://127.0.0.1:8080/', true],
    ['http://[::1]/', true],
    ['http://localhost/', true],
    ['https://intern.example.de/', true],
    ['https://www.example.de/', false],
    ['data:text/html,hi', false],
    ['about:blank', false],
  ])('%s blocked=%s', async (url, blocked) => {
    expect(blocks(await urlVerdict(url, classify))).toBe(blocked);
  });
});

describe('normalizeFacts', () => {
  it('sets phase and sanitized page URL; sanitizes URLs filled from the live page', () => {
    const f: CmpFacts = makeCmpFacts({
      pageUrl: 'https://www.example.de/?session=abc',
      detection: {
        cmpId: 'cookiebot',
        method: 'adapter',
        version: null,
        versionSupported: null,
        recognitionConfidence: 'high',
        signals: [],
        frameUrl: 'https://consent.example.net/frame?uid=123',
      },
    });
    f.firstLayer.legalLinks = [{ text: 'Impressum', href: 'https://www.example.de/impressum?ref=abc' }];
    const out = normalizeFacts(f, 'C', 'https://www.example.de/?session=[redacted]');
    expect(out.phase).toBe('C');
    expect(out.pageUrl).toBe('https://www.example.de/?session=[redacted]');
    expect(out.detection.frameUrl).toBe('https://consent.example.net/frame?uid=[redacted]');
    expect(out.firstLayer.legalLinks).toEqual([
      { text: 'Impressum', href: 'https://www.example.de/impressum?ref=[redacted]' },
    ]);
  });
});
