/**
 * The browser collector reads the text of a consent dialog that its own adapter recognised, once in phase A and without
 * a click, with the collapsed Cookie-Details, and stores it redacted: the UID the dialog prints never reaches the
 * snapshot. PRIV-01 then reports the service only the dialog names as `named-in-cmp-only`; the service it does not name
 * stays `not-named`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { priv01 } from '../../../../src/checks/browser/priv-01.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { observationsOf, runCheck } from '../../../utils/snapshot-builder.ts';
import { type CollectRun, collect, persisted, snapshotOf } from '../helpers.ts';

const START = 'https://www.borlabs.test/details.html';

describe('Borlabs dialog with collapsed Cookie-Details through the browser collector', () => {
  let server: FixtureServer;
  let run: CollectRun;

  beforeAll(async () => {
    server = await startFixtureServer({ sites: ['cmp/borlabs'] });
    run = await collect(server, { url: START });
  });

  afterAll(async () => {
    await server?.close();
  });

  const dialogText = () => run.result.sections.cmp?.dialogText;

  it('the snapshot carries the dialog text of the start page with its collapsed details', () => {
    expect(dialogText()).toMatchObject({
      id: 'cmp-dialog',
      cmpId: 'borlabs',
      cmpName: 'Borlabs Cookie',
      version: '3.2.1',
      phase: 'A',
      pageUrl: START,
      truncated: false,
    });
    expect(dialogText()?.text).toContain(
      'Cookie-Details Name Google Tag Manager Anbieter Google Ireland Limited',
    );
    expect(dialogText()?.text).toContain('Name Google AdWords');
  });

  it('the UID the dialog prints is redacted: nothing of it in the snapshot, the rest of the collection or the documents', () => {
    expect(dialogText()?.text).toMatch(/Ihre Einwilligungs-ID \(UID\): \[redacted\]$/);
    expect(persisted(run)).not.toContain('zq7');
  });

  it('reading it clicked nothing: no consent cookie in phase A, the policy and the Impressum were read as usual', () => {
    const a = run.result.sections.browser?.phases[0];
    expect(a?.click).toBeUndefined();
    expect(a?.cookies.map((c) => c.name)).not.toContain('borlabs-cookie');
    expect(run.result.sections.documents?.documents.map((d) => [d.kind, d.complete])).toEqual([
      ['impressum', true],
      ['privacy', true],
    ]);
  });

  it('PRIV-01: the Tag Manager only the dialog names → named-in-cmp-only; Google Analytics → not-named', () => {
    const observations = observationsOf(runCheck(priv01, snapshotOf(run)));
    expect(observations.map((o) => [o.subject, o.variant]).sort()).toEqual([
      ['google-analytics', 'not-named'],
      ['google-tag-manager', 'named-in-cmp-only'],
    ]);
    const gtm = observations.find((o) => o.subject === 'google-tag-manager');
    expect(gtm?.params).toMatchObject({ cmp: 'Borlabs Cookie', categoryOnly: false });
    expect(gtm?.params.cmpQuote).toContain('Google Tag Manager');
  });

  it('touches only declared hosts', () => {
    expect(server.unexpected).toEqual([]);
  });
});
