// Nightly only (vitest.nightly.json, PHYSICS_GPU_SLOW=1): one case over the 300 s a CI file may take.
// The prefetch from the load (keystone.prefetch=aim, docs/game/level-start.md) on the GPU engine: the
// next level pre-settles on the same device, in gated batches, beside the level being played. The
// level played stays exact (a replay on a fresh engine reaches its state), and Next swaps in the
// state an unpaced reset gives (handle.replay([]), whose runSession resets unpaced).
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, playShots, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();

describe('level start on the GPU engine', () => {
  it('builds L2 beside L1 while it is played, and Next takes it as a fresh load', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=gpu&progress=off&keystone.prefetch=aim', 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__game.engine)).toBe('gpu');
    await ready(page, 10 * MINUTES);
    expect(await page.evaluate(() => window.__game.spare?.level)).toBe('L2');
    const line = L1.solutions!.par as Shot[];
    await playShots(page, line, 20 * MINUTES);
    const live = await page.evaluate(() => window.__game.state());
    expect(live.phase).toBe('cleared');
    expect(await page.evaluate((s) => window.__game.replay(s), line)).toEqual(live);
    await page.click('#result [data-act="next"]');
    await page.waitForFunction(() => window.__game.level === 'L2', undefined, { timeout: 20 * MINUTES, polling: 100 });
    await ready(page, 20 * MINUTES);
    const next = await page.evaluate(() => ({ state: window.__game.state(), prefetched: window.__game.timing.load.prefetched }));
    expect(next.prefetched).toBe(true);
    expect(await page.evaluate(() => window.__game.replay([]))).toEqual(next.state);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 60 * MINUTES);
});
