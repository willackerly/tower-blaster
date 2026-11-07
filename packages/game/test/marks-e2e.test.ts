// Stone marks on the game page (Will's 2026-11-06 ask: engravings that make
// clear which stones to save and which to hit): every load carves the
// structure as scene.ts structureMarks says, a retry and an undo keep the
// carving, keystone.marks=0 loads plain stones, and a hold level's crown
// carries the keep crown. Rapier, headless Chromium; what a mark draws is
// @tb/render's render-marks test.
import { describe, expect, it } from 'vitest';
import { compileLevel, L3, type Shot, U3 } from '@tb/keystone';
import { MARK_HIT, MARK_KEEP, MARK_SAVE } from '@tb/render';
import { structureMarks } from '../src/scene.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
/** A shot well wide of the wall: it changes nothing but the step count and the rack. */
const wide: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot;
const marks = (page: import('playwright').Page) => page.evaluate(() => window.__game.marks());

describe('stone marks on the game page', () => {
  it('L3: crosshairs on the crowns, shields on the heritage, as loaded, after a shot, a retry and an undo', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L3&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const want = Array.from(structureMarks(compileLevel(L3)));
    expect(want.filter((m) => m === MARK_HIT).length).toBe(2);
    expect(want.filter((m) => m === MARK_SAVE).length).toBe(3);
    expect(await marks(page)).toEqual(want);
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((s) => window.__game.fire(s), wide)).toBe(true);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 1, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await marks(page)).toEqual(want);
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    await ready(page);
    expect(await marks(page)).toEqual(want);
    await page.evaluate(() => window.__game.retry());
    await ready(page);
    expect(await marks(page)).toEqual(want);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('keystone.marks=0: plain stones; U3 (hold the crown up): the crown carries the keep crown', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const off = await game.open('/?level=L3&engine=rapier&look=candy&offscreen=1&progress=off&keystone.marks=0');
    if (!off) return ctx.skip();
    await ready(off.page);
    expect(await off.page.evaluate(() => window.__game.feel.marks)).toBe(false);
    expect((await marks(off.page)).some((m) => m !== 0)).toBe(false);
    expect(off.errors).toEqual([]);
    await off.page.close();
    const o = await game.open('/?level=U3&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    await ready(o.page);
    const c = compileLevel(U3), got = await marks(o.page);
    expect(Array.from(c.meta.crowns, (i) => got[i])).toEqual(Array.from(c.meta.crowns, () => MARK_KEEP));
    expect(got.filter((m) => m === MARK_HIT)).toEqual([]);
    expect(o.errors).toEqual([]);
    await o.page.close();
  }, 5 * MINUTES);
});
