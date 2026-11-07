// Rube Lab's goal and ring on the game page (PT26, agent playtest round 2: "nothing says ring the bell"; a grey bell,
// a ring of a few sparks). RL2 in headless Chromium, Rapier, the real look's grain off so a frame is a frame:
//
//   - the build phase: the bell's own pixels (the ID pass of the same frame) read gold, not the ball's grey; the HUD
//     says what to do; the part the player places (the recorded build: a bumper, built through the same keys and
//     pointer rays a player's mouse gives) reads the builder's blue;
//   - the ring: the bell rings (Session.rung, crownDown), the page holds 10 steps on, and that frame shows the bell
//     moved from where it stood, carrying the ring's flash (BELL_FLASH, still gilt), with the ring waves out.
//
// The camera moves only on input, so the frame before Go and the frame of the ring share a view: the bell's pixel
// centroid moving is the bell moving.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, type LevelDef, RL2, RUBE_GO } from '@tb/keystone';
import { COAT_GILT, linearToOklab, srgbToLinear } from '@tb/render';
import { BELL_FLASH } from '../src/rube-view.ts';
import { isBuilt } from '../src/scene.ts';
import { rubeLine } from '../../playtest/src/agent/modes.ts';
import { gamePage } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const c = compileLevel(RL2);
const BELL = c.meta.crowns[0]!;
/** The PT26 verify's frame: this many steps after the ring. */
const RING_AFTER = 10;

interface Look { hue: number; chroma: number; L: number; px: number; cx: number; cy: number }

/** Mean OKLab of each group's pixels (hue in degrees, chroma, lightness), and their centroid on screen. */
async function looks(page: Page, groups: Record<string, readonly number[]>): Promise<Record<string, Look>> {
  const s = await page.evaluate(() => window.__game.capture(true));
  if (!s?.pixels || !s.ids) throw new Error('no capture');
  const out: Record<string, Look> = {};
  for (const [name, slots] of Object.entries(groups)) {
    const want = new Set(slots.map((k) => k + 1));
    let L = 0, a = 0, b = 0, n = 0, cx = 0, cy = 0;
    for (let i = 0; i < s.ids.length; i++) {
      if (!want.has(s.ids[i]!)) continue;
      const x = i % s.width, y = Math.floor(i / s.width), o = y * s.pixels.bytesPerRow + 4 * x;
      const lab = linearToOklab([0, 1, 2].map((k) => srgbToLinear(s.pixels!.data[o + k]! / 255)) as [number, number, number]);
      L += lab[0]; a += lab[1]; b += lab[2]; cx += x; cy += y; n++;
    }
    out[name] = n ? { hue: (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360, chroma: Math.hypot(a / n, b / n), L: L / n, px: n, cx: cx / n, cy: cy / n } : { hue: NaN, chroma: 0, L: 0, px: 0, cx: NaN, cy: NaN };
  }
  return out;
}

describe('Rube Lab on the game page (PT26)', () => {
  it('RL2: the bell gold and the built bumper blue in the build phase; on the ring the bell moved, lit, a wave out', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=RL2&engine=rapier&look=real&real.grain=0&offscreen=1&progress=off&door=0', 5 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });
    // The objective, said: the HUD's first row.
    expect(await page.locator('.kg-hud .row.obj').first().textContent()).toMatch(/ring the bell/i);

    // Build the recorded line (a fixed bumper at -45 degrees on the ball's line) as a player would.
    const line = rubeLine(RL2);
    expect(line).not.toBeNull();
    for (const a of line!.actions) {
      await page.evaluate((x) => { const e = window.__game.edit; if ('key' in x) e.key(x.key, x.shift); else e.ray(x.ray, x.at.origin, x.at.dir); }, a);
    }
    const built = compileLevel((await page.evaluate(() => window.__game.edit.def())) as LevelDef);
    const mine = Array.from({ length: built.meta.n }, (_, i) => i).filter((i) => isBuilt(built, i));
    expect(mine.length).toBe(1);
    expect(built.meta.crowns[0]).toBe(BELL);
    const build = await looks(page, { bell: [BELL], built: mine });
    console.log('RL2 build phase', JSON.stringify(build));
    expect(build.bell!.px).toBeGreaterThan(200);
    expect(build.bell!.hue).toBeGreaterThan(60);
    expect(build.bell!.hue).toBeLessThan(100);
    expect(build.bell!.chroma).toBeGreaterThan(0.06);
    expect(build.built!.px).toBeGreaterThan(100);
    expect(build.built!.hue).toBeGreaterThan(235);
    expect(build.built!.hue).toBeLessThan(290);
    expect(build.built!.chroma).toBeGreaterThan(0.05);

    // Play, then the frame before Go: the bell as it stands, still gold.
    // play(false): Run without its release (PT23 makes Play Rube Lab's one start verb), so the frame before Go is ours.
    await page.evaluate(() => window.__game.edit.play(false));
    await page.waitForFunction(() => !window.__game.edit.on && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const rest = await looks(page, { bell: [BELL] });
    expect(rest.bell!.hue).toBeGreaterThan(60);
    expect(rest.bell!.hue).toBeLessThan(100);

    // Go, and hold ten steps after the bell rings (the predicate runs in the page each frame, so the hold lands
    // within a frame's steps of that).
    expect(await page.evaluate((s) => window.__game.fire(s), RUBE_GO)).toBe(true);
    await page.waitForFunction((after) => {
      const g = window.__game, rang = g.counts.bellStep;
      if (rang === undefined || g.stepIndex < rang + after) return false;
      g.hold = true;
      return true;
    }, RING_AFTER, { timeout: 3 * MINUTES, polling: 'raf' });
    const at = await page.evaluate((b) => ({ step: window.__game.stepIndex, rang: window.__game.counts.bellStep!, rung: window.__game.counts.bellRung, fx: window.__game.fx(b)! }), BELL);
    const fx = await page.evaluate(() => window.__game.effects());
    const ring = await looks(page, { bell: [BELL] });
    console.log('RL2 ring', JSON.stringify({ rest: rest.bell, ring: ring.bell, at, fx }));
    expect(at.rung).toBe(1);
    expect(at.step - at.rang).toBeGreaterThanOrEqual(RING_AFTER);
    expect(at.step - at.rang).toBeLessThan(RING_AFTER + 20);
    // Lit: the bell carries the ring's flash (BELL_FLASH) over its gilt coat, and the ring waves are out. The glow
    // itself is drawn on renderer (wall) time, and a SwiftShader capture takes seconds, so the frame here comes after
    // the fade: what the flash draws is render-sphere-coats.test.ts's, at fixed times.
    expect(at.fx.coat).toBe(COAT_GILT);
    expect(at.fx.emissive).toBeCloseTo(BELL_FLASH.emissive, 2);
    expect(at.fx.flash).toBeCloseTo(BELL_FLASH.flash, 5);
    expect(fx.blasts).toBeGreaterThanOrEqual(1);
    // Moved: the bell's pixels stand off from where they stood before Go by an eighth of its drawn radius (the camera
    // has not moved, there was no input; two captures of a still scene give the same centroid to the last digit).
    const rPx = Math.sqrt(rest.bell!.px / Math.PI);
    expect(Math.hypot(ring.bell!.cx - rest.bell!.cx, ring.bell!.cy - rest.bell!.cy)).toBeGreaterThan(0.125 * rPx);
    // Still gold once the flash is over.
    expect(ring.bell!.hue).toBeGreaterThan(55);
    expect(ring.bell!.hue).toBeLessThan(105);
    // The HUD ticks the objective.
    expect(await page.locator('.kg-hud .row.obj').first().textContent()).toMatch(/✓/);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});
