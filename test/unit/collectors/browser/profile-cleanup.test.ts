import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserType } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchPhase } from '../../../../src/collectors/browser/launch/launch.ts';
import { defaultNetworkConfig } from '../../../../src/core/url/net.ts';

const fake = vi.hoisted(() => ({ dir: '', alive: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) =>
      args[0] === '/proc' ? ['987654'] : fs.readdirSync(...args),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      args[0] === '/proc/987654/cmdline'
        ? fake.alive
          ? `chrome\0--user-data-dir=${fake.dir}\0`
          : ''
        : fs.readFileSync(...args),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fake.alive = false;
});

describe('browser profile cleanup', () => {
  /** `process.kill` answers for the fake Chromium process: it exists until `fake.alive` is false, then ESRCH. */
  function stubProcessKill() {
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== 987654) throw new Error('unexpected pid');
      if (signal === 0 && !fake.alive) {
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });
  }

  /** Launches a phase on a Chromium whose `close()` never returns, so the cleanup has to kill and wait. */
  async function start() {
    const lines: string[] = [];
    const log = { debug: () => {}, info: () => {}, warn: (s: string) => lines.push(s), error: () => {} };
    const chromium = {
      launchPersistentContext: async (dir: string) => {
        fake.dir = dir;
        fake.alive = true;
        return { close: () => new Promise<void>(() => {}) };
      },
    } as unknown as BrowserType;

    const browser = await launchPhase(
      { chromium, sandbox: 'off', network: defaultNetworkConfig(), closeBudgetMs: 10, log },
      'UA',
    );
    stubProcessKill();

    return { browser, lines };
  }

  it('waits for the killed process to exit before removing its last write', async () => {
    const { browser, lines } = await start();
    const closing = browser.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // the process still runs: the profile stays, and a write that it makes now is not lost half-removed
    expect(existsSync(fake.dir)).toBe(true);
    writeFileSync(path.join(fake.dir, 'late-write'), 'data');
    fake.alive = false;
    await closing;

    expect(existsSync(fake.dir)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('stops waiting at the budget, warns once, and removes the profile', async () => {
    const { browser, lines } = await start();
    vi.useFakeTimers();

    const closing = browser.close();
    await vi.advanceTimersByTimeAsync(4_000);
    await closing;

    expect(existsSync(fake.dir)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/process.*(exit|running)/i);
  });
});
