import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { classifyFirstLayer, detectCmp, extract, loadLexicon } from '../../../src/cmp/index.ts';
import { CmpBridge } from '../../../src/collectors/browser/cmp-bridge.ts';
import { DEFAULT_CLASSIFY } from '../../utils/classify.ts';
import { useCmpServer } from './helpers.ts';

const URL = 'https://www.cookiebot.test/click-safety';
const DECLINE = '#CybotCookiebotDialogBodyButtonDecline';

const FORM = '<form id="submit-fixture" action="/submitted" method="post">';
const inForm = (attributes: string) => ({ before: FORM, attributes, after: '</form>' });

async function plannedReject(
  page: Page,
  { before = '', attributes = 'type="button"', after = '', rewriteDocument = false } = {},
) {
  await page.route(URL, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html>
        <script>window.Cookiebot = {hasResponse:false,consent:{preferences:false,statistics:false,marketing:false}};</script>
        <div id="CybotCookiebotDialog" style="position:fixed;bottom:0;height:128px;background:white;">
          <p>Diese Website verwendet Cookies.</p>
          ${before}
          <span id="reject-label" hidden>Ablehnen</span>
          <button id="CybotCookiebotDialogBodyButtonDecline" ${attributes} aria-labelledby="reject-label"
            onclick="document.body.dataset.pressed = this.textContent">Ablehnen</button>
          ${after}
          <button id="CybotCookiebotDialogBodyButtonAccept" type="button">Alle akzeptieren</button>
        </div>`,
    }),
  );
  await page.goto(URL);
  if (rewriteDocument) await page.setContent(await page.content());

  const { adapter, detection } = await detectCmp(page);
  expect(detection.recognitionConfidence).toBe('high');
  if (!adapter?.act) throw new Error('Cookiebot adapter not recognized');
  const facts = await extract(page, adapter, 'first-screen', { phase: 'B' });
  const target = classifyFirstLayer(facts, loadLexicon(), DEFAULT_CLASSIFY).targets?.reject;
  if (!target) throw new Error('No reject target');
  return { adapter, target };
}

const pressed = (page: Page) => page.locator('body').getAttribute('data-pressed');

describe('CMP click safety', () => {
  const env = useCmpServer(['cmp/cookiebot']);

  it.each([
    ['explicit submit type', inForm('type="submit"')],
    ['default submit type', inForm('')],
    ['form attribute', { before: `${FORM}</form>`, attributes: 'form="submit-fixture"' }],
  ])('a reject button cannot submit a native form through %s', async (_name, form) => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const posts: string[] = [];
    await page.route('**/submitted', (route) => {
      posts.push(route.request().method());
      return route.fulfill({ body: 'Submitted' });
    });
    const { adapter, target } = await plannedReject(page, form);

    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: false });
    expect(posts).toEqual([]);
  });

  it('still clicks a non-submit button inside a form', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const { adapter, target } = await plannedReject(page, inForm('type="button"'));

    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: true });
    expect(await pressed(page)).toBe('Ablehnen');
  });

  it.each(['label', 'role'] as const)('does not reuse a selector after its %s changes', async (changed) => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const { adapter, target } = await plannedReject(page);
    await page.locator(DECLINE).evaluate((button, change) => {
      if (change === 'label') {
        button.textContent = 'Alle akzeptieren';
        button.removeAttribute('aria-labelledby');
      } else button.setAttribute('role', 'link');
    }, changed);

    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: false });
    expect(await pressed(page)).toBeNull();
  });

  it.each(['submit type', 'external accessible label', 'role'] as const)(
    'cancels the click when its still-connected target changes %s while disabled',
    async (change) => {
      const { page } = await env.open('https://www.cookiebot.test/');
      const requests: string[] = [];
      await page.route('**/submitted', (route) => {
        requests.push(route.request().method());
        return route.fulfill({ body: 'Submitted' });
      });
      const { adapter, target } = await plannedReject(page, inForm('type="button"'));
      const button = page.locator(DECLINE);
      await button.evaluate((el) => el.setAttribute('disabled', ''));
      const pending = adapter.act?.(page, 'reject', target, { timeoutMs: 2_000 });
      await button.evaluate((el, mutation) => {
        setTimeout(() => {
          if (mutation === 'submit type') el.setAttribute('type', 'submit');
          else if (mutation === 'role') el.setAttribute('role', 'link');
          else el.ownerDocument.getElementById('reject-label')!.textContent = 'Alle akzeptieren';
          el.removeAttribute('disabled');
        }, 350);
      }, change);

      expect(await pending).toMatchObject({ clicked: false });
      expect(await pressed(page)).toBeNull();
      expect(requests).toEqual([]);
    },
  );

  it.each([
    ['pointermove', 'none'],
    ['pointerdown', 'none'],
    ['pointermove', 'patched listener registration'],
    ['pointermove', 'earlier capture listener'],
  ] as const)('blocks a submit type change on %s with %s', async (eventType, interference) => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const requests: string[] = [];
    await page.route('**/submitted', (route) => {
      requests.push(route.request().method());
      return route.fulfill({ body: 'Submitted' });
    });
    const { adapter, target } = await plannedReject(page, inForm('type="button"'));
    await page.locator(DECLINE).evaluate(
      (button, options) => {
        button.addEventListener(options.eventType, () => button.setAttribute('type', 'submit'), {
          once: true,
        });
        const w = globalThis as unknown as {
          addEventListener(
            type: string,
            listener: (event: { stopImmediatePropagation(): void }) => void,
            capture: boolean,
          ): void;
        };
        if (options.interference === 'patched listener registration') w.addEventListener = () => {};
        if (options.interference === 'earlier capture listener') {
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'submit']) {
            w.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
          }
        }
      },
      { eventType, interference },
    );

    const submitted = page.waitForURL('**/submitted', { timeout: 700 }).catch(() => undefined);
    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: false });
    await submitted;
    expect(requests).toEqual([]);
    expect(await pressed(page)).toBeNull();
  });

  it('does not activate an interactive descendant at the click point', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    await page.route('**/submitted', (route) => route.fulfill({ body: 'Submitted' }));
    const { adapter, target } = await plannedReject(page);
    await page.locator(DECLINE).evaluate((button) => {
      button.setAttribute('style', 'position:relative');
      button.innerHTML = '<a href="/submitted" style="position:absolute;inset:0">Ablehnen</a>';
    });

    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: false });
    expect(page.url()).toBe(URL);
    expect(await pressed(page)).toBeNull();
  });

  it('does not dispatch a click after document.open removes the input listeners', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const { adapter, target } = await plannedReject(page, { rewriteDocument: true });

    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: false });
    expect(await pressed(page)).toBeNull();
  });

  it('does not click a measured target in a new document at the same URL', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const { adapter, target } = await plannedReject(page);
    await page.reload();

    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: false });
    expect(await pressed(page)).toBeNull();
  });

  it('does not scroll to a control that moved below the first screen', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const { adapter, target } = await plannedReject(page);
    await page.locator('#CybotCookiebotDialog').evaluate((dialog) => {
      dialog.setAttribute('style', 'position:absolute;top:2000px');
    });

    expect(await adapter.act?.(page, 'reject', target, { timeoutMs: 1_000 })).toMatchObject({
      clicked: false,
    });
    expect(await page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY)).toBe(0);
    expect(await pressed(page)).toBeNull();
  });

  it('records a trusted consent click that navigates to another document', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    await page.route('**/after-click', (route) => route.fulfill({ body: 'New document' }));
    const { adapter, target } = await plannedReject(page);
    await page.locator(DECLINE).evaluate((button) => {
      button.setAttribute('onclick', 'location.href="/after-click"');
    });

    const destination = page.waitForURL('**/after-click');
    expect(await adapter.act?.(page, 'reject', target)).toMatchObject({ clicked: true });
    await destination;
  });

  it('a timed-out state read cannot resume and click later', async () => {
    const { page } = await env.open('https://www.cookiebot.test/');
    const { adapter, target } = await plannedReject(page);
    await page.evaluate(() => {
      const { Cookiebot } = globalThis as unknown as { Cookiebot: object };
      Object.defineProperty(Cookiebot, 'hasResponse', {
        get() {
          const end = performance.now() + 150;
          while (performance.now() < end) {}
          return false;
        },
      });
    });

    let pending: ReturnType<NonNullable<typeof adapter.act>> | undefined;
    const bridge = new CmpBridge(
      {} as ConstructorParameters<typeof CmpBridge>[0],
      20,
      [],
      'B',
      DEFAULT_CLASSIFY,
    );
    const wrapped = {
      ...adapter,
      act: (...args: Parameters<NonNullable<typeof adapter.act>>) => {
        pending = adapter.act!(...args);
        return pending;
      },
    };
    expect(await bridge.act(page, wrapped, 'reject', { ...target, cmpId: 'cookiebot' }, URL)).toBeNull();
    await pending;
    expect(await pressed(page)).toBeNull();
  });
});
