/**
 * Some CMPs keep their dialog closed for browsers their own crawler test takes for bots (CCM19's `isBotBrowser`). The
 * scanner's honest User-Agent may match such a test; the facts then say so with a bot signal instead of leaving the
 * closed dialog unexplained. The test is the vendor's (test/data/cmp/adapters.yaml), the User-Agent the page's own, and
 * neither the User-Agent nor any part of it is stored.
 */
import type { Page } from 'playwright-core';
import { BOT_USER_AGENT_SIGNAL, type BotSignal, type BotUserAgentTest, type CmpFacts } from './types.ts';

/** Whether the vendor's test takes `userAgent` for a bot; false without a test or a User-Agent. */
export function matchesBotUserAgent(test: BotUserAgentTest | undefined, userAgent: string | null): boolean {
  if (!test || !userAgent) return false;
  return new RegExp(test.pattern, test.flags).test(userAgent);
}

/**
 * The bot signal of a dialog the recognised CMP did not open (`dialogNotOpened`) for a page whose User-Agent matches
 * the CMP's crawler test; null in every other case.
 */
export function dialogBotSignal(
  cmpId: string,
  test: BotUserAgentTest | undefined,
  facts: Pick<CmpFacts, 'detection' | 'firstLayer'>,
  userAgent: string | null,
): BotSignal | null {
  if (facts.detection.method !== 'adapter' || facts.firstLayer.dialogNotOpened !== true) return null;
  if (!test || !matchesBotUserAgent(test, userAgent)) return null;
  return { cmpId, signal: BOT_USER_AGENT_SIGNAL, detail: test.label };
}

/** In-page, self-contained. */
function pageUserAgent(): string {
  return (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent;
}

/**
 * The facts with the bot signal of `dialogBotSignal` added. The page's User-Agent is read only for a closed dialog of
 * an adapter with a crawler test; a page that cannot be read leaves the facts as they are.
 */
export async function withDialogBotSignal(
  page: Pick<Page, 'evaluate'>,
  adapter: { id: string; dialogBotUserAgent?: BotUserAgentTest | undefined },
  facts: CmpFacts,
): Promise<CmpFacts> {
  const test = adapter.dialogBotUserAgent;
  if (!test || facts.firstLayer.dialogNotOpened !== true) return facts;
  const userAgent = await page.evaluate(pageUserAgent).catch(() => null);
  const signal = dialogBotSignal(adapter.id, test, facts, userAgent);
  return signal ? { ...facts, botSignals: [...facts.botSignals, signal] } : facts;
}
