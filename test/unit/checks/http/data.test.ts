/** Rendering of every emitted HDR-01 / TLS-01 / TLS-02 observation in de and en without unresolved placeholders. */
import { describe, expect, it } from 'vitest';
import { httpChecks } from '../../../../src/checks/http/index.ts';
import { loadTexts } from '../../../../src/core/data/load.ts';
import { formatMessage, renderMessage } from '../../../../src/core/data/messages.ts';
import { loadFixtures, observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';

describe('texts render for every emitted observation', () => {
  const observations = httpChecks
    .flatMap((check) => loadFixtures(check.module, check.id).map((fx) => runCheck(check, fx.snapshot)))
    .flatMap((r) => (r.outcome ? observationsOf(r) : []));

  it('every declared variant is emitted by a fixture', () => {
    const emitted = new Set(observations.map((o) => `${o.checkId}.${o.variant}`));
    const declared = httpChecks.flatMap((c) => c.variants.map((v) => `${c.id}.${v.variant}`));
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
      expect(action, key).not.toMatch(/^$|[{}]|undefined/);
    }
  });
});

// The front page shows the findings of one message as one entry; a param that differs between them is a list there.
describe('action and title of a shared entry', () => {
  const list = {
    url: 'https://www.example.test/',
    count: 2,
    header: 'Content-Security-Policy, Permissions-Policy',
    mechanism: 'content-security-policy, permissions-policy',
  };

  it.each([
    [
      'de',
      'Header Content-Security-Policy, Permissions-Policy nicht gefunden',
      /die Header Content-Security-Policy, Permissions-Policy/,
    ],
    [
      'en',
      'Headers Content-Security-Policy, Permissions-Policy not found',
      /the headers Content-Security-Policy, Permissions-Policy/,
    ],
  ] as const)('%s: HDR-01.header-missing names every missing header', (lang, title, action) => {
    const texts = loadTexts(lang);
    expect(renderMessage(texts, 'HDR-01.header-missing', list).title).toBe(title);
    const text = formatMessage(texts.actions['HDR-01.header-missing'] ?? '', list, lang);
    expect(text).toMatch(action);
    expect(text).not.toMatch(/Titel|title/);
  });

  it.each(['de', 'en'] as const)('%s: a single missing header gets its own action', (lang) => {
    const texts = loadTexts(lang);
    const single = { ...list, header: 'X-Content-Type-Options', mechanism: 'x-content-type-options' };
    expect(renderMessage(texts, 'HDR-01.header-missing', single).title).toMatch(
      /^Header X-Content-Type-Options /,
    );
    expect(formatMessage(texts.actions['HDR-01.header-missing'] ?? '', single, lang)).toMatch(/nosniff/);
  });

  // An http entry that already leads straight to https on another host is not told to redirect "directly".
  it.each([
    [
      'de',
      'other-host',
      /zuerst auf https desselben Hosts/,
      /Umleitung von http direkt auf einen anderen Host/,
    ],
    ['de', 'http-first-hop', /ohne Zwischenschritt über http/, /über einen Umweg/],
    [
      'de',
      'other-host, http-first-hop',
      /im ersten Schritt auf https desselben Hosts/,
      /nicht direkt auf https/,
    ],
    ['en', 'other-host', /first to https on the same host/, /straight to another host/],
    ['en', 'http-first-hop', /without an intermediate http step/, /via a detour/],
    ['en', 'other-host, http-first-hop', /on the same host in the first step/, /not directly to https/],
  ] as const)('%s: TLS-01.redirect-chain-detail with reason %s', (lang, reason, action, title) => {
    const texts = loadTexts(lang);
    const params = {
      host: 'example.test',
      url: 'http://example.test/',
      location: 'https://other.test/',
      reason,
    };
    expect(formatMessage(texts.actions['TLS-01.redirect-chain-detail'] ?? '', params, lang)).toMatch(action);
    expect(renderMessage(texts, 'TLS-01.redirect-chain-detail', params).title).toMatch(title);
  });

  it.each([
    ['de', 'cn', /nennt nur im Feld CN: default\.hoster\.example\./],
    ['de', 'none', /nennt keinen Hostnamen\./],
    ['en', 'cn', /only its CN field names default\.hoster\.example\./],
    ['en', 'none', /does not name any host\./],
  ] as const)('%s: TLS-02 names a certificate without SAN by its %s', (lang, nameSource, text) => {
    const params = {
      host: 'www.example.test',
      nameMismatch: 'yes',
      nameSource,
      names: nameSource === 'cn' ? 'default.hoster.example' : '–',
      trustStore: 'node-bundled',
    };
    const body = renderMessage(loadTexts(lang), 'TLS-02.certificate-invalid', params).body;
    expect(body).toMatch(text);
    expect(body).not.toMatch(/: \./);
  });
});
