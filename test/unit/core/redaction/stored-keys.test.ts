import { describe, expect, it } from 'vitest';
import { storedCookieName, storedHeaderName } from '../../../../src/core/redaction/headers.ts';
import { storedKey } from '../../../../src/core/redaction/page-names.ts';

describe('storedKey: the name of a storage key, an IndexedDB database or a cookie', () => {
  it.each([
    ['a UUID', 'cmplz_123e4567-e89b-12d3-a456-426614174000', 'cmplz_[redacted]'],
    ['a UUID with underscores', 'session_123e4567_e89b_12d3_a456_426614174000', 'session_[redacted]'],
    ['a UUID without separators', 'uid_123e4567e89b12d3a456426614174000', 'uid_[redacted]'],
    [
      'a visitor id inside a key',
      'optimizely_data$$oeu1612345678901r0.12345678901234567$$12345678$$session_state',
      'optimizely_data$$oeu[redacted].[redacted]$$12345678$$session_state',
    ],
    [
      'a visitor id glued to a word',
      'optimizely_data$$oeu1612345678901r0$$session_state',
      'optimizely_data$$oeu[redacted]$$session_state',
    ],
    ['a hex id', 'rc::4f3a9c1d2e7b4a9f4f3a9c1d', 'rc::[redacted]'],
    ['a hex id after a prefix', 'amplitude_unsent_4f3a9c1d2e7b4a9f', 'amplitude_unsent_[redacted]'],
    ['a hex id in groups', 'uid_4f3a-9c1d-2e7b-4a9f', 'uid_[redacted]'],
    ['a hex id in groups joined by dots', 'uid_4f3a.9c1d.2e7b.4a9f', 'uid_[redacted]'],
    ['ten digits', 'user_1234567890', 'user_[redacted]'],
    ['ten digits in the second part of a short hex run', 'a_b1234567890c', 'a_[redacted]'],
    ['digits in groups', 'GA1.2.123456789.1612345678', 'GA1.[redacted]'],
    ['a base64 id', 'token_Xk2mQ9pLw8eR1tZ3aB4cD5', 'token_[redacted]'],
    [
      'a base64 id glued to a word',
      'cookieConsentBanner2mQ9pLw8eR1tZ3aB4cD5',
      'cookieConsentBanner[redacted]',
    ],
    ['a base64 id glued to random letters and a word', 'hjSessionSampleXk2mQ9pLw8eR1tZ3aB4cD5', '[redacted]'],
    ['a base64 id that starts with random letters', 'ab.BrDicpsIkHF19Ag6fikkr3', 'ab.[redacted]'],
    ['a base64 id with a random prefix and a short rest', 'ab.CZqjqLg7yReiYWoqc2bks7', 'ab.[redacted]'],
    [
      'a UUID-length hex id glued to a word',
      '_hjIncludedInSessionSample4f3a9c1d2e7b4a9f4f3a9c1d2e7b4a9f',
      '_hjIncludedInSessionSample[redacted]',
    ],
    [
      'a hex id of 32 glued to capitals',
      'ASPSESSIONID4f3a9c1d2e7b4a9f4f3a9c1d2e7b4a9f',
      'ASPSESSIONID[redacted]',
    ],
    ['a hex run longer than a UUID', `x_${'4f3a9c1d2e7b'.repeat(4).slice(0, 44)}`, 'x_[redacted]'],
    [
      'a nanoid with an underscore and a hyphen',
      'chat_session_V1StGXR8_Z5jdHi6B-myT',
      'chat_session_[redacted]',
    ],
    ['a short letter part inside an encoded run', 'chat_a_V1StGXR8_Z5jdHi6B-myT', 'chat_[redacted]'],
    ['a hex id followed by a letter', 'sess_4f3a9c1d2e7b4a9f4f3a9c1dz', 'sess_[redacted]z'],
    ['a hex id followed by a word', '4f3a9c1d2e7b4a9fsession', '[redacted]session'],
    ['a hex id followed by capitals', 'LogsDatabaseV2:4f3a9c1d2e7b4a9fLL||', 'LogsDatabaseV2:[redacted]LL||'],
    ['a hex id of 40 followed by a letter', `k_${'4f3a9c1d2e'.repeat(4)}g`, 'k_[redacted]g'],
    ['a pool name with numbers and words', 'BIGipServerTypo3Live443', 'BIGipServerTypo3Live443'],
    ['a pool name with a number and a word', 'BIGipServerApp01Prod443', 'BIGipServerApp01Prod443'],
    [
      'a pool name with a year and capitals',
      'BIGipServerExchange2016OWA443',
      'BIGipServerExchange2016OWA443',
    ],
    ['a pool name with capitals', 'BIGipServerWWW2Pool443', 'BIGipServerWWW2Pool443'],
    ['a pool name with a short number', 'BIGipServerIIS10Web443', 'BIGipServerIIS10Web443'],
    ['a pool name with a digit', 'BIGipServerShop1Pool443', 'BIGipServerShop1Pool443'],
    [
      'counterexample: a session cookie of a vendor',
      'ttcsid_C4JBQ7BC77U5S6VOPGOG',
      'ttcsid_C4JBQ7BC77U5S6VOPGOG',
    ],
    ['an address with a zero-width space after the @', 'alice@\u200bexample.test', '[redacted]@example.test'],
    ['an address literal', 'alice@[192.168.0.1]', '[redacted]@[192.168.0.1]'],
    [
      'an address and a query',
      'alice@example.test?sid=4f3a9c1d2e7b4a9f',
      '[redacted]@example.test?[redacted]',
    ],
    ['a percent-encoded address', 'alice%40example.test', '[redacted]@example.test'],
    [
      'an address encoded twice between words',
      'user:alice%2540example.test:cart',
      'user:[redacted]@example.test:cart',
    ],
    ['a fullwidth at sign', 'alice＠example.test', '[redacted]@example.test'],
    ['an obfuscated address', 'alice(at)example.test', '[redacted]@example.test'],
    ['a local part without a domain', 'user:alice@intranet', 'user:[redacted]@intranet'],
    ['an obfuscated local part without a domain', 'alice(at)intranet', '[redacted]@intranet'],
    ['counterexample: a vendor prefix and a short id', 'ucData_hxnJq0hMNeT4UY', 'ucData_hxnJq0hMNeT4UY'],
    [
      'counterexample: a vendor prefix and another short id',
      'ucData_wI7DBn7t2gR3Tx',
      'ucData_wI7DBn7t2gR3Tx',
    ],
    [
      'counterexample: a vendor prefix with a leading underscore',
      '_hjSession_hxnJq0hMNeT4UY',
      '_hjSession_hxnJq0hMNeT4UY',
    ],
    ['a vendor prefix and a long base64 id', 'ucData_Xk2mQ9pLw8eR1tZ3aB4cD5vN', 'ucData_[redacted]'],
    ['ranges that share parts, in underscores', 'Xk9QzTw_QwErTyUiOp4f3a9c1d_2e7b4a9f_12345678', '[redacted]'],
    [
      'ranges that share parts, in hyphens and a dot',
      'Xk9QzTw-AbcdefXyz4f3a9c1d-2e7b4a9f.12345678',
      '[redacted]',
    ],
    ['counterexample: a literal key', '_gcl_ls', '_gcl_ls'],
    ['counterexample: a hyphen between words', 'chat-session-mobile-banner', 'chat-session-mobile-banner'],
    ['counterexample: a key with capitals', 'ytidb::LAST_RESULT_ENTRY_KEY', 'ytidb::LAST_RESULT_ENTRY_KEY'],
    ['counterexample: a version in a key', 'pkg@3.7.1', 'pkg@3.7.1'],
    [
      'counterexample: a host in a key',
      'firebase:host:proj.firebaseio.com',
      'firebase:host:proj.firebaseio.com',
    ],
    ['counterexample: a short number', 'wp-settings-time-1', 'wp-settings-time-1'],
    ['counterexample: a version', 'pkg_v1.2.3', 'pkg_v1.2.3'],
    ['counterexample: five digits', 'ajs_user_id_12345', 'ajs_user_id_12345'],
    ['counterexample: six digits', '_hjSessionUser_123456', '_hjSessionUser_123456'],
    ['counterexample: seven digits', '_hjSessionUser_1234567', '_hjSessionUser_1234567'],
    ['counterexample: a site id of F5', 'TS01dc4fc6', 'TS01dc4fc6'],
    ['counterexample: a site id of F5 in capitals', 'TS0150a1d4', 'TS0150a1d4'],
    ['counterexample: a site id of F5 with a suffix', 'TS01d8a15b_77', 'TS01d8a15b_77'],
    ['counterexample: a consent id of seven digits', '__cmpconsentx47472', '__cmpconsentx47472'],
    [
      'counterexample: a consent id with a domain',
      '__cmpconsentx12345_.example.de',
      '__cmpconsentx12345_.example.de',
    ],
    ['counterexample: a property id of Google', '_ga_ABCD1234EF', '_ga_ABCD1234EF'],
    ['counterexample: ids of Incapsula', 'incap_ses_123_456789', 'incap_ses_123_456789'],
    ['counterexample: a short hex id', 'amplitude_unsent_4f3a9c1d', 'amplitude_unsent_4f3a9c1d'],
    ['counterexample: a key with a colon', 'rc::a', 'rc::a'],
    [
      'counterexample: a key with colons and a locale',
      'real_cookie_banner-v:3_blog:1_path:en_US',
      'real_cookie_banner-v:3_blog:1_path:en_US',
    ],
    [
      'counterexample: a camelCase key with a year',
      'cookieConsentBanner2024Accept',
      'cookieConsentBanner2024Accept',
    ],
    ['counterexample: words made of hex letters', 'add-bad-face-dead-beef', 'add-bad-face-dead-beef'],
  ])('%s', (_case, key, expected) => {
    expect(storedKey(key)).toBe(expected);
  });

  it('cookie names keep a short vendor ID and redact an overlapping visitor ID', () => {
    expect(storedCookieName('ucData_hxnJq0hMNeT4UY')).toBe('ucData_hxnJq0hMNeT4UY');
    expect(storedCookieName('Xk9QzTw-AbcdefXyz4f3a9c1d-2e7b4a9f.12345678')).toBe('[redacted]');
  });

  it('a hex run longer than 32 loses its tail with the rest of the run', () => {
    expect(storedKey(`sha1_${'4f3a9c1d2e'.repeat(4)}`)).not.toContain('9c1d');
  });

  it('random base64 ids of the masked shape are never kept whole and rarely in part', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let seed = 20260101;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const whole: string[] = [];
    let ids = 0;
    let partly = 0;
    for (const length of [20, 22, 27, 32]) {
      for (let k = 0; k < 400; k++) {
        const id = Array.from({ length }, () => alphabet[next(alphabet.length)]!).join('');
        if ((id.match(/\d/g) ?? []).length < 2 || !/[a-z]/.test(id) || !/[A-Z]/.test(id)) continue;
        const stored = storedKey(`ab.${id}`);
        ids++;
        if (stored.includes(id.slice(3))) whole.push(`${id} -> ${stored}`);
        else if (stored.includes(id.slice(0, 9))) partly++;
      }
    }
    expect(whole).toEqual([]);
    expect(partly / ids).toBeLessThan(0.05);
  });

  it('random nanoids with hyphens and underscores are rarely kept whole', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let seed = 20261108;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    let ids = 0;
    const whole: string[] = [];
    let doubledKept = 0;
    let collapsedKept = 0;
    for (const length of [21, 24, 32]) {
      for (let k = 0; k < 1500; k++) {
        const id = Array.from({ length }, () => alphabet[next(alphabet.length)]!).join('');
        if ((id.match(/\d/g) ?? []).length < 2 || !/[a-z]/.test(id) || !/[A-Z]/.test(id)) continue;
        ids++;
        const stored = storedKey(`chat_${id}`);
        if (stored.includes(id.slice(3, 15))) whole.push(`${id} -> ${stored}`);
        const collapsed = id.replace(/[-_]{2,}/g, (run) => run[0]!);
        if (collapsed !== id) {
          if (stored.includes(id)) doubledKept++;
          if (storedKey(`chat_${collapsed}`).includes(collapsed)) collapsedKept++;
        }
      }
    }
    expect(doubledKept).toBeLessThanOrEqual(collapsedKept);
    expect(ids).toBeGreaterThan(2000);
    expect(whole.length / ids).toBeLessThan(0.04);
  });

  it('random hex ids of 16 to 40 characters are masked when a letter follows them', () => {
    const hex = '0123456789abcdef';
    let seed = 99;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const kept: string[] = [];
    for (let k = 0; k < 1000; k++) {
      const id = Array.from({ length: 16 + next(25) }, () => hex[next(16)]!).join('');
      if (!/\d/.test(id) || !/[a-f]/.test(id)) continue;
      const tail = 'ghijklmnopqrstuvwxyz'[next(20)]!;
      for (const key of [`sess_${id}${tail}`, `${id}${tail}x`])
        if (storedKey(key).includes(id.slice(0, 12))) kept.push(key);
    }
    expect(kept).toEqual([]);
  });

  it('keeps an encoded @ in a name that has no domain after it', () => {
    expect(storedKey('AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg')).toBe(
      'AMCV_1234ABCD5678EFGH9012IJKL%40AdobeOrg',
    );
    expect(storedKey('AMCV_4f3a9c1d2e7b4a9f4f3a9c1d%40AdobeOrg')).toBe('AMCV_[redacted]%40AdobeOrg');
  });

  it('a query is cut and the stored form does not change when it is stored again', () => {
    const once = storedKey('cart?sid=4f3a9c1d2e7b4a9f&x=1');
    expect(once).toBe('cart?[redacted]');
    expect(storedKey(once)).toBe(once);
    const address = storedKey('user:alice@intranet:4f3a-9c1d-2e7b-4a9f');
    expect(storedKey(address)).toBe(address);
  });

  it('an address that the page cut in the middle loses its local part', () => {
    expect(storedKey(`${'x'.repeat(390)}alice@exa`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(380)}alice@example.test`.slice(0, 400))).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(395)}alice@`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(390)}alice%40exa`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(390)}alice(at)ex`)).not.toContain('alice');
  });

  it('an address that starts before the limit of 200 characters is masked whole', () => {
    expect(storedKey(`${'x'.repeat(190)}alice@example.test`)).not.toContain('alice');
    expect(storedKey(`${'x'.repeat(190)}alice%40example.test`)).not.toContain('alice');
  });

  it('a name that holds no address keeps its text up to the limit of 200 characters', () => {
    expect(storedKey('k'.repeat(300))).toBe('k'.repeat(200));
  });

  it('stays fast on names made to be slow', () => {
    const started = performance.now();
    for (const name of [
      'a-'.repeat(200),
      `${'ab1'.repeat(133)}!`,
      'a@'.repeat(200),
      'a(at)'.repeat(80),
      '1.'.repeat(200),
      `${'Aa1'.repeat(133)}+`,
    ])
      storedKey(name);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('stored names protect encoded identifiers and addresses', () => {
  it.each([
    ['glued hex', 'sessiona1b2c3d4e5f60718', 'session[redacted]'],
    ['double underscore', 'V1StGXR8__Z5jdHi6B-myT', '[redacted]'],
    ['double underscore in hex', '4f3a__9c1d_2e7b_4a9f', '[redacted]'],
    ['double hyphen', 'V1StGXR8--Z5jdHi6B-myT', '[redacted]'],
    ['mixed separators', 'V1StGXR8-_Z5jdHi6B-myT', '[redacted]'],
    ['short F5 name', 'TS01dc4fc6', 'TS01dc4fc6'],
    ['short vendor id', 'amplitude_unsent_4f3a9c1d', 'amplitude_unsent_4f3a9c1d'],
  ])('%s', (_label, input, expected) => {
    expect(storedKey(input)).toBe(expected);
  });
  it.each([
    ['fullwidth at', 'alice%EF%BC%A0example.test'],
    ['compatibility at', 'alice%EF%B9%ABexample.test'],
  ])('%s', (_label, input) => {
    expect(storedKey(input)).not.toContain('alice');
    expect(storedCookieName(input)).toBe('[redacted]');
    expect(storedHeaderName(input)).toBe('[redacted]');
  });
});

describe('stored name boundary cases', () => {
  it.each([
    ['1234567890:V1StGXR8_Z5jdHi6B-myT', '[redacted]:[redacted]'],
    ['V1StGXR8_Z5jdHi6B-myT:1234567890', '[redacted]:[redacted]'],
    ['sessiona1b2c3d4e5f60718x', 'session[redacted]x'],
    ['sessiona1b2c3d4e5f60718_x', 'session[redacted]_x'],
  ])('masks %s', (input, expected) => {
    expect(storedKey(input)).toBe(expected);
    expect(storedCookieName(input)).toBe(expected);
  });
  it.each(['__', '--', '-_'])('counts the full separator %s', (separator) => {
    for (const suffix of ['', 'a', 'ab']) {
      const input = `V1StGXR8${separator}Z5jdHi6B-${suffix}`;
      expect(storedKey(input), input).toBe(input.length < 20 ? input : '[redacted]');
    }
  });
  it('masks an encoded header marker with no dotted domain', () => {
    expect(storedHeaderName('alice%40intranet')).toBe('[redacted]');
  });
});
