// WeaponSpec weapons in the rack (roadmap G3.4) on the GPU solver, the game's default:
// the page plays a firework line from the link, the GPU engine holds the firework's
// whole budget (gpuOptions: its shell and 12 stars), the split, blasts and removals run
// inside the Driver (keystone arsenal.ts, @tb/weapons WeaponRuntime), and the page's
// replay on the same device (driverOptions('gpu'): pipelined read-back) ends bit for bit
// where the live session did. SwiftShader in CI; Metal with TB_CHANNEL=chrome. The f64
// reference and Rapier cases are keystone-lab rack-weapons.test.ts.
import { describe, expect, it } from 'vitest';
import { PRESETTLE_STEPS, writeShots } from '@tb/keystone';
import { gamePage } from './page.ts';
import { FIREWORK_LINE, FIREWORK_RACK } from './rack-line.ts';

const MINUTES = 60_000;
const game = gamePage();

describe('WeaponSpec weapons in the rack, GPU solver', () => {
  it('a firework line plays from the link, its 12 stars blast, and it replays bit-equal on the same device', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=gpu&offscreen=1&keystone.rack=${FIREWORK_RACK.join(',')}&keystone.shots=${writeShots(FIREWORK_LINE)}`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__game.engine)).toBe('gpu');
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), FIREWORK_LINE.length, { timeout: 20 * MINUTES, polling: 250 });
    const live = await page.evaluate(() => window.__game.state());
    expect(live.step).toBeGreaterThan(PRESETTLE_STEPS);
    expect(live.strokes).toBe(FIREWORK_LINE.length);
    // Twelve stars, each blast shown once; the shell and every star drawn (the driver's body list) and gone.
    expect(await page.evaluate(() => ({ fired: window.__game.counts.fired, blast: window.__game.counts.blast, bodies: window.__game.bodies }))).toEqual({ fired: 1, blast: 12, bodies: 40 + 13 });
    expect(await page.evaluate((s) => window.__game.replay(s), FIREWORK_LINE)).toEqual(live);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 40 * MINUTES);
});
