// The camera on the game page. By default it moves only when the player moves
// it (playtest feedback, 2026-11-02): no follow, no shake, no field-of-view
// punch. Asked for, the follow camera (G4.3, follow.ts, ?keystone.follow=1)
// follows the moving structure during a shot, after the settle eases back and
// lands exactly where the player fired from, and lets go on any camera input by
// the player; the shake (juice.ts, ?keystone.shake=1) jolts the drawn view and
// never the orbit. Rapier, so it is quick on a CPU; the camera is render-only,
// so the engine does not matter to it.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { L1, type Shot } from '@tb/keystone';
import { PUNCH_MAX, SHAKE_YAW } from '../src/juice.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const shot = L1.solutions!.par![0] as Shot;
const BASE = '/?level=L1&offscreen=1&engine=rapier';
type View = { target: [number, number, number]; distance: number; following: boolean; jolt: number };
/** The view less what it marks in the scene (the impact marker, the x-ray, the preview's dots), which change with the aim, not the camera. */
const camera = <V extends object>(v: V): Omit<V, 'impact' | 'xray' | 'dots'> => { const { impact: _i, xray: _x, dots: _d, ...rest } = v as V & { impact?: unknown; xray?: unknown; dots?: unknown }; return rest as Omit<V, 'impact' | 'xray' | 'dots'>; };

/** Fire the par shot and sample the view every frame until the shot is over (L1's par shot clears the level) and the follow let go. */
async function fireAndWatch(page: Page): Promise<View[]> {
  expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
  return page.evaluate(() => new Promise<View[]>((resolve) => {
    const out: View[] = [];
    const t0 = performance.now();
    const look = () => {
      const g = window.__game;
      out.push({ ...g.view, target: [...g.view.target] as View['target'] });
      if ((g.phase !== 'running' && !g.view.following) || performance.now() - t0 > 120_000) resolve(out);
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }));
}

describe('camera on the page', () => {
  it('by default never moves on its own: no follow, no shake, no punch through a whole shot', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: false, shake: false });
    const home = await page.evaluate(() => window.__game.view);
    const views = await fireAndWatch(page);
    console.log(`L1 default camera: ${views.length} frames`);
    expect(views.length).toBeGreaterThan(10);
    expect(await page.evaluate(() => window.__game.phase)).toBe('cleared');
    for (const v of views) expect(camera(v)).toEqual(camera(home));
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('with keystone.follow=1 follows the collapse, then lands back exactly on the view the shot was fired from', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.follow=1`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const home = await page.evaluate(() => window.__game.view);
    expect(home.following).toBe(false);
    const views = await fireAndWatch(page);
    const off = (v: View) => Math.hypot(v.target[0] - home.target[0], v.target[1] - home.target[1], v.target[2] - home.target[2], v.distance - home.distance);
    const peak = Math.max(...views.map(off));
    console.log(`L1 follow: ${views.length} frames, peak offset ${peak.toFixed(2)} m (home distance ${home.distance.toFixed(1)} m)`);
    expect(views.some((v) => v.following)).toBe(true);
    expect(peak).toBeGreaterThan(0.02 * home.distance); // it did move
    // Never a jump: the spring moves the camera a little per frame.
    for (let i = 1; i < views.length; i++) {
      const a = views[i - 1]!, b = views[i]!;
      expect(Math.hypot(b.target[0] - a.target[0], b.target[1] - a.target[1], b.target[2] - a.target[2], b.distance - a.distance)).toBeLessThan(0.1 * home.distance);
    }
    expect(views.every((v) => v.jolt === 0)).toBe(true); // follow alone does not shake
    const end = views.at(-1)!;
    expect(await page.evaluate(() => window.__game.phase)).toBe('cleared');
    expect(end.following).toBe(false);
    expect(end.target).toEqual(home.target);
    expect(end.distance).toBe(home.distance);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('with keystone.follow=1 lets go when the player zooms, and leaves the camera where they put it', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.follow=1`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const home = await page.evaluate(() => window.__game.view);
    expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    await page.waitForFunction(() => window.__game.view.following, undefined, { timeout: 60_000, polling: 'raf' });
    // A wheel turn on the canvas: zoom in (offscreen pages draw nothing, so the event is dispatched, not moused).
    await page.evaluate(() => document.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, cancelable: true })));
    await page.waitForFunction(() => !window.__game.view.following, undefined, { timeout: 10_000, polling: 'raf' });
    const after = await page.evaluate(() => window.__game.view);
    let moved = false;
    while (await page.evaluate(() => window.__game.phase === 'running')) {
      const v = await page.evaluate(() => window.__game.view);
      moved ||= v.following || v.distance !== after.distance || v.target.some((x, k) => x !== after.target[k]);
      await page.waitForTimeout(100);
    }
    expect(moved).toBe(false); // the camera stayed where the player left it
    expect((await page.evaluate(() => window.__game.view)).distance).toBeLessThan(home.distance); // still zoomed in: no ease back
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('with keystone.shake=1 jolts the drawn view on the shot (the fire punch at least), within the juice limits, and never the orbit', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.shake=1`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const home = await page.evaluate(() => window.__game.view);
    const views = await fireAndWatch(page);
    const peak = Math.max(...views.map((v) => v.jolt));
    console.log(`L1 shake: ${views.length} frames, peak jolt ${peak.toFixed(4)}`);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(Math.max(PUNCH_MAX, SHAKE_YAW));
    for (const v of views) expect(camera({ ...v, jolt: 0 })).toEqual(camera({ ...home, jolt: 0 })); // the orbit itself stays put
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});
