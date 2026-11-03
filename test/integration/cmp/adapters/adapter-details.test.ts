/** Adapter facts: the Complianz version and the category set of a CookieHub installation (own simulators). */
import { describe, expect, it } from 'vitest';
import { waitForBanner, waitForCmp } from '../../../../src/cmp/index.ts';
import { decideAndAct, recognized, useCmpServer } from '../helpers.ts';

describe('Complianz: version', () => {
  const env = useCmpServer(['cmp/complianz']);

  it('a timestamp in the script URL does not become the version; the version of the config object does', async () => {
    const { page } = await env.open('https://www.complianz.test/ver-timestamp.html');
    const { detection } = await waitForCmp(page, { timeoutMs: 8000 });
    expect(detection.cmpId).toBe('complianz');
    expect(detection.version).toBe('7.5.6');
    expect(detection.versionSupported).not.toBe(false);
  });

  it('only a timestamp and no version in the config → no version', async () => {
    const { page } = await env.open('https://www.complianz.test/ver-timestamp-noconfig.html');
    const { detection } = await waitForCmp(page, { timeoutMs: 8000 });
    expect(detection.cmpId).toBe('complianz');
    expect(detection.version).toBeNull();
  });

  it('counterexample: a dotted version in the URL is still read when the config has none', async () => {
    const { page } = await env.open('https://www.complianz.test/');
    const { detection } = await waitForCmp(page, { timeoutMs: 8000 });
    expect(detection.version).toBe('7.1.0');
  });
});

describe('CookieHub: categories the installation does not offer', () => {
  const env = useCmpServer(['cmp/cookiehub']);

  it('accept on an installation without "preferences": verified by the categories that exist', async () => {
    const { page } = await env.open('https://www.cookiehub.test/no-preferences.html');
    const adapter = await recognized(page, 'cookiehub');
    await waitForBanner(page, adapter, { timeoutMs: 8000 });
    const { click } = await decideAndAct(page, adapter, 'accept');
    expect(click.clicked).toBe(true);
    const verify = await adapter.verify(page, 'accept');
    expect(verify.reason).toBeUndefined();
    expect(verify.verified).toBe(true);
    expect(verify.persistedAfterReload).toBe(true);
    expect(verify.method).toContain('categories-ignored:preferences');
  });

  it('reject on the same installation: verified by the categories that exist', async () => {
    const { page } = await env.open('https://www.cookiehub.test/no-preferences.html');
    const adapter = await recognized(page, 'cookiehub');
    await waitForBanner(page, adapter, { timeoutMs: 8000 });
    const { click } = await decideAndAct(page, adapter, 'reject');
    expect(click.clicked).toBe(true);
    const verify = await adapter.verify(page, 'reject');
    expect(verify.verified).toBe(true);
    expect(verify.persistedAfterReload).toBe(true);
  });

  it('counterexample: the full installation verifies the accept without any exclusion', async () => {
    const { page } = await env.open('https://www.cookiehub.test/');
    const adapter = await recognized(page, 'cookiehub');
    await waitForBanner(page, adapter, { timeoutMs: 8000 });
    await decideAndAct(page, adapter, 'accept');
    const verify = await adapter.verify(page, 'accept');
    expect(verify.verified).toBe(true);
    expect(verify.method.some((m) => m.startsWith('categories-ignored'))).toBe(false);
  });
});
