/** Rendering of every emitted MAIL-* observation in de and en without unresolved placeholders. */
import { describe, expect, it } from 'vitest';
import { dnsChecks } from '../../../../src/checks/dns/index.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../src/core/data/messages.ts';
import { checkFixtures } from '../../../utils/completeness.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { dnsSnapshot, type ZoneSpec } from './zone.ts';

/** Extra scenarios so that every declared variant is rendered at least once. */
const base: ZoneSpec = { 'MX example.de': ['10 mx.example.de'], 'TXT _dmarc.www.example.de': 'NXDOMAIN' };
const SCENARIOS: ZoneSpec[] = [
  {
    ...base,
    'TXT _dmarc.example.de': ['v=DMARC1; p=reject; t=y; pct=50; sp=none'],
    'TXT example.de': ['v=spf1 ptr'],
  },
  { ...base, 'TXT _dmarc.example.de': ['v=DMARC1; p=reject'], 'TXT example.de': ['v=spf1 ?all'] },
  {
    ...base,
    'MX example.de': ['0 .'],
    'TXT _dmarc.example.de': ['v=DMARC1; p=quarantine'],
    'TXT example.de': ['v=spf1 ~all'],
  },
  {
    ...base,
    'MX example.de': ['0 .'],
    'TXT _dmarc.example.de': ['v=DMARC1; p=bogus'],
    'TXT example.de': ['v=spf1'],
  },
];

describe('texts render for every emitted observation', () => {
  const fromFixtures = dnsChecks.flatMap((check) =>
    checkFixtures(check).map((fx) => runCheck(check, fx.snapshot)),
  );
  const fromScenarios = SCENARIOS.flatMap((spec) => dnsChecks.map((c) => runCheck(c, dnsSnapshot(spec))));
  const observations = [...fromFixtures, ...fromScenarios].flatMap((r) =>
    r.outcome ? observationsOf(r) : [],
  );

  it('every declared variant is emitted by a fixture or a scenario', () => {
    const emitted = new Set(observations.map((o) => `${o.checkId}.${o.variant}`));
    const declared = dnsChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
    expect(declared.filter((k) => !emitted.has(k))).toEqual([]);
  });

  it.each(['de', 'en'] as const)('%s: no unresolved {param} and no missing text', (lang) => {
    const texts = loadTexts(lang);
    for (const o of observations) {
      const m = renderMessage(texts, `${o.checkId}.${o.variant}`, o.params);
      expect(`${m.title} ${m.body}`, `${o.checkId}.${o.variant}`).not.toMatch(
        /[{}]|\[missing text|undefined/,
      );
    }
  });

  it.each(['de', 'en'] as const)('%s: the action text renders with the params of the finding', (lang) => {
    const texts = loadTexts(lang);
    for (const o of observations) {
      const key = `${o.checkId}.${o.variant}`;
      const action = formatMessage(texts.actions[key] ?? '', o.params, lang);
      expect(action, key).not.toMatch(/^$|^ |[{}]|undefined/);
    }
  });
});

describe('DMARC texts agree with each other', () => {
  const observedFor = (dmarc: string) => {
    const snapshot = dnsSnapshot({ ...base, 'TXT _dmarc.example.de': [dmarc], 'TXT example.de': 'NXDOMAIN' });
    return dnsChecks.flatMap((c) => {
      const r = runCheck(c, snapshot);
      return r.outcome ? observationsOf(r) : [];
    });
  };
  const observed = [...observedFor('v=DMARC1; p=none'), ...observedFor('v=DMARC1; p=reject')];
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
      const dmarc = observedFor('v=DMARC1; p=none').filter((o) => o.checkId === 'MAIL-01');
      expect(dmarc.map((o) => o.variant)).toEqual(['policy-none']);
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
