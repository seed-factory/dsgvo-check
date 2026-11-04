import { describe, expect, it } from 'vitest';
import { consent02 } from '../../../../../src/checks/browser/consent-02.ts';
import { fingerprint } from '../../../../../src/core/api.ts';
import { loadTexts } from '../../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../../src/core/data/messages.ts';
import { loadServiceCatalog } from '../../../../../src/derive/catalog.ts';
import { observationsOf, runCheck, variantsOf } from '../../../../utils/snapshot-builder.ts';
import type { SiteSpec } from '../helpers.ts';
import { click, cookie, phase, site, storage } from '../helpers.ts';
import { scenariosOf } from '../scenarios/index.ts';

/** Version of the catalog allowlist is catalog data: it changes with the allowlist. */
const ALLOWLIST = `allowlist-v${loadServiceCatalog().allowlistVersion}`;
const scenario = (file: string) =>
  scenariosOf('CONSENT-02')
    .find((s) => s.file === file)!
    .build();
const run = (phases: SiteSpec['phases']) => runCheck(consent02, site({ phases }));

describe('CONSENT-02 storage before interaction', () => {
  it('violation: _ga accepted → tracking-storage-accepted; consent cookie of the CMP is not a tracker', () => {
    const r = runCheck(consent02, scenario('violation-ga-cookie.json'));
    const obs = observationsOf(r);
    expect(obs.map((o) => [o.variant, o.subject])).toEqual([
      ['tracking-identifier-stored', '_ga|first-party|/|unpartitioned'],
    ]);
    expect(obs[0]).toMatchObject({
      serviceId: 'google-analytics',
      params: {
        name: '_ga',
        storageKind: 'cookie',
        party: 'first-party',
        dataset: `dsgvo-check-services ${loadServiceCatalog().version}`,
      },
    });
    expect(obs[0]?.evidence[0]).toMatchObject({
      type: 'cookie',
      name: '_ga',
      domain: 'first-party',
      state: 'accepted',
    });
    expect(JSON.stringify(obs)).not.toMatch(/value/i);
    expect(r.outcome?.coverage).toEqual({ note: `${ALLOWLIST}:not-evaluated=1` });
  });

  it('clean: only allowlisted session/CSRF/CMP cookies', () => {
    const r = runCheck(consent02, scenario('clean-allowlist-only.json'));
    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.coverage?.note).toBe(`${ALLOWLIST}:not-evaluated=9`);
  });

  it('consent-state keys of consentmanager, Usercentrics, Sourcepoint and Funding Choices on the CMP origin → nothing', () => {
    const snap = scenario('clean-allowlist-only.json');
    const phases = snap.browser?.phases ?? [];
    const cookieNames = phases.flatMap((p) => p.cookies.map((c) => c.name));
    const storageKeys = phases.flatMap((p) => p.storage.map((s) => s.key));

    expect(cookieNames).toEqual(
      expect.arrayContaining(['__cmpcpc', '__cmpcccx144007_expire', 'FCNEC', '_sp_su']),
    );
    expect(storageKeys).toEqual(expect.arrayContaining(['ucData_abc123', '_sp_local_state']));

    // The CMP state sits on the origin of the consent vendor, not on the target (third party).
    expect(phases.flatMap((p) => p.cookies).filter((c) => c.name === '__cmpcpc')).toMatchObject([
      { firstParty: false },
    ]);

    const r = runCheck(consent02, snap);

    expect(variantsOf(r)).toEqual([]);
    expect(r.outcome?.coverage?.note).toBe(`${ALLOWLIST}:not-evaluated=9`);
  });

  it('counterexample : an unknown key on the same CMP origin stays a finding', () => {
    const r = run([
      phase('A', {
        cookies: [
          cookie('__cmpcpc', { domain: 'cmp.consent-vendor.test', firstParty: false }),
          cookie('visitor_x', { domain: 'cmp.consent-vendor.test', firstParty: false }),
        ],
        storage: [
          storage('ucData_abc123', { origin: 'https://cmp.consent-vendor.test', firstParty: false }),
          storage('random_key_on_cmp_origin', {
            origin: 'https://cmp.consent-vendor.test',
            firstParty: false,
          }),
        ],
      }),
    ]);
    const obs = observationsOf(r);
    expect(obs.map((o) => o.variant)).toEqual(['unknown-third-party-persistent']);
    expect(obs[0]?.params.count).toBe(2);
    expect(obs[0]?.params.names).toContain('random_key_on_cmp_origin');
    expect(obs[0]?.params.names).toContain('visitor_x');
    expect(obs[0]?.params.names).not.toContain('__cmpcpc');
  });

  it('inconclusive: direct bot signal', () => {
    expect(runCheck(consent02, scenario('inconclusive-bot-mode.json'))).toMatchObject({
      status: 'inconclusive',
      reason: 'bot-mode',
    });
  });

  it('counterexample: _fbp rejected by the browser → tracking-storage-attempted (info), not accepted', () => {
    const r = run([
      phase('A', {
        cookies: [cookie('_fbp', { state: 'rejected', blockedReasons: ['ThirdPartyPhaseout'] })],
      }),
    ]);
    expect(variantsOf(r)).toEqual(['storage-rejected-or-attempted']);
  });

  it('counterexample: same name with different partition keys stays two facts', () => {
    const r = run([
      phase('A', {
        cookies: [
          cookie('IDE', { domain: 'doubleclick.net', firstParty: false, partitionKey: null }),
          cookie('IDE', { domain: 'doubleclick.net', firstParty: false, partitionKey: 'https://example.de' }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => o.subject)).toEqual([
      'IDE|doubleclick.net|/|partitioned',
      'IDE|doubleclick.net|/|unpartitioned',
    ]);
  });

  it('unknown persistent cookies: third party → warning variant, first party → info variant, session → nothing', () => {
    const r = run([
      phase('A', {
        cookies: [
          cookie('wpvp1', { domain: 'unknown-tracker.com', firstParty: false }),
          cookie('pref_x'),
          cookie('tmp_x', { lifetime: { kind: 'session' } }),
        ],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.count, o.params.names])).toEqual([
      ['unknown-third-party-persistent', 1, 'wpvp1 (cookie, unknown-tracker.com)'],
      ['unknown-first-party-persistent', 1, 'pref_x (cookie)'],
    ]);
  });

  it('several unclassified entries of one variant → one finding listing all, with evidence per entry and no values', () => {
    const r = runCheck(consent02, scenario('violation-unknown-persistent-list.json'));
    const obs = observationsOf(r);
    expect(obs.map((o) => [o.variant, o.params.count])).toEqual([
      ['unknown-third-party-persistent', 3],
      ['unknown-first-party-persistent', 3],
    ]);

    const [third, first] = obs;
    expect(third?.params.names).toBe(
      'other_id (cookie, other-tracker.net), wpvp1 (cookie, unknown-tracker.com), wpvp2 (localStorage, unknown-tracker.com)',
    );
    expect(first?.params.names).toBe('pref_a (cookie), pref_b (localStorage), pref_c (localStorage)');
    expect(
      third?.evidence.map((e) => (e as { name?: string; key?: string }).name ?? (e as { key?: string }).key),
    ).toEqual(['other_id', 'wpvp1', 'wpvp2']);
    expect(first?.pages).toEqual(['https://www.example.de/', 'https://www.example.de/kontakt']);
    expect(JSON.stringify(obs)).not.toMatch(/value/i);
  });

  it('counterexample: a tracking identifier next to unclassified entries keeps its own finding', () => {
    const r = run([phase('A', { cookies: [cookie('_ga'), cookie('pref_x'), cookie('pref_y')] })]);
    expect(observationsOf(r).map((o) => [o.variant, o.params.count ?? o.params.name])).toEqual([
      ['tracking-identifier-stored', '_ga'],
      ['unknown-first-party-persistent', 2],
    ]);
  });

  it('tracking keys in Web Storage count like cookies; allowlisted storage is not evaluated', () => {
    const r = run([phase('A', { storage: [storage('_gcl_ls'), storage('uc_settings')] })]);
    expect(observationsOf(r).map((o) => [o.variant, o.subject])).toEqual([
      ['tracking-identifier-stored', 'localStorage|_gcl_ls|first-party'],
    ]);
  });

  it('writes in phase B before the click (fresh profile, replication of A) count as before interaction', () => {
    const r = run([
      phase('A'),
      phase('B', {
        click: click('reject'),
        cookies: [cookie('_ga', { phase: 'B', afterClick: false })],
        storage: [storage('_gcl_ls', { phase: 'B', afterClick: false })],
      }),
    ]);
    expect(observationsOf(r).map((o) => [o.variant, o.subject, o.phases])).toEqual([
      ['tracking-identifier-stored', '_ga|first-party|/|unpartitioned', ['B']],
      ['tracking-identifier-stored', 'localStorage|_gcl_ls|first-party', ['B']],
    ]);
  });

  it('writes after the click in B or in C are not "before interaction"', () => {
    const r = run([
      phase('A'),
      phase('B', { click: click('reject'), cookies: [cookie('_ga', { phase: 'B', afterClick: true })] }),
      phase('C', { click: click('accept'), cookies: [cookie('_ga', { phase: 'C', afterClick: true })] }),
    ]);
    expect(variantsOf(r)).toEqual([]);
  });

  it('merges the same cookie across pages and keeps the strongest state', () => {
    const r = run([
      phase('A', {
        cookies: [
          cookie('_ga', { state: 'attempted' }),
          cookie('_ga', { state: 'accepted', pageUrl: 'https://www.example.de/kontakt' }),
        ],
      }),
    ]);
    const obs = observationsOf(r);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ variant: 'tracking-identifier-stored' });
    expect(obs[0]?.pages).toHaveLength(2);
  });
});

describe('CONSENT-02 listed entries', () => {
  const thirdParty = (name: string, p = {}) =>
    cookie(name, { domain: 'unknown-tracker.com', firstParty: false, ...p });
  const listed = (cookies: ReturnType<typeof cookie>[]) =>
    observationsOf(run([phase('A', { cookies })])).find(
      (o) => o.variant === 'unknown-third-party-persistent',
    )!;
  const fp = (subject: string) => fingerprint({ checkId: 'CONSENT-02', variantGroup: 'storage', subject });

  it('the subject names the entries: other entries give another fingerprint, the same entries the same one', () => {
    const a = listed([thirdParty('wpvp1'), thirdParty('wpvp2')]);
    const sameReordered = listed([thirdParty('wpvp2'), thirdParty('wpvp1')]);
    const other = listed([thirdParty('wpvp1'), thirdParty('wpvp3')]);

    expect(a.subject).toBe(
      'unknown-third-party-persistent-list:wpvp1|unknown-tracker.com|/|unpartitioned,wpvp2|unknown-tracker.com|/|unpartitioned',
    );
    expect(fp(sameReordered.subject)).toBe(fp(a.subject));
    expect(fp(other.subject)).not.toBe(fp(a.subject));
  });

  it('a single entry is named in the title', () => {
    const o = listed([thirdParty('wpvp1')]);
    expect(renderMessage(loadTexts('de'), 'CONSENT-02.unknown-third-party-persistent', o.params).title).toBe(
      'Dauerhafter Drittanbieter-Eintrag ohne Einordnung als Kennung vor einer Interaktion: wpvp1 (cookie, unknown-tracker.com)',
    );
    expect(renderMessage(loadTexts('en'), 'CONSENT-02.unknown-third-party-persistent', o.params).title).toBe(
      'Persistent third-party entry not classified as an identifier before any interaction: wpvp1 (cookie, unknown-tracker.com)',
    );
  });

  it('an entry the catalog lists for a service as no identifier is named with that service, not as unknown', () => {
    const o = listed([
      cookie('AEC', {
        domain: '.google.com',
        firstParty: false,
        lifetime: { kind: 'persistent', days: 180 },
      }),
      thirdParty('wpvp1'),
    ]);
    expect(o.params).toMatchObject({
      count: 2,
      knownCount: 1,
      knownNames: 'Google – AEC (cookie, google.com)',
      unknownCount: 1,
      unknownNames: 'wpvp1 (cookie, unknown-tracker.com)',
    });
    const de = renderMessage(loadTexts('de'), 'CONSENT-02.unknown-third-party-persistent', o.params).body;
    expect(de).toContain(
      'Laut Dienstekatalog einem Dienst zugeordnet und dort nicht als Kennung geführt: Google – AEC (cookie, google.com).',
    );
    expect(de).toContain(
      'Im Dienstekatalog nicht geführt: wpvp1 (cookie, unknown-tracker.com). Zweck bitte manuell prüfen.',
    );
  });

  it('counterexample: only catalog-known entries → no request to look up their purpose', () => {
    const o = listed([
      cookie('AEC', {
        domain: '.google.com',
        firstParty: false,
        lifetime: { kind: 'persistent', days: 180 },
      }),
    ]);
    const texts = loadTexts('de');
    expect(renderMessage(texts, 'CONSENT-02.unknown-third-party-persistent', o.params).body).not.toMatch(
      /manuell|nicht geführt:/,
    );
  });

  it('a cookie that expires within a day is no persistent entry', () => {
    const r = run([
      phase('A', { cookies: [thirdParty('short_x', { lifetime: { kind: 'persistent', days: 0 } })] }),
    ]);
    expect(variantsOf(r)).toEqual([]);
  });

  const googleCookie = (name: string) =>
    cookie(name, { domain: '.google.com', firstParty: false, lifetime: { kind: 'persistent', days: 180 } });
  const titleOf = (o: ReturnType<typeof listed>, lang: 'de' | 'en') =>
    renderMessage(loadTexts(lang), 'CONSENT-02.unknown-third-party-persistent', o.params).title;

  it('several entries: the title names their service when the catalog knows all of them, and the first keys', () => {
    const known = listed([googleCookie('AEC'), googleCookie('CONSENT')]);
    expect(known.params).toMatchObject({
      services: 'Google',
      allKnown: true,
      keys: 'AEC, CONSENT',
      moreKeys: 0,
    });
    expect(titleOf(known, 'de')).toBe(
      '2 dauerhafte Einträge von Google ohne Einordnung als Kennung vor einer Interaktion: AEC, CONSENT',
    );
    expect(titleOf(known, 'en')).toBe(
      '2 persistent entries of Google not classified as identifiers before any interaction: AEC, CONSENT',
    );
    // The group heading of the full report reads the shared service from the params.
    expect(known.params.service).toBe('Google');

    const many = listed(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((n) => thirdParty(n)));
    expect(titleOf(many, 'de')).toBe(
      '7 dauerhafte Drittanbieter-Einträge ohne Einordnung als Kennung vor einer Interaktion: a1, a2, a3, a4, a5 und 2 weitere',
    );
  });

  it('the action names the known service and asks only about the unknown entries', () => {
    const texts = loadTexts('de');
    const action = (o: ReturnType<typeof listed>) =>
      formatMessage(texts.actions['CONSENT-02.unknown-third-party-persistent']!, o.params, 'de');

    const known = action(listed([googleCookie('AEC')]));
    expect(known).toMatch(
      /^Laden Sie Google erst nach einer Einwilligung oder nach einem Klick der Besucher/,
    );
    expect(known).not.toContain('Klären Sie');

    const mixed = action(listed([googleCookie('AEC'), thirdParty('wpvp1')]));
    expect(mixed).toMatch(/gespeichert werden\. Klären Sie, welche Dienste/);

    const unknown = action(listed([thirdParty('wpvp1')]));
    expect(unknown).toMatch(/^Klären Sie, welche Dienste/);
  });
});
