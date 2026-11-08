/** Adapter facts: the Complianz version and the category set of a CookieHub installation (own simulators). */
import { describe, expect, it } from 'vitest';
import { waitForCmp } from '../../../../src/cmp/index.ts';
import { decideAndAct, useCmpServer } from '../helpers.ts';

describe('Complianz: version', () => {
  const env = useCmpServer(['cmp/complianz']);

  it.each([
    ['script timestamp and config version', 'ver-timestamp.html', '7.5.6'],
    ['only a timestamp', 'ver-timestamp-noconfig.html', null],
    ['dotted version in the script URL', '', '7.1.0'],
  ])('reads the version with %s', async (_name, file, version) => {
    const { page } = await env.open(`https://www.complianz.test/${file}`);
    const { detection } = await waitForCmp(page, { timeoutMs: 8000 });
    expect(detection).toMatchObject({ cmpId: 'complianz', version });
    if (file === 'ver-timestamp.html') expect(detection.versionSupported).not.toBe(false);
  });
});

describe('CookieHub: categories the installation does not offer', () => {
  const env = useCmpServer(['cmp/cookiehub']);

  const open = (file: string) =>
    env.openRecognized(`https://www.cookiehub.test/${file}`, 'cookiehub', { banner: true });

  it.each(['accept', 'reject'] as const)(
    '%s verifies on an installation without preferences',
    async (action) => {
      const { page, adapter } = await open('no-preferences.html');
      const { click } = await decideAndAct(page, adapter, action);
      expect(click.clicked).toBe(true);
      const verify = await adapter.verify(page, action);
      expect(verify).toMatchObject({ verified: true, persistedAfterReload: true });
      if (action === 'accept') {
        expect(verify.reason).toBeUndefined();
        expect(verify.method).toContain('categories-ignored:preferences');
      }
    },
  );

  it('counterexample: the full installation verifies the accept without any exclusion', async () => {
    const { page, adapter } = await open('');
    await decideAndAct(page, adapter, 'accept');
    const verify = await adapter.verify(page, 'accept');
    expect(verify.verified).toBe(true);
    expect(verify.method.some((m) => m.startsWith('categories-ignored'))).toBe(false);
  });
});
