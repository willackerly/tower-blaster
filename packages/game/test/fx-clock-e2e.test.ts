// The offscreen effect clock (KeystoneEnv.fxClock, ?fxclock=1): an offscreen page draws only for a capture, so
// by default its effects age only at captures, at most 0.1 s a capture, with every blast and flash stamped at
// the last capture's time. The Mac look review of PT2 (docs/render/damage-effects.md) saw what that does: sparks
// piled up over a settled tower, and no fireball. With the clock the effects run after each step on the
// simulation's clock, and on the wall clock while no step runs. Rapier, headless Chromium, L1 (candy).
//
// The A/B, the same grenade on the same tower: with the clock, a frame drawn as the blast goes off shows its
// fireball and flash lights, and nothing is left once the shot has settled; a shot that topples nothing throws
// a small fraction of the sparks. Without it, a frame drawn 2 s after the settle still shows the shot's sparks.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const par = L1.solutions!.par![0]! as Extract<Shot, { az: number }>;
const grenade = { ...par, ammo: 'w-grenade' } as Shot;
/** Well wide of the tower: it lands on the floor and topples nothing. */
const wide = { ...par, yaw: par.yaw + 900 } as Shot;
type Stats = { particles: number; hot: number; spawned: number; flashes: number; blasts: number; fuses: number };
const ZERO: Stats = { particles: 0, hot: 0, spawned: 0, flashes: 0, blasts: 0, fuses: 0 };

const settled = (page: Page, strokes: number) => page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), strokes, { timeout: 3 * MINUTES, polling: 100 });

/** Wait `ms` (the wall clock a player would watch the settled tower for), then one capture and its effects. */
async function afterWait(page: Page, ms: number): Promise<Stats> {
  await page.waitForTimeout(ms);
  await page.evaluate(() => window.__game.capture());
  return page.evaluate(() => window.__game.effects());
}

/**
 * Run the physics a display frame at a time, each drawn, until the grenade's blast goes off, then hold it there:
 * a SwiftShader frame is far slower than a step, so else the blast is over before a frame shows it.
 */
async function atBlast(page: Page): Promise<Stats> {
  const seen = await page.evaluate(async () => {
    const g = window.__game;
    while (!((g.counts.blastDrawn ?? 0) > 0) && g.phase === 'running') {
      g.hold = false;
      await new Promise((r) => requestAnimationFrame(r));
      g.hold = true;
      await g.capture();
    }
    return (g.counts.blastDrawn ?? 0) > 0;
  });
  expect(seen).toBe(true);
  await page.evaluate(() => window.__game.capture());
  const e = await page.evaluate(() => window.__game.effects());
  await page.evaluate(() => { window.__game.hold = false; });
  return e;
}

describe('offscreen effect clock', () => {
  it('a grenade shows its blast and flashes as it goes off and leaves nothing once settled; a miss throws few sparks', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&look=candy&offscreen=1&fxclock=1&keystone.rack=w-grenade,cannonball');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => window.__game.select('w-grenade'));
    expect(await page.evaluate((x) => window.__game.fire(x), grenade)).toBe(true);
    const blast = await atBlast(page);
    expect(blast.blasts).toBe(1);
    expect(blast.flashes).toBeGreaterThan(0);
    // Its fuse burnt out with it.
    expect(blast.fuses).toBe(0);
    await settled(page, 1);
    const shot = await page.evaluate(() => window.__game.effects());
    expect(shot.spawned).toBeGreaterThan(0);
    // 2 s after the settle every spark has died, every body cooled and every light gone out, as on screen.
    const after = await afterWait(page, 2000);
    expect({ ...after, spawned: 0 }).toEqual(ZERO);

    // The cannonball, wide: it topples nothing, and throws a few sparks at most (the effects follow the damage, PT2).
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.strokes === 0 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    await page.evaluate(() => window.__game.select('cannonball'));
    expect(await page.evaluate((x) => window.__game.fire(x), wide)).toBe(true);
    await settled(page, 1);
    const miss = await page.evaluate(() => window.__game.effects());
    console.log(`fx-clock: grenade spawned ${shot.spawned}, wide cannonball ${miss.spawned}`);
    expect(miss.blasts).toBe(0);
    expect(miss.spawned).toBeLessThan(shot.spawned / 10);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);

  it('without it, a frame drawn 2 s after the settle still shows the shot\'s sparks', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&look=candy&offscreen=1&keystone.rack=w-grenade');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    // Frames as the agent playtest draws them, a few a shot: one before, one once the blast has gone off (its
    // speed change since the last frame spawns the sparks), none until the settle. Not a frame every few ms:
    // each would see too small a speed change to spawn any, and age the sparks 0.1 s.
    await page.evaluate(() => window.__game.capture());
    expect(await page.evaluate((x) => window.__game.fire(x), grenade)).toBe(true);
    await page.waitForFunction(() => (window.__game.counts.blastDrawn ?? 0) > 0, undefined, { timeout: 2 * MINUTES, polling: 100 });
    await page.evaluate(() => window.__game.capture());
    expect((await page.evaluate(() => window.__game.effects())).spawned).toBeGreaterThan(0);
    await settled(page, 1);
    const after = await afterWait(page, 2000);
    expect(after.particles).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});
