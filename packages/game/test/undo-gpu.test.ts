// Undo on the GPU solver (roadmap U6): the game's own engine, pipelined, with warm starts and its
// pair buffers. Undo restores the checkpoint taken as the last shot went in (GpuAvbdEngine.checkpoint:
// the carried GPU ranges copied on the queue), or with keystone.undo=0 rebuilds the level and replays
// the kept shots. Either way, after two shots the state is exactly the page's fresh replay of the first
// (handle.replay: a new engine built as the live one, on this device), the same second shot fired again
// gives exactly the state it gave before (the warm starts and contact history came back too), and a
// restart is the level's start. A rapid-fire shot undone mid-flight (checkpoint) lets the shot it cut
// play on to the replay's settle. L1 with a short pre-settle, so SwiftShader keeps up.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
/** A marble well wide of the tower, then the par cannonball. */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const par = L1.solutions!.par![0] as Shot;
const URL = '/?level=L1&engine=gpu&offscreen=1&keystone.presettle=30';
const settled = (page: Page, n: number) => page.waitForFunction((k) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === k), n, { timeout: 10 * MINUTES, polling: 250 });

describe.each([['checkpoint', ''], ['replay', '&keystone.undo=0']] as const)('undo on the GPU solver (%s)', (mode, extra) => {
  it('after two shots, U is the fresh replay of the first; the same shot again is the same state; R is the level start', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL + extra, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 10 * MINUTES);
    const start = await page.evaluate(() => window.__game.state());
    await page.evaluate(() => { window.__game.fast = true; });
    for (const [i, s] of [miss, par].entries()) {
      await ready(page, 10 * MINUTES);
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
      await settled(page, i + 1);
    }
    const after = await page.evaluate(() => window.__game.state());
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    expect(await page.evaluate(() => window.__game.undone!.mode)).toBe(mode);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 1, undefined, { timeout: 10 * MINUTES, polling: 250 });
    const undone = await page.evaluate(() => window.__game.state());
    expect(undone.hash).not.toBe(after.hash);
    const fresh = await page.evaluate((l) => window.__game.replay(l), [miss]);
    expect({ step: undone.step, hash: undone.hash, strokes: undone.strokes }).toEqual({ step: fresh.step, hash: fresh.hash, strokes: 1 });
    // The same second shot again: exactly where it went before the undo.
    expect(await page.evaluate((x) => window.__game.fire(x), par)).toBe(true);
    await settled(page, 2);
    expect(await page.evaluate(() => window.__game.state())).toEqual(after);
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 0, undefined, { timeout: 10 * MINUTES, polling: 250 });
    expect(await page.evaluate(() => window.__game.state())).toEqual(start);
    expect(errors).toEqual([]);
    await page.close();
  }, 30 * MINUTES);
});

describe('undo on the GPU solver, mid-flight', () => {
  it('a rapid shot undone while it runs puts the shot it cut back in flight, which settles where its replay does', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 10 * MINUTES);
    const at = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, at + 10, { timeout: 10 * MINUTES, polling: 50 });
    expect(await page.evaluate((s) => window.__game.fire(s), par)).toBe(true);
    await page.waitForFunction(() => window.__game.strokes === 2, undefined, { timeout: 10 * MINUTES, polling: 50 });
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    expect(await page.evaluate(() => [window.__game.undone!.mode, window.__game.phase, window.__game.strokes])).toEqual(['checkpoint', 'running', 1]);
    await page.evaluate(() => { window.__game.fast = true; });
    await settled(page, 1);
    const undone = await page.evaluate(() => window.__game.state());
    const fresh = await page.evaluate((l) => window.__game.replay(l), [miss]);
    expect({ step: undone.step, hash: undone.hash, strokes: undone.strokes }).toEqual({ step: fresh.step, hash: fresh.hash, strokes: 1 });
    expect(errors).toEqual([]);
    await page.close();
  }, 30 * MINUTES);
});
