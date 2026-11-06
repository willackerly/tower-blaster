// The Siege Table on the game page (?duel=D1, docs/game/siege-table.md): the turn controller refuses a
// shot from the wrong side or out of turn, passes the turn at each settle, runs the duel's level to a
// result card, and Rematch starts the other side first. Eight sideways misses on Rapier: nothing is hit,
// so both keeps stand alike and the duel is a draw. The aids (duel-view.ts): each turn opens on the middle of
// its side, the camera swinging there when the turn passes (keystone.turnview=0 leaves it), the side's arc is
// dotted on the ground, and off the side the HUD and a refused shot say which way to drag. Headless Chromium.
import { describe, expect, it } from 'vitest';
import { D1, type Shot } from '@tb/keystone';
import { azFromYaw } from '../src/aim.ts';
import { yawOfAz } from '../src/duel-view.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();

/** A shot from azimuth az turned 90 degrees off the lot centre at low power: it lands beside the launcher, clear of both keeps. */
const miss = (az: number, ammo: Shot['ammo'] = 'cannonball'): Shot => ({ ammo, az, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot);
const WEST = 360, EAST = 0;

declare global { interface Window { __views?: { yaw: number; turning: boolean }[] } }

describe('game page, Siege Table', () => {
  it('takes turns by side, refuses the wrong side, ends in a draw on eight misses, and Rematch starts Blue', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?duel=D1&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => [window.__game.level, window.__game.duel?.turn, window.__game.duel?.first])).toEqual(['D1', 0, 0]);
    expect(await page.evaluate(() => document.querySelector('.kg-hud')!.textContent)).toMatch(/Gold to fire, from the west/);
    // The turn view: the duel opens on the middle of Gold's side, its arc dotted on the ground, and no cue.
    await page.waitForFunction(() => window.__game.view.arcBeads > 0, undefined, { timeout: 30_000 });
    const opening = await page.evaluate(() => window.__game.view);
    expect(azFromYaw(opening.yaw)).toBe(WEST);
    expect(opening).toMatchObject({ turning: false, cue: null });
    expect(opening.yaw).toBeCloseTo(yawOfAz(WEST), 12);
    // Every frame's view, to see the swing between turns.
    await page.evaluate(() => {
      const views: { yaw: number; turning: boolean }[] = window.__views = [];
      const f = () => { views.push({ yaw: window.__game.view.yaw, turning: window.__game.view.turning }); requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
    // Gold may not fire from Blue's side, nor a marble it does not have.
    expect(await page.evaluate((s) => window.__game.fire(s), miss(EAST))).toBe(false);
    expect(await page.evaluate((s) => window.__game.fire(s), { ...miss(WEST), ammo: 'marble' } as Shot)).toBe(false);
    // One shot per turn: rapid fire is off in a duel, and a second click while a shot runs is refused.
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(false);
    await page.evaluate(() => { window.__game.fast = true; });
    const order: number[] = [];
    for (let k = 0; k < 8; k++) {
      await ready(page, 120_000);
      const turn = await page.evaluate(() => window.__game.duel!.turn);
      order.push(turn);
      // Each turn's view comes to rest on the middle of its own side, with no cue.
      await page.waitForFunction(() => !window.__game.view.turning, undefined, { timeout: 60_000, polling: 100 });
      const v = await page.evaluate(() => window.__game.view);
      expect(azFromYaw(v.yaw)).toBe(turn === 0 ? WEST : EAST);
      expect(v.cue).toBeNull();
      expect(v.arcBeads).toBeGreaterThan(0);
      const ammo = k >= 6 ? 'w-grenade' : 'cannonball';
      const shot = miss(turn === 0 ? WEST : EAST, ammo);
      expect(await page.evaluate((s) => [window.__game.fire(s), window.__game.fire(s)], shot)).toEqual([true, false]);
    }
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 250 });
    expect(order).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    // It swung, not cut: frames between the turns drew the camera on its way, at yaws between the two sides'.
    const views = await page.evaluate(() => window.__views!);
    const between = views.filter((x) => x.turning && Math.abs(Math.cos(x.yaw)) > 0.05);
    expect(between.length).toBeGreaterThan(7 * 2);
    // Over: no arc, no cue.
    await page.waitForFunction(() => window.__game.view.arcBeads === 0, undefined, { timeout: 30_000 });
    const d = await page.evaluate(() => window.__game.duel!);
    expect(d).toMatchObject({ over: true, winner: null, why: 'both keeps stand alike', log: order });
    expect(d.sides.map((s) => [s.name, s.share, s.shotsLeft])).toEqual([['Gold', 1, 0], ['Blue', 1, 0]]);
    expect(await page.evaluate(() => document.querySelector('.kg-result')!.textContent)).toMatch(/A draw/);
    // Custom (a duel has no stars): nothing recorded.
    expect(await page.evaluate(() => Object.keys(window.__progress.progress.levels))).toEqual([]);

    await page.click('.kg-result [data-act="rematch"]');
    await page.waitForFunction(() => window.__game.level === 'D1-2', undefined, { timeout: 60_000 });
    await ready(page);
    expect(await page.evaluate(() => [window.__game.duel!.turn, window.__game.duel!.first, window.__game.strokes])).toEqual([1, 1, 0]);
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('duel'))).toBe(D1.id);
    // The rematch opens on Blue's side.
    expect(azFromYaw(await page.evaluate(() => window.__game.view.yaw))).toBe(EAST);
    expect(errors).toEqual([]);
    await page.close();
  }, 400_000);

  it('keystone.turnview=0 leaves the camera to the players; off the side the HUD and a refused shot say which way to drag', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?duel=D1&engine=rapier&look=candy&offscreen=1&progress=off&keystone.turnview=0&keystone.arcs=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => [window.__game.feel.turnView, window.__game.feel.arcs])).toEqual([false, false]);
    // The level's own opening view (view.ts viewOf: from 36 deg yaw, azimuth 108) is on Blue's side, not Gold's: the short way to the west (azimuth 200 on) is to drag right.
    const v0 = await page.evaluate(() => window.__game.view);
    expect(azFromYaw(v0.yaw)).toBe(108);
    await page.waitForFunction(() => window.__game.view.cue !== null, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => [window.__game.view.cue, window.__game.view.arcBeads])).toEqual(['right', 0]);
    expect(await page.evaluate(() => document.querySelector('.kg-hud .turn-cue')!.textContent)).toBe("Drag right ▸Two fingers right ▸ to turn to Gold's side");
    // A shot from due east is refused, its banner saying the way (either way is as short from there: right, by turnCue's tie rule).
    expect(await page.evaluate((s) => window.__game.fire(s), miss(EAST))).toBe(false);
    expect(await page.evaluate(() => document.querySelector('#banner')!.textContent)).toBe("Drag right ▸ to turn to Gold's side");
    // Gold fires from its own side; once the shot settles Blue is to fire and the camera has not moved.
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((s) => window.__game.fire(s), miss(WEST))).toBe(true);
    await page.waitForFunction(() => window.__game.duel!.turn === 1 && window.__game.ready, undefined, { timeout: 120_000, polling: 250 });
    const v1 = await page.evaluate(() => window.__game.view);
    expect(v1).toMatchObject({ yaw: v0.yaw, pitch: v0.pitch, distance: v0.distance, turning: false, cue: null });
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});
