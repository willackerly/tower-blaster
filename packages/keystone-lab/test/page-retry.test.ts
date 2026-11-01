// The cast page's lost-page recovery (page-retry.ts): which errors count as a
// lost page, and that a lost page is reopened and the run replayed while any
// other error is thrown at once. The real path (a page navigated away or
// closed under a batch) runs in cast-gpu.test.ts.
import { describe, expect, it } from 'vitest';
import { isPageLost, withPageRetry } from '../src/page-retry.ts';

const lost = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');

describe('isPageLost', () => {
  it('matches the ways Playwright reports a page going away, and the GPU device going away', () => {
    for (const m of [
      'page.evaluate: Execution context was destroyed, most likely because of a navigation',
      'page.evaluate: Target page, context or browser has been closed',
      'page.evaluate: Target closed',
      'page.evaluate: Target crashed',
      'Page crashed',
      'frame got detached',
      'GPU device lost: Device was destroyed.',
    ]) expect(isPageLost(new Error(m)), m).toBe(true);
  });
  it('does not match a failed play', () => {
    for (const m of ['the cast page is not ready', 'readShots: shot 2 is not whole', 'level B9 is not known', 'Cannot read properties of undefined'])
      expect(isPageLost(new Error(m)), m).toBe(false);
    expect(isPageLost('a string, not an error')).toBe(false);
  });
});

describe('withPageRetry', () => {
  it('returns at once when the run succeeds, without reopening', async () => {
    let reopened = 0;
    expect(await withPageRetry(async () => 7, async () => { reopened++; })).toBe(7);
    expect(reopened).toBe(0);
  });

  it('reopens after a lost page and returns the replayed run, reporting each loss', async () => {
    let runs = 0, reopened = 0;
    const seen: number[] = [];
    const v = await withPageRetry(async () => { if (++runs < 3) throw lost; return runs; }, async () => { reopened++; },
      { onLost: (_e, n) => seen.push(n) });
    expect(v).toBe(3);
    expect(reopened).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it('gives up after `retries` reopens with the count and the last error as the cause', async () => {
    let runs = 0;
    const e = await withPageRetry(async () => { runs++; throw lost; }, async () => undefined, { retries: 1 }).catch((x: unknown) => x as Error);
    expect(runs).toBe(2);
    expect(e.message).toMatch(/lost 2 times in one batch; last: .*Execution context was destroyed/);
    expect(e.cause).toBe(lost);
  });

  it('throws any other error at once, without reopening', async () => {
    let runs = 0, reopened = 0;
    await expect(withPageRetry(async () => { runs++; throw new Error('level B9 is not known'); }, async () => { reopened++; })).rejects.toThrow('B9');
    expect([runs, reopened]).toEqual([1, 0]);
  });

  it('throws a failed reopen as it is', async () => {
    await expect(withPageRetry(async () => { throw lost; }, async () => { throw new Error('browser has been closed'); })).rejects.toThrow('browser has been closed');
  });
});
