// Effects that follow the damage and clear on reset (PT2), and fired bodies' looks (PT19), on the game page.
// The renderer's transient effects (handle.effects: live particles, hot bodies, lit flashes, blasts, lit
// fuses, particles spawned since the last reset) are all 0 after Retry, Undo and a level load, having
// been live during the shot before. A fired ram is drawn as a ram, not a bomb, and every painted ball and
// ram is spent (faded) once its shot settles; keystone.spent=0 keeps them live. Rapier, headless Chromium;
// offscreen pages draw only for a capture, so the test captures frames while a shot runs.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const par = L1.solutions!.par![0]! as Extract<Shot, { az: number }>;
const ZERO = { particles: 0, hot: 0, spawned: 0, flashes: 0, blasts: 0, fuses: 0 };
const settled = (page: Page, strokes: number) => page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), strokes, { timeout: 3 * MINUTES, polling: 100 });

/** Fire `shot` and capture frames while it runs: the most of each effect count seen, then wait for its settle. */
async function fireWatching(page: Page, shot: Shot, strokes: number) {
  expect(await page.evaluate((x) => window.__game.fire(x), shot)).toBe(true);
  const most = { ...ZERO };
  for (let k = 0; k < 40 && (await page.evaluate(() => window.__game.phase)) === 'running'; k++) {
    await page.evaluate(() => window.__game.capture());
    const e = await page.evaluate(() => window.__game.effects());
    for (const key of Object.keys(most) as (keyof typeof ZERO)[]) most[key] = Math.max(most[key], e[key]);
  }
  await settled(page, strokes);
  return most;
}

/** One frame drawn, then the effects as it left them. */
async function effectsNow(page: Page) {
  await page.evaluate(() => window.__game.capture());
  return page.evaluate(() => window.__game.effects());
}

describe('effects clear on reset (PT2)', () => {
  it('Retry, Undo and a level load leave no particle, heat, flash, blast or fuse', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&look=candy&offscreen=1&keystone.rack=cannonball,w-grenade,cannonball');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.fx)).toBe('damage');
    expect(await effectsNow(page)).toEqual(ZERO);

    // The par cannonball topples the tower: sparks live during it.
    const hit = await fireWatching(page, par, 1);
    expect(hit.spawned).toBeGreaterThan(0);
    expect(hit.particles).toBeGreaterThan(0);
    // Retry (R): nothing of it carries over.
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.strokes === 0 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await effectsNow(page)).toEqual(ZERO);

    // A grenade on the tower: a blast and a lit fuse besides the sparks. Undo (U): nothing carries over.
    await page.evaluate(() => window.__game.select('w-grenade'));
    const blast = await fireWatching(page, { ...par, ammo: 'w-grenade' }, 1);
    expect(blast.spawned).toBeGreaterThan(0);
    expect(blast.blasts + blast.fuses).toBeGreaterThan(0);
    await page.keyboard.press('u');
    await page.waitForFunction(() => window.__game.strokes === 0 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await effectsNow(page)).toEqual(ZERO);

    // Another shot, then a level load: a fresh start there too.
    const again = await fireWatching(page, par, 1);
    expect(again.spawned).toBeGreaterThan(0);
    await page.evaluate(() => window.__game.load('L2'));
    await ready(page);
    expect(await page.evaluate(() => window.__game.level)).toBe('L2');
    expect(await effectsNow(page)).toEqual(ZERO);
    expect(errors).toEqual([]);
    await page.close();
  }, 15 * MINUTES);
});

describe("fired bodies' looks (PT19)", () => {
  /** A shot well wide of the arch: it changes nothing but the step count and the rack. */
  const wide = (ammo: Shot['ammo']): Shot => ({ ammo, az: 0, y: 40, yaw: 900, pitch: 0, power: 30 } as Shot);

  it.for([['spent', ''], ['kept live', '&keystone.spent=0']] as const)('a ram is drawn as a ram, not a bomb; balls and rams are %s once their shot settles', { timeout: 10 * MINUTES }, async ([, extra], ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=T-X4&engine=rapier&look=candy&offscreen=1&keystone.rack=w-ram,w-bomb${extra}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const spent = extra === '';
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((x) => window.__game.fire(x), wide('w-ram'))).toBe(true);
    // While it flies: a ram, live.
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['ram']);
    expect(await page.evaluate(() => window.__game.spentLooks())).toEqual([false]);
    await settled(page, 1);
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['ram']);
    expect(await page.evaluate(() => window.__game.spentLooks())).toEqual([spent]);
    // A bomb after it: a bomb, never spent (a live one still goes off); the ram stays as it was.
    await ready(page);
    expect(await page.evaluate((x) => window.__game.fire(x), wide('w-bomb'))).toBe(true);
    await settled(page, 2);
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['ram', 'bomb']);
    expect(await page.evaluate(() => window.__game.spentLooks())).toEqual([spent, false]);
    // An undo draws the kept ram as it was when the bomb went in: spent (or live).
    await page.keyboard.press('u');
    await page.waitForFunction(() => window.__game.strokes === 1 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual(['ram']);
    expect(await page.evaluate(() => window.__game.spentLooks())).toEqual([spent]);
    // A restart clears them.
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.strokes === 0 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.firedLooks())).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });
});
