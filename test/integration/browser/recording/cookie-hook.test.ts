/**
 * The `document.cookie` hook logs where a cookie is written: the hostname of the DOCUMENT that runs the script and the
 * parsed `Domain=`, next to the name and the calling script. The log never holds a cookie value.
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHookInit, cookieWritesInPage } from '../../../../src/collectors/browser/in-page/storage.ts';
import { type FixtureServer, startFixtureServer } from '../../../fixture-server/server.ts';
import { launchTestBrowser, type TestBrowser } from '../../../utils/browser.ts';
import { page as html, type SiteDir, writeSite } from '../site-dir.ts';

const TAG = `
  document.cookie = 'uid=zq7value1; Path=/';
  document.cookie = '_dom=zq7value2; Domain=.Example.TEST; Path=/; Secure';
  document.cookie = '_gone=zq7value3; Max-Age=0; Domain=example.test';
  cookieStore.set({ name: '_cs', value: 'zq7value4', domain: 'example.test' });
  cookieStore.set('_cs2', 'zq7value5');
`;

let server: FixtureServer;
let sites: SiteDir[] = [];
let browser: TestBrowser;
let tab: Page;

beforeAll(async () => {
  // The first-party page loads the vendor tag itself and in a third-party frame that loads it too.
  const first = writeSite({
    'index.html': html(
      `<script src="https://tags.vendor.test/tag.js"></script><iframe src="https://widget.example.net/frame.html"></iframe>`,
    ),
  });
  const vendor = writeSite({ 'tag.js': TAG });
  const widget = writeSite({
    'frame.html': html(`<script src="https://tags.vendor.test/tag.js"></script>`),
  });
  sites = [first, vendor, widget];
  server = await startFixtureServer({
    hosts: {
      'www.example.test': first.root,
      'tags.vendor.test': vendor.root,
      'widget.example.net': widget.root,
    },
  });

  browser = await launchTestBrowser(server);
  await browser.context.addInitScript(cookieHookInit);
  tab = await browser.context.newPage();
  await tab.goto('https://www.example.test/');
  await tab.waitForLoadState('load');
  await tab.waitForTimeout(500);
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  for (const s of sites) s.cleanup();
});

const writesOf = (host: string) => {
  const frame = tab.frames().find((f) => f.url().includes(host));
  if (!frame) throw new Error(`no frame for ${host}`);
  return frame.evaluate(cookieWritesInPage);
};

describe('cookie-write log', () => {
  it('records the hostname of the document and the script that wrote the cookie', async () => {
    const writes = await writesOf('www.example.test');
    const uid = writes.find((w) => w.name === 'uid');
    expect(uid).toMatchObject({
      host: 'www.example.test',
      domain: null,
      script: 'https://tags.vendor.test/tag.js',
      deletion: false,
    });
  });

  it('records the Domain attribute without dot and in lower case', async () => {
    const writes = await writesOf('www.example.test');
    expect(writes.find((w) => w.name === '_dom')).toMatchObject({
      host: 'www.example.test',
      domain: 'example.test',
    });
    expect(writes.find((w) => w.name === '_gone')).toMatchObject({ domain: 'example.test', deletion: true });
  });

  it('records host and domain of cookieStore.set as well', async () => {
    const writes = await writesOf('www.example.test');
    expect(writes.find((w) => w.name === '_cs')).toMatchObject({
      host: 'www.example.test',
      domain: 'example.test',
    });
    expect(writes.find((w) => w.name === '_cs2')).toMatchObject({ host: 'www.example.test', domain: null });
  });

  it('the same script inside a third-party frame logs the host of that frame', async () => {
    const writes = await writesOf('widget.example.net');
    expect(writes.find((w) => w.name === 'uid')).toMatchObject({
      host: 'widget.example.net',
      script: 'https://tags.vendor.test/tag.js',
    });
  });

  it('never holds a cookie value', async () => {
    const all = JSON.stringify([
      ...(await writesOf('www.example.test')),
      ...(await writesOf('widget.example.net')),
    ]);
    expect(all).not.toContain('zq7');
  });
});
