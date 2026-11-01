// The follow camera on the game page (G4.3, follow.ts): during a shot the
// orbit's target and distance follow the moving structure, after the settle
// they ease back and land exactly where the player fired from; any camera
// input by the player during the shot leaves the camera to them; and with
// ?keystone.follow=0 the camera never moves on its own. Rapier, so it is quick
// on a CPU; the camera is render-only, so the engine does not matter to it.
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const shot = L1.solutions!.par![0] as Shot;
type View = { target: [number, number, number]; distance: number; following: boolean };

describe('follow camera on the page', () => {
  it('follows the collapse, then lands back exactly on the view the shot was fired from', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const home = await page.evaluate(() => window.__game.view);
    expect(home.following).toBe(false);
    expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    // Sample the view each frame until the shot has settled and the camera let go.
    const views = await page.evaluate(() => new Promise<View[]>((resolve) => {
      const out: View[] = [];
      const t0 = performance.now();
      const look = () => {
        const g = window.__game;
        out.push({ ...g.view, target: [...g.view.target] as View['target'] });
        // L1's par shot clears the level: the shot is over once the phase leaves running (cleared, not aiming).
        if ((g.phase !== 'running' && !g.view.following) || performance.now() - t0 > 120_000) resolve(out);
        else requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    }));
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
    const end = views.at(-1)!;
    expect(await page.evaluate(() => window.__game.phase)).toBe('cleared');
    expect(end.following).toBe(false);
    expect(end.target).toEqual(home.target);
    expect(end.distance).toBe(home.distance);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('lets go when the player zooms, and never moves with keystone.follow=0', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const [search, grab] of [['/?level=L1&offscreen=1&engine=rapier&keystone.follow=0', false], ['/?level=L1&offscreen=1&engine=rapier', true]] as const) {
      const o = await game.open(search);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page);
      const home = await page.evaluate(() => window.__game.view);
      expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
      if (grab) {
        await page.waitForFunction(() => window.__game.view.following, undefined, { timeout: 60_000, polling: 'raf' });
        // A wheel turn on the canvas: zoom in (offscreen pages draw nothing, so the event is dispatched, not moused).
        await page.evaluate(() => document.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, cancelable: true })));
        await page.waitForFunction(() => !window.__game.view.following, undefined, { timeout: 10_000, polling: 'raf' });
      }
      const after = await page.evaluate(() => window.__game.view);
      let moved = false;
      while (await page.evaluate(() => window.__game.phase === 'running')) {
        const v = await page.evaluate(() => window.__game.view);
        moved ||= v.following || v.distance !== after.distance || v.target.some((x, k) => x !== after.target[k]);
        await page.waitForTimeout(100);
      }
      expect(moved, search).toBe(false); // the camera stayed where the player (or nobody) left it
      const end = await page.evaluate(() => window.__game.view);
      if (grab) expect(end.distance).toBeLessThan(home.distance); // still zoomed in: no ease back
      else expect(end).toEqual(home);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 300_000);
});
