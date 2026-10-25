import { describe, expect, it } from 'vitest';
import { closeWithin } from '../src/index.ts';

const never = () => new Promise<void>(() => {});
const after = (ms: number, fail = false) => () => new Promise<void>((resolve, reject) => setTimeout(() => (fail ? reject(new Error('late failure')) : resolve()), ms));

describe('closeWithin', () => {
  it('runs every step in order and reports none stuck when all finish in time', async () => {
    const order: string[] = [], log: string[] = [];
    const stuck = await closeWithin([['a', async () => { order.push('a'); }], ['b', async () => { order.push('b'); }]], 200, (l) => log.push(l));
    expect(stuck).toEqual([]);
    expect(order).toEqual(['a', 'b']);
    expect(log).toEqual([]);
  });

  it('gives up on a step that never finishes, after its timeout, and still runs the next one', async () => {
    const log: string[] = [];
    let ranNext = false;
    const t0 = performance.now();
    const stuck = await closeWithin([['browser', never], ['server', async () => { ranNext = true; }]], 100, (l) => log.push(l));
    const ms = performance.now() - t0;
    expect(stuck).toEqual(['browser']);
    expect(ranNext).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(95);
    expect(ms).toBeLessThan(1000);
    expect(log).toEqual(['browser did not close within 0.1 s; leaving it']);
  });

  it('logs a step that fails in time and counts it as finished', async () => {
    const log: string[] = [];
    const stuck = await closeWithin([['browser', async () => { throw new Error('boom'); }], ['server', async () => {}]], 100, (l) => log.push(l));
    expect(stuck).toEqual([]);
    expect(log).toEqual(['browser failed to close: boom']);
  });

  it('logs, and does not throw, when a step it gave up on later finishes or fails', async () => {
    // A rejection after the timeout must not become an unhandled rejection (vitest fails the run on one).
    const log: string[] = [];
    const stuck = await closeWithin([['slow', after(150)], ['failing', after(150, true)]], 50, (l) => log.push(l));
    expect(stuck).toEqual(['slow', 'failing']);
    await new Promise((r) => setTimeout(r, 300));
    expect(log).toEqual([
      'slow did not close within 0.05 s; leaving it',
      'failing did not close within 0.05 s; leaving it',
      expect.stringMatching(/^slow closed after 0\.\d s$/),
      'failing failed to close (after its timeout): late failure',
    ]);
  });
});
