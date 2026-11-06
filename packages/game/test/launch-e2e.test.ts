// Where shots leave from and how fired balls are drawn, on the game page
// (Will's 2026-11-06 playtest: shots from the ground-level launcher ran into
// the rubble, and the big balls looked like the bombs). The launcher opens
// high over the structure (keystone.launch=high, the default; level is the
// level's own), keys W and S move it a whole h within the level's range, and
// the aimed shot records the height. Fired balls are painted with a band
// (keystone.balls=painted, the default; plain is the look's), weapons stay
// bombs, and an undo (from a checkpoint, or replaying) draws the kept shots' bodies as they were. Rapier,
// headless Chromium.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, L1, type Shot } from '@tb/keystone';
import { launchRange } from '../src/aim.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const BASE = '/?level=L1&engine=rapier&look=candy&offscreen=1';
const range = launchRange(compileLevel(L1));
/** Shots well wide of the tower: they change nothing but the step count and the rack. */
const wide = (ammo: Shot['ammo']): Shot => ({ ammo, az: 0, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot);

const launch = (page: Page) => page.evaluate(() => window.__game.input.launch);
const aimedY = (page: Page) => page.evaluate(() => { const a = window.__game.aim(0, 0.2); return a && 'y' in a.shot ? a.shot.y : null; });
const settled = (page: Page, strokes: number) => page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), strokes, { timeout: 2 * MINUTES, polling: 100 });

describe('launch height on the game page', () => {
  it('opens high over the structure; W and S move it one h, kept to the level\'s range; the aimed shot records it; the HUD says it', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(range).toMatchObject({ low: 8, high: 48 });
    expect(await aimedY(page)).toBe(range.high);
    expect(await launch(page)).toBe(range.high);
    expect(await page.evaluate(() => document.querySelector('.kg-hud, #hud')?.textContent ?? '')).toMatch(/Height\s*WS?\s*.*6\.0 m/);
    await page.keyboard.press('w');
    expect(await aimedY(page)).toBe(range.high + 4);
    for (let k = 0; k < 30; k++) await page.keyboard.press('s');
    expect(await aimedY(page)).toBe(range.low);
    for (let k = 0; k < 100; k++) await page.keyboard.press('w');
    expect(await aimedY(page)).toBe(range.top);
    // A restart keeps the player's height (the same level and mode).
    await page.keyboard.press('r');
    await ready(page);
    expect(await launch(page)).toBe(range.top);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('keystone.launch=level: the level\'s own launcher, as before', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.launch=level`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.launch)).toBe('level');
    expect(await aimedY(page)).toBe(range.low);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);
});

describe('fired balls on the game page', () => {
  // Both undo paths: a checkpoint (the default, instant) and a replay of the kept shots (keystone.undo=0).
  it.for([['checkpoint', ''], ['replay', '&keystone.undo=0']] as const)('balls are painted and a weapon is a bomb; an undo (%s) draws the kept shots\' bodies as they were', { timeout: 8 * MINUTES }, async ([mode, undoKey], ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.rack=cannonball,w-grenade,marble${undoKey}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__game.fast = true; });
    for (const [i, s] of [wide('cannonball'), wide('w-grenade'), wide('marble')].entries()) {
      await ready(page);
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
      await settled(page, i + 1);
    }
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['painted', 'bomb', 'painted']);
    await page.keyboard.press('u');
    await page.waitForFunction(() => window.__game.strokes === 2 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.undone?.mode)).toBe(mode);
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['painted', 'bomb']);
    // A restart clears them.
    await page.keyboard.press('r');
    await ready(page);
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('keystone.balls=plain: balls drawn as the look draws them; a weapon is still a bomb', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.balls=plain&keystone.rack=cannonball,w-grenade`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__game.fast = true; });
    for (const [i, s] of [wide('cannonball'), wide('w-grenade')].entries()) {
      await ready(page);
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
      await settled(page, i + 1);
    }
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['plain', 'bomb']);
    expect(errors).toEqual([]);
    await page.close();
  }, 8 * MINUTES);
});
