// The grenade in the rack (roadmap G3.3) on the GPU solver, the game's default:
// the page plays a w-grenade line from the link, its fuse and blast run inside the
// Driver (keystone arsenal.ts), and the page's replay on the same device, with
// driverOptions('gpu') (pipelined read-back), pushes the same blast at the same step
// and ends bit for bit where the live session did. SwiftShader in CI; Metal with
// TB_CHANNEL=chrome. The f64 reference and Rapier cases are keystone-lab rack-grenade.test.ts.
import { describe, expect, it } from 'vitest';
import { PRESETTLE_STEPS, writeShots } from '@tb/keystone';
import { gamePage } from './page.ts';
import { GRENADE_LINE, GRENADE_RACK } from './rack-line.ts';

const MINUTES = 60_000;
const game = gamePage();

describe('grenade in the rack, GPU solver', () => {
  it('a grenade line plays from the link, blasts once, and replays bit-equal on the same device', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=gpu&offscreen=1&keystone.rack=${GRENADE_RACK.join(',')}&keystone.shots=${writeShots(GRENADE_LINE)}`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__game.engine)).toBe('gpu');
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), GRENADE_LINE.length, { timeout: 20 * MINUTES, polling: 250 });
    const live = await page.evaluate(() => window.__game.state());
    expect(live.step).toBeGreaterThan(PRESETTLE_STEPS);
    expect(live.strokes).toBe(GRENADE_LINE.length);
    // One blast, shown once (the page shakes on it), and the grenade's proximity fuse found the tower.
    expect(await page.evaluate(() => ({ fired: window.__game.counts.fired, blast: window.__game.counts.blast }))).toEqual({ fired: 1, blast: 1 });
    expect(await page.evaluate((s) => window.__game.replay(s), GRENADE_LINE)).toEqual(live);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 40 * MINUTES);
});
