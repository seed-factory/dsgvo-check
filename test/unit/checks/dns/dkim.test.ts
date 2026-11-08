/**
 * DKIM key records (RFC 6376 §3.6.1): the tag list, the key length read from the DER structure, and the selector plan
 * of a mail domain. The parser reads data published by third parties, so it never throws.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type DkimRules,
  decodeBase64,
  dkimSignals,
  isDkimCandidate,
  parseDkimKey,
  parseDkimTags,
  planDkimSelectors,
  recognizedProviders,
  rsaModulusBits,
} from '../../../../src/checks/dns/lib/dkim.ts';
import { loadDkimRules } from '../../../../src/collectors/dns/rules.ts';
import { base64, dkimRecord, ED25519_KEY, rsaKey, rsaPkcs1Der, rsaSpkiDer } from './dkim-keys.ts';
import { zone } from './zone.ts';

const SIZES = [512, 1023, 1024, 2048, 4096] as const;

/** Public keys from node:crypto, DER in both encodings DKIM records use. */
function realKey(bits: number): { spki: Uint8Array; pkcs1: Uint8Array } {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    spki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    pkcs1: new Uint8Array(publicKey.export({ type: 'pkcs1', format: 'der' })),
  };
}

describe('rsaModulusBits', () => {
  it.each(SIZES)(
    'reads %i bits from SubjectPublicKeyInfo and from bare PKCS#1 (node:crypto keys)',
    (bits) => {
      const key = realKey(bits);
      expect(rsaModulusBits(key.spki)).toBe(bits);
      expect(rsaModulusBits(key.pkcs1)).toBe(bits);
    },
  );

  it('accepts rsaEncryption without parameters, as some encoders write it', () => {
    const spki = rsaSpkiDer(2048);
    // Drop `05 00` from the AlgorithmIdentifier and shorten the enclosing lengths by 2.
    const noParameters = [...spki.slice(0, 4), 0x30, 0x0b, ...spki.slice(6, 17), ...spki.slice(19)];
    noParameters[3] = (noParameters[3] as number) - 2;
    expect(rsaModulusBits(new Uint8Array(noParameters))).toBe(2048);
  });

  it('rejects truncated DER, trailing bytes, a negative or empty modulus, another algorithm and bad parameters', () => {
    const spki = rsaSpkiDer(2048);
    // The last byte of the rsaEncryption OID 1.2.840.113549.1.1.1, changed to another algorithm.
    const otherAlgorithm = [...spki];
    otherAlgorithm[16] = 0x0a;
    // 1023 bits need no leading zero byte; a first content byte with the high bit set makes the INTEGER negative.
    const negative = rsaPkcs1Der(1023);
    negative[6] = 0xff;
    // rsaEncryption takes NULL parameters (RFC 3279 §2.3.1): other bytes there make the key unreadable for verifiers.
    const badParameters = [...spki];
    badParameters[18] = 0xff;
    const extraParameters = [
      ...spki.slice(0, 4),
      0x30,
      0x0f,
      ...spki.slice(6, 19),
      0x05,
      0x00,
      ...spki.slice(19),
    ];
    extraParameters[3] = (extraParameters[3] as number) + 2;
    for (const der of [
      badParameters,
      extraParameters,
      spki.slice(0, spki.length - 1),
      spki.slice(0, 20),
      [...spki, 0x00],
      [0x30, 0x03, 0x02, 0x01, 0x00],
      [0x30, 0x05, 0x02, 0x01, 0x00, 0x02, 0x00],
      negative,
      otherAlgorithm,
      [],
      [0x30],
      [0x30, 0x84, 0xff, 0xff, 0xff, 0xff],
    ]) {
      expect(rsaModulusBits(new Uint8Array(der)), JSON.stringify(der.slice(0, 12))).toBeNull();
    }
  });
});

describe('decodeBase64', () => {
  it('ignores whitespace and the chunk splits of a long TXT record', () => {
    const p = rsaKey(2048);
    const spaced = `${p.slice(0, 100)} \t${p.slice(100, 255)}\r\n ${p.slice(255)}`;
    expect(decodeBase64(spaced)).toEqual(decodeBase64(p));
    expect(decodeBase64(p)?.length).toBe(rsaSpkiDer(2048).length);
  });

  it.each(['abc*', 'ab=c', 'a', '====', 'äöü'])('%j is not base64 → null', (s) => {
    expect(decodeBase64(s)).toBeNull();
  });
});

describe('parseDkimTags (RFC 6376 §3.2)', () => {
  it('splits tags, trims whitespace around names and values, allows a trailing semicolon', () => {
    expect(Object.fromEntries(parseDkimTags(' v = DKIM1 ;k=rsa; p= ab cd ;') ?? [])).toEqual({
      v: 'DKIM1',
      k: 'rsa',
      p: 'ab cd',
    });
  });

  it('tag names are case-sensitive: p and P are different tags', () => {
    expect(Object.fromEntries(parseDkimTags('p=abc; P=def') ?? [])).toEqual({ p: 'abc', P: 'def' });
  });

  it.each([
    ['an empty tag between two others', 'v=DKIM1;;p=abc'],
    ['a leading empty tag', ';v=DKIM1; p=abc'],
    ['a duplicate tag', 'v=DKIM1; p=abc; p=def'],
    ['a part without "="', 'v=DKIM1; garbage; p=abc'],
    ['a tag name with a hyphen', 'google-site-verification=abc'],
  ])('%s makes the whole list invalid', (_label, raw) => {
    expect(parseDkimTags(raw)).toBeNull();
  });
});

describe('isDkimCandidate: which TXT answers at a selector name are kept', () => {
  it.each([
    ['v=DKIM1; k=rsa; p=abc', true],
    ['k=rsa; p=abc', true],
    ['p=', true],
    ['  v=dkim1;p=abc', true],
    // Another DKIM version is a key record the parser cannot read, not an absent key.
    ['v=DKIM2; p=abc', true],
    ['v=DKIM1.0; k=rsa; p=abc', true],
    ['v="DKIM1"; p=abc', true],
    ['google-site-verification=abc123', false],
    ['site-verification=abc123', false],
    ['v=spf1 include:_spf.provider.example -all', false],
    ['v=DMARC1; p=reject', false],
    ['MS=ms12345678', false],
  ] as const)('%j → %s', (txt, kept) => {
    expect(isDkimCandidate(txt)).toBe(kept);
  });
});

describe('parseDkimKey', () => {
  it('k defaults to rsa; the key length comes from p=', () => {
    expect(parseDkimKey(`v=DKIM1; p=${rsaKey(2048)}`)).toEqual({ kind: 'rsa', bits: 2048 });
    expect(parseDkimKey(dkimRecord(rsaKey(768)))).toEqual({ kind: 'rsa', bits: 768 });
    expect(parseDkimKey(`k=rsa; p=${base64(rsaPkcs1Der(1024))}`)).toEqual({ kind: 'rsa', bits: 1024 });
  });

  it('an Ed25519 key is exactly 32 bytes and has no RSA length', () => {
    expect(parseDkimKey(dkimRecord(ED25519_KEY, 'ed25519'))).toEqual({ kind: 'ed25519' });
    expect(parseDkimKey(dkimRecord(base64(new Array(31).fill(1)), 'ed25519'))).toMatchObject({
      kind: 'unparsable',
    });
    // An RSA structure under k=ed25519 is not an Ed25519 key.
    expect(parseDkimKey(dkimRecord(rsaKey(2048), 'ed25519'))).toMatchObject({ kind: 'unparsable' });
  });

  it('an empty p= is a revoked key, also with whitespace only', () => {
    expect(parseDkimKey('v=DKIM1; k=rsa; p=')).toEqual({ kind: 'revoked' });
    expect(parseDkimKey('v=DKIM1; p= ;')).toEqual({ kind: 'revoked' });
  });

  it.each([
    ['no p= tag', 'v=DKIM1; k=rsa', 'no-key'],
    ['an unknown key type', `v=DKIM1; k=dsa; p=${rsaKey(2048)}`, 'key-type'],
    ['v= not first', `k=rsa; v=DKIM1; p=${rsaKey(2048)}`, 'version'],
    ['another version', `v=DKIM2; p=${rsaKey(2048)}`, 'version'],
    ['invalid base64', 'v=DKIM1; p=MIIB*IjAN', 'key-data'],
    ['truncated DER', `v=DKIM1; p=${base64(rsaSpkiDer(2048).slice(0, 100))}`, 'key-data'],
    ['a duplicate tag', `v=DKIM1; p=${rsaKey(2048)}; p=${rsaKey(1024)}`, 'syntax'],
    ['an upper-case P only', `v=DKIM1; P=${rsaKey(2048)}`, 'no-key'],
  ])('%s → unparsable (%s)', (_label, txt, reason) => {
    expect(parseDkimKey(txt)).toEqual({ kind: 'unparsable', reason });
  });

  it('never throws, whatever a third party publishes (seeded random input)', () => {
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= ;kpv\tä';
    const valid = rsaKey(2048);
    for (let i = 0; i < 2_000; i++) {
      const kind = i % 3;
      let txt: string;
      if (kind === 0) {
        txt = Array.from({ length: Math.floor(next() * 80) }, () =>
          alphabet.charAt(Math.floor(next() * alphabet.length)),
        ).join('');
      } else {
        // A valid key with random bytes overwritten: plausible DER with wrong lengths.
        const bytes = [...rsaSpkiDer(1024 + Math.floor(next() * 3000))];
        for (let j = 0; j < 3; j++) bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256);
        txt = `v=DKIM1; k=${kind === 1 ? 'rsa' : 'ed25519'}; p=${base64(bytes.slice(0, Math.floor(next() * bytes.length) + 1))}`;
      }
      expect(() => parseDkimKey(txt)).not.toThrow();
      expect(() => rsaModulusBits(decodeBase64(txt.replace(/^.*p=/, '')) ?? new Uint8Array())).not.toThrow();
    }
    expect(parseDkimKey(dkimRecord(valid))).toEqual({ kind: 'rsa', bits: 2048 });
  });
});

const RULES: DkimRules = {
  providers: [
    {
      id: 'microsoft-365',
      mx: ['mail.protection.outlook.com'],
      spfIncludes: ['spf.protection.outlook.com'],
      selectors: ['selector1', 'selector2'],
      fixed: true,
    },
    {
      id: 'google-workspace',
      mx: ['aspmx.l.google.com', 'smtp.google.com'],
      spfIncludes: ['_spf.google.com'],
      selectors: ['google'],
      fixed: false,
    },
  ],
  commonSelectors: ['default', 'dkim', 'mail', 's1', 's2', 'k1', 'key1'],
};

const M365 = {
  'MX example.de': ['0 example-de.mail.protection.outlook.com'],
  'TXT example.de': ['v=spf1 include:spf.protection.outlook.com -all'],
  'TXT spf.protection.outlook.com': ['v=spf1 ip4:192.0.2.0/24 -all'],
} as const;

const plan = (spec: Record<string, readonly string[] | 'NXDOMAIN'>, operator: string[] = [], max = 8) => {
  const signals = dkimSignals('example.de', zone(spec));
  return planDkimSelectors({
    domain: 'example.de',
    signals,
    operatorSelectors: operator,
    maxSelectors: max,
    rules: RULES,
  }).map((e) => `${e.selector}:${e.reason}:${e.given ? 'given' : 'probe'}${e.capped ? ':capped' : ''}`);
};

describe('planDkimSelectors', () => {
  it('operator selectors first, then the fixed provider selectors, then common names, capped', () => {
    expect(plan(M365, ['Mailing', 'example.de/news', 'other.example/skip'])).toEqual([
      'mailing:operator:given',
      'news:operator:given',
      'selector1:provider:microsoft-365:given',
      'selector2:provider:microsoft-365:given',
      'default:common:probe',
      'dkim:common:probe',
      'mail:common:probe',
      's1:common:probe',
    ]);
  });

  it('a provider counts only with its MX and its SPF include, also one nested in another include', () => {
    const inboundOnly = { ...M365, 'TXT example.de': ['v=spf1 ip4:192.0.2.1 -all'] };
    expect(plan(inboundOnly)).toEqual(RULES.commonSelectors.map((s) => `${s}:common:probe`).slice(0, 7));
    const nested = {
      ...M365,
      'TXT example.de': ['v=spf1 include:_spf.example.de -all'],
      'TXT _spf.example.de': ['v=spf1 include:spf.protection.outlook.com -all'],
    };
    expect(plan(nested).slice(0, 2)).toEqual([
      'selector1:provider:microsoft-365:given',
      'selector2:provider:microsoft-365:given',
    ]);
    const otherMx = { ...M365, 'MX example.de': ['10 mx.example.de'] };
    expect(plan(otherMx)[0]).toBe('default:common:probe');
  });

  it('a provider whose selector the customer can change gives probes, not given selectors', () => {
    const google = {
      'MX example.de': ['1 smtp.google.com'],
      'TXT example.de': ['v=spf1 include:_spf.google.com ~all'],
      'TXT _spf.google.com': ['v=spf1 ip4:192.0.2.0/24 ~all'],
    };
    expect(plan(google)[0]).toBe('google:provider:google-workspace:probe');
  });

  it('a given selector over the cap stays in the plan as capped, so a missing key there is not claimed', () => {
    expect(plan(M365, [], 1)).toEqual([
      'selector1:provider:microsoft-365:given',
      'selector2:provider:microsoft-365:given:capped',
    ]);
    expect(plan(M365, ['a', 'b'], 2)).toEqual([
      'a:operator:given',
      'b:operator:given',
      'selector1:provider:microsoft-365:given:capped',
      'selector2:provider:microsoft-365:given:capped',
    ]);
  });

  it('removes duplicates and keeps the first reason; the cap counts after removal', () => {
    expect(plan(M365, ['selector1', 'default'], 3)).toEqual([
      'selector1:operator:given',
      'default:operator:given',
      'selector2:provider:microsoft-365:given',
    ]);
  });
});

describe('dkimSignals: which domains are probed', () => {
  it.each([
    ['Null MX', { 'MX example.de': ['0 .'], 'TXT example.de': ['v=spf1 -all'] }, 'null-mx'],
    ['neither MX nor SPF', { 'MX example.de': 'NXDOMAIN', 'TXT example.de': 'NXDOMAIN' }, 'no-mail-records'],
    ['SPF without MX', { 'MX example.de': 'NXDOMAIN', 'TXT example.de': ['v=spf1 -all'] }, null],
    ['MX without SPF', { 'MX example.de': ['10 mx.example.de'], 'TXT example.de': 'NXDOMAIN' }, null],
  ] as const)('%s → skip %s', (_label, spec, skip) => {
    expect(dkimSignals('example.de', zone(spec)).skip).toBe(skip);
  });
});

describe('test/data/dns/dkim.yaml recognises Microsoft 365 by each MX form Microsoft issues', () => {
  const rules = loadDkimRules();
  /** A tenant domain whose SPF includes Exchange Online, with the given MX host. */
  const withMx = (mx: string) =>
    recognizedProviders(
      dkimSignals(
        'example.de',
        zone({
          'MX example.de': [`0 ${mx}`],
          'TXT example.de': ['v=spf1 include:spf.protection.outlook.com -all'],
          'TXT spf.protection.outlook.com': ['v=spf1 ip4:192.0.2.0/24 -all'],
        }),
      ),
      rules,
    ).map((p) => p.id);

  it.each([
    ['the MX of Exchange Online', 'example-de.mail.protection.outlook.com'],
    ['the MX of a domain with inbound DNSSEC and DANE', 'example-de.o-v1.mx.microsoft'],
  ])('%s (%s)', (_name, mx) => {
    expect(withMx(mx)).toEqual(['microsoft-365']);
  });

  it.each([
    ['a host under another zone that ends in the same labels', 'example-de.o-v1.mx.microsoft.example.test'],
    ['a host whose last labels only look alike', 'example-de.o-v1.examplemx.microsoft'],
    ['a host of the site itself', 'mx.example.de'],
  ])('counterexample: %s (%s) is no Microsoft 365 MX', (_name, mx) => {
    expect(withMx(mx)).toEqual([]);
  });
});
