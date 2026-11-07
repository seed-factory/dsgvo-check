/**
 * `redactValueTokens` replaces what a consent dialog prints about the visitor (consent ID, UID, time stamp) by
 * `[redacted]` and keeps words, service names, dates and short numbers, so that PRIV-01 can still search the names.
 */
import { describe, expect, it } from 'vitest';
import { redactValueTokens } from '../../../../src/core/redaction/values.ts';
import { REDACTED } from '../../../../src/core/url/email.ts';
import { loadServiceCatalog } from '../../../../src/derive/catalog.ts';
import { expectLinearGrowth } from '../../../utils/scaling.ts';

/** The output of the first pass is a fixed point. */
function stable(input: string): string {
  const once = redactValueTokens(input);
  expect(redactValueTokens(once), `twice: ${JSON.stringify(input)}`).toBe(once);
  return once;
}

describe('redactValueTokens: identifiers of the visitor', () => {
  it.each([
    ['Borlabs UID', 'Ihre UID: 2ehm7qph-c6u7dyfb-kg1f9pqz-pumcvcyx', `Ihre UID: ${REDACTED}`],
    [
      'Cookiebot consent ID',
      'Ihre Einwilligungs-ID: 6XcFJRwFHQj0bMyIMtALUK8IGbZ0KsHDDPHx3eBbAdOoB4tVj35WWQ== Einwilligungsdatum',
      `Ihre Einwilligungs-ID: ${REDACTED} Einwilligungsdatum`,
    ],
    ['Usercentrics controller ID', 'Controller-ID: a1b2c3d4e5f6a7b8', `Controller-ID: ${REDACTED}`],
    ['a word after an ID label', 'UID: anonymous', `UID: ${REDACTED}`],
    ['an ID label with "="', 'consent id=abcdef', `consent id=${REDACTED}`],
    [
      'a UUID without a label',
      'Einwilligung 3f2a1b3c-9d4e-4f6a-8b7c-1d2e3f4a5b6c gespeichert',
      `Einwilligung ${REDACTED} gespeichert`,
    ],
    ['base64 without a digit', 'Kennung qWeRtYuIoPaSdFgHjK.', `Kennung ${REDACTED}.`],
    ['a time stamp in milliseconds', 'Zeitstempel 1730901234567', `Zeitstempel ${REDACTED}`],
    ['an ID split by a soft hyphen', 'Wert zq7­ab12cd34', `Wert ${REDACTED}`],
    ['an ID in brackets', '(Consent: zq7ab12cd34)', `(Consent: ${REDACTED})`],
  ])('%s', (_, input, expected) => {
    expect(stable(input)).toBe(expected);
  });
});

describe('redactValueTokens: counterexamples that stay as they are', () => {
  it.each([
    'Name Google Tag Manager Anbieter Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland',
    'Google Analytics 4, GA4, Matomo, 1&1 IONOS, reCAPTCHA v3, YouTube, LinkedIn Insight Tag',
    'Cookie Laufzeit: 2 Jahre, Ablauf nach 400 Tagen, gespeichert am 06.11.2026 um 10:21:33',
    'Datenschutzeinstellungen Einwilligungsverwaltung GoogleTagManager Datenschutzerklärung',
    'Cookie Name _ga,_gat,_gid borlabs-cookie CookieConsent __Secure-ENID',
    'https://policies.google.com/privacy Telefon +49 30 1234567',
    'Valid: ja, Android: aktuell',
  ])('%s', (text) => {
    expect(stable(text)).toBe(text);
  });

  it('no name or alias of the service catalog is changed, so the names of a dialog can still be searched', () => {
    const changed = [...loadServiceCatalog().byId.values()].flatMap((s) =>
      [s.name, ...(s.aliasesDe ?? []), ...(s.aliasesEn ?? [])].filter((t) => redactValueTokens(t) !== t),
    );
    expect(changed).toEqual([]);
  });

  it('grows linearly with the text', () => {
    const text = (n: number) => 'Name Google Tag Manager UID: 2ehm7qph-c6u7dyfb id id: '.repeat(n);
    expectLinearGrowth(
      () => redactValueTokens(text(400)),
      () => redactValueTokens(text(1600)),
    );
  });
});
