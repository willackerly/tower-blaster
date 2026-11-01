// The rack's line of real projectiles (rack-line.ts) on the GPU solver, the game's
// default: the page plays it from the link and its replay on the same device ends
// bit for bit where the live session did (driverOptions('gpu'): pipelined read-back).
// SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { describe, expect, it } from 'vitest';
import { PRESETTLE_STEPS, writeShots } from '@tb/keystone';
import { gamePage } from './page.ts';
import { PRESET_LINE, PRESET_RACK } from './rack-line.ts';

const MINUTES = 60_000;
const game = gamePage();

describe('real projectiles in the rack, GPU solver', () => {
  it('a line of presets plays from the link and replays bit-equal on the same device', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=gpu&offscreen=1&keystone.rack=${PRESET_RACK.join(',')}&keystone.shots=${writeShots(PRESET_LINE)}`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__game.engine)).toBe('gpu');
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), PRESET_LINE.length, { timeout: 20 * MINUTES, polling: 250 });
    const live = await page.evaluate(() => window.__game.state());
    expect(live.step).toBeGreaterThan(PRESETTLE_STEPS);
    expect(live.strokes).toBe(PRESET_LINE.length);
    expect(await page.evaluate((s) => window.__game.replay(s), PRESET_LINE)).toEqual(live);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 40 * MINUTES);
});
