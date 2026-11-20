/**
 * The Node side keeps a click selector of the probe only in the forms the probe builds and only from names: the page can
 * change what the probe returns, and the selector is stored in the snapshot and the click plan.
 */
import { describe, expect, it } from 'vitest';
import { loadProbeData } from '../../../src/cmp/adapters-file.ts';
import { isProbeSelector } from '../../../src/cmp/page/selector.ts';

const ATTRIBUTES = loadProbeData().selectorAttributes;

describe('isProbeSelector', () => {
  it.each([
    ['an id', '#CybotCookiebotDialogBodyButtonDecline'],
    ['a vendor id with a short suffix', '#CybotCookiebotBannerCloseButtonE2E'],
    ['an escaped id with a leading digit', '#\\31 23abc'],
    ['an escaped id with a colon', '#\\:r1\\:'],
    ['a vendor data attribute', 'button[data-testid="uc-accept-all-button"]'],
    ['a vendor action type', 'button[data-action-type="deny"]'],
    ['a presence attribute', 'a[data-cookie-refuse=""]'],
    ['a one-word label', 'button[aria-label="Akzeptieren"]'],
    ['class tokens', 'button.brlbs-btn.brlbs-btn-accept-all'],
    ['a vendor class with a short group first', 'button.ch2-open-settings-btn'],
    ['a custom element', 'uc-button.primary'],
    ['a structural path', '#banner > div:nth-child(1) > button:nth-child(2)'],
    ['a path from the root', 'html:nth-child(1) > body:nth-child(2) > div:nth-child(3)'],
    ['a path through an element without a tag name', '#banner > *:nth-child(2) > button:nth-child(1)'],
    ['a step through a shadow root', '#usercentrics-root >> button[data-testid="uc-deny-all-button"]'],
    ['a path from an element without an id', 'div:nth-child(3) > button:nth-child(2)'],
    ['a name attribute', 'button[name="refuse"]'],
  ])('keeps %s: %s', (_case, selector) => {
    expect(isProbeSelector(selector, ATTRIBUTES)).toBe(true);
  });

  it.each([
    ['a label with a query', 'button[aria-label="Akzeptieren ?sid=zq7abc123&uid=42"]'],
    ['a URL in name', 'button[name="https://x.test/?uid=zq7name"]'],
    ['a hex id', '#cid-9f86d081884c7d659a2feaa0c55ad015'],
    ['a hex class token', 'button.btn.uid-5f4dcc3b5aa765d61d8327deb882cf99'],
    ['an escaped query class', 'button.\\?token\\=zq7cls'],
    ['an escaped address id', '#zq7alice\\@example\\.test'],
    ['an escaped address as hex escapes', '#zq7alice\\40 example'],
    ['a query ancestor id', '#wrap\\?sid\\=zq7\\&x\\=1 > div:nth-child(1) > button:nth-child(2)'],
    ['a UUID ancestor id', '#sess-123e4567-e89b-12d3-a456-426614174000 > button:nth-child(1)'],
    ['an attribute the probe does not use', 'button[data-secret="zq7"]'],
    ['an attribute value with a blank', 'button[aria-label="Alle akzeptieren"]'],
    ['a tag that is no tag name', 'x-a?token=zq7tok:nth-child(1)'],
    ['a selector list', 'button, #zq7'],
    ['an attribute operator', 'button[name^="zq7"]'],
    ['a pseudo-class', 'button:not(.zq7)'],
    ['the universal selector alone', '*'],
    ['a dangling combinator', '#a > '],
    [
      'a class token split by a zero-width space',
      'button.cmplz-accept.\\39 f86d081884c7d6\u200b59a2feaa0c55ad0',
    ],
    [
      'a class token split by an escaped zero-width space',
      'button.\\39 f86d081884c7d6\\200b 59a2feaa0c55ad0',
    ],
    ['an id with a right-to-left override', '#zq7\u202egnp\\.exe'],
    ['a fullwidth at sign', 'button[data-testid="max.mustermann\uff20zq7mail.test"]'],
    ['an address with (at)', 'button[name="erika.zq7(at)example.test"]'],
    ['an IP address', 'button[data-role="ip-203.0.113.42"]'],
    ['an unescaped address after a class', 'button.btn.zq7mix@example.test'],
    ['a tag with a hex run', 'zq7-4f3a9c1d2e7b8a9f.btn'],
    ['Arabic-Indic digits', 'button[data-role="١٢٣٤٥٦٧٨٩٠"]'],
    ['a card number', 'button[data-testid="4111-1111-1111-1111"]'],
    ['a protocol-relative URL', 'a[data-role="//evil.test/u/alice.mueller"]'],
    ['a host name with a path', 'a[data-role="evil.test/u/alice.mueller"]'],
    ['a mailto: URL', 'a[data-role="mailto:alice.mueller"]'],
    ['a short hex id', 'button[data-testid="uid-4f3a9c1d2e7b"]'],
    ['an id of a token cut into short parts', '#x9Kq-Lm3P-zR7t-Wb2N-vC5s-Df8G-hJ1k-Qa4E'],
    ['a test hook of a token cut into short parts', 'button[data-testid="Kd8sLq-Mz3pRt-Wx7vNb-Qa2cEf"]'],
    ['a class of a word and a token cut into short parts', 'button.Token_aB3d_9Kx2_mQ7z_P4wR_t8Yn'],
    ['an escaped newline', '#a\\\nb'],
    ['an escaped NUL', '#a\\0 b'],
    ['nothing', ''],
    ['an overlong selector', `#${'a'.repeat(9000)}`],
  ])('drops %s: %j', (_case, selector) => {
    expect(isProbeSelector(selector, ATTRIBUTES)).toBe(false);
  });

  it('a run of hex escapes from a replaced CSS.escape is judged at once, not by trying every split', () => {
    const started = performance.now();
    expect(isProbeSelector(`#${'\\31'.repeat(320)}!`, ATTRIBUTES)).toBe(false);
    expect(isProbeSelector(`button.${'\\31'.repeat(320)}!`, ATTRIBUTES)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
