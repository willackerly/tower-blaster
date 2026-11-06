// Undo on the GPU solver (roadmap U6): the game's own engine, pipelined, with warm starts and its
// pair buffers. Undo rebuilds the level and replays the kept shots, so after two shots the state is
// exactly the page's fresh replay of the first (handle.replay: a new engine built as the live one, on
// this device), and a restart is the level's start. L1 with a short pre-settle, so SwiftShader keeps up.
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
/** A marble well wide of the tower, then the par cannonball. */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const par = L1.solutions!.par![0] as Shot;

describe('undo on the GPU solver', () => {
  it('after two shots, U is the fresh replay of the first; R is the level start', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=gpu&offscreen=1&keystone.presettle=30', 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 10 * MINUTES);
    const start = await page.evaluate(() => window.__game.state());
    await page.evaluate(() => { window.__game.fast = true; });
    for (const [i, s] of [miss, par].entries()) {
      await ready(page, 10 * MINUTES);
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
      await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), i + 1, { timeout: 10 * MINUTES, polling: 250 });
    }
    const after = await page.evaluate(() => window.__game.state());
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 1, undefined, { timeout: 10 * MINUTES, polling: 250 });
    const undone = await page.evaluate(() => window.__game.state());
    expect(undone.hash).not.toBe(after.hash);
    const fresh = await page.evaluate((l) => window.__game.replay(l), [miss]);
    expect({ step: undone.step, hash: undone.hash, strokes: undone.strokes }).toEqual({ step: fresh.step, hash: fresh.hash, strokes: 1 });
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 0, undefined, { timeout: 10 * MINUTES, polling: 250 });
    expect(await page.evaluate(() => window.__game.state())).toEqual(start);
    expect(errors).toEqual([]);
    await page.close();
  }, 30 * MINUTES);
});
