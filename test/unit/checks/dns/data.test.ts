import { describe, expect, it } from 'vitest';
import { mail01 } from '../../../../src/checks/dns/mail-01.ts';
import { mail02 } from '../../../../src/checks/dns/mail-02.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../src/core/data/messages.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, type ZoneSpec } from './zone.ts';

const base: ZoneSpec = { 'MX example.de': ['10 mx.example.de'], 'TXT _dmarc.www.example.de': 'NXDOMAIN' };

it('renders combined DMARC options, Null MX and SPF without an all mechanism in both languages', () => {
  const cases = [
    [
      '10 mx.example.de',
      'p=reject; t=y; pct=50; sp=none',
      'ptr',
      ['weak-option', 'legacy-pct', 'permissive-qualifier', 'ptr-mechanism'],
    ],
    ['0 .', 'p=quarantine', '~all', ['weak-option', 'softfail-with-enforcement']],
    ['0 .', 'p=bogus', '', ['weak-option', 'permissive-qualifier']],
  ] as const;
  const translations = [loadTexts('de'), loadTexts('en')];

  for (const [mx, dmarc, spf, variants] of cases) {
    const snapshot = dnsSnapshot({
      ...base,
      'MX example.de': [mx],
      'TXT _dmarc.example.de': [`v=DMARC1; ${dmarc}`],
      'TXT example.de': [spf ? `v=spf1 ${spf}` : 'v=spf1'],
    });
    const observations = [mail01, mail02].flatMap((check) => observationsOf(runCheck(check, snapshot)));
    expect(
      observations.map((o) => o.variant),
      dmarc,
    ).toEqual(variants);
    for (const { checkId, variant, params } of observations) {
      const id = `${checkId}.${variant}`;
      for (const texts of translations) {
        const { title, body } = renderMessage(texts, id, params);
        const action = formatMessage(texts.actions[id] ?? '', params, texts.lang);
        const context = `${texts.lang} ${id} (${dmarc})`;
        expect(`${title}\n${body}\n${action}`, context).not.toMatch(/[{}]|\[missing text|undefined/);
        expect(action, context).not.toMatch(/^$|^ /);
      }
    }
  }
});

describe('DMARC texts agree with each other', () => {
  const observedFor = (dmarc: string) => {
    const snapshot = dnsSnapshot({ ...base, 'TXT _dmarc.example.de': [dmarc], 'TXT example.de': 'NXDOMAIN' });
    return observationsOf(runCheck(mail01, snapshot));
  };
  const none = observedFor('v=DMARC1; p=none');
  const observed = [...none, ...observedFor('v=DMARC1; p=reject')];
  const render = (lang: 'de' | 'en', variant: string) => {
    const o = observed.find((x) => x.checkId === 'MAIL-01' && x.variant === variant);
    if (!o) throw new Error(`no MAIL-01.${variant}`);
    const texts = loadTexts(lang);
    return {
      ...renderMessage(texts, `MAIL-01.${variant}`, o.params),
      action: formatMessage(texts.actions[`MAIL-01.${variant}`] ?? '', o.params, lang),
    };
  };

  it.each([
    ['de', /nur Berichte angefordert/, /rua-Adresse/],
    ['en', /only requests reports/, /rua address/],
  ] as const)(
    '%s: p=none without rua neither claims requested reports nor skips the rua step, and says so once',
    (lang, claim, rua) => {
      const policy = render(lang, 'policy-none');
      expect(policy.body).not.toMatch(claim);
      expect(policy.body).toMatch(rua);
      expect(policy.action).toMatch(rua);
      expect(none.map((o) => o.variant)).toEqual(['policy-none']);
    },
  );

  it.each(['de', 'en'] as const)(
    '%s: a missing rua under an enforcing policy still asks for action',
    (lang) => {
      expect(render(lang, 'weak-option').action).not.toMatch(/kein Handlungsbedarf|no action is needed/i);
    },
  );

  it.each([
    [
      'de',
      'DMARC-Option mit eingeschränkter Wirkung',
      /wurde eine Option mit eingeschränkter Wirkung beobachtet/,
    ],
    ['en', 'DMARC option with limited effect', /contains one option with limited effect/],
  ] as const)('%s: one weak option is counted in the singular', (lang, title, body) => {
    const weak = render(lang, 'weak-option');
    expect(weak.title).toBe(title);
    expect(weak.body).toMatch(body);
  });

  it.each(['de', 'en'] as const)(
    '%s: a missing record leads to quarantine or reject, not to p=none',
    (lang) => {
      const action = loadTexts(lang).actions['MAIL-01.record-not-found'] ?? '';
      expect(action).toMatch(/p=quarantine (oder|or) p=reject/);
      expect(action).not.toMatch(/\bgern\b|if you like/);
    },
  );
});
