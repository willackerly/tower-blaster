// The Siege Table on the game page (?duel=D1, docs/game/siege-table.md): the turn controller refuses a
// shot from the wrong side or out of turn, passes the turn at each settle, runs the duel's level to a
// result card, and Rematch starts the other side first. Eight sideways misses on Rapier: nothing is hit,
// so both keeps stand alike and the duel is a draw. Headless Chromium.
import { describe, expect, it } from 'vitest';
import { D1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();

/** A shot from azimuth az turned 90 degrees off the lot centre at low power: it lands beside the launcher, clear of both keeps. */
const miss = (az: number, ammo: Shot['ammo'] = 'cannonball'): Shot => ({ ammo, az, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot);
const WEST = 360, EAST = 0;

describe('game page, Siege Table', () => {
  it('takes turns by side, refuses the wrong side, ends in a draw on eight misses, and Rematch starts Blue', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?duel=D1&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => [window.__game.level, window.__game.duel?.turn, window.__game.duel?.first])).toEqual(['D1', 0, 0]);
    expect(await page.evaluate(() => document.querySelector('.kg-hud')!.textContent)).toMatch(/Gold to fire, from the west/);
    // Gold may not fire from Blue's side, nor a marble it does not have.
    expect(await page.evaluate((s) => window.__game.fire(s), miss(EAST))).toBe(false);
    expect(await page.evaluate((s) => window.__game.fire(s), { ...miss(WEST), ammo: 'marble' } as Shot)).toBe(false);
    await page.evaluate(() => { window.__game.fast = true; });
    const order: number[] = [];
    for (let k = 0; k < 8; k++) {
      await ready(page, 120_000);
      const turn = await page.evaluate(() => window.__game.duel!.turn);
      order.push(turn);
      const ammo = k >= 6 ? 'w-grenade' : 'cannonball';
      expect(await page.evaluate((s) => window.__game.fire(s), miss(turn === 0 ? WEST : EAST, ammo))).toBe(true);
    }
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 250 });
    expect(order).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
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
    expect(errors).toEqual([]);
    await page.close();
  }, 400_000);
});
