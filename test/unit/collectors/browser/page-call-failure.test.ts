/**
 * A failed call into the page leaves only the kind of failure: the page can throw its own data (a consent ID, a cookie
 * or storage value) from inside the call, and that text never reaches the snapshot or the logs.
 */
import { describe, expect, it } from 'vitest';
import { pageCallFailure, TimeoutError } from '../../../../src/collectors/browser/util.ts';

describe('the kind of a failed call into the page', () => {
  it.each([
    [
      'an error the page throws with its own data',
      new Error('Consent ID zqxkbmwf; _ga=GA1.2.3.4'),
      'evaluation failed',
    ],
    ['a thrown string', 'sessionId=zqx-0001', 'evaluation failed'],
    [
      'a destroyed execution context',
      new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
      'execution context destroyed',
    ],
    [
      'a closed page',
      new Error('page.evaluate: Target page, context or browser has been closed'),
      'page closed',
    ],
    ['a detached frame', new Error('frame.evaluate: Frame was detached'), 'frame detached'],
    ["Playwright's own timeout", new Error('page.evaluate: Timeout 3000ms exceeded.'), 'timed out'],
    [
      'the time limit of the call itself',
      new TimeoutError('cmp.extract', 250),
      'cmp.extract timed out after 250 ms',
    ],
  ])('%s', (_name, err, kind) => {
    expect(pageCallFailure(err)).toBe(kind);
  });

  it("counterexample: the page's text around a known failure is not kept either", () => {
    const kind = pageCallFailure(new Error('Execution context was destroyed: consent zqxkbmwf'));
    expect(kind).toBe('execution context destroyed');
    expect(kind).not.toContain('zqx');
  });
});
