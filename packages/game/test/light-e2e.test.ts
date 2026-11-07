// The real look's sun turned with the level's opening view (light.ts, PT15): B2 opens with the eye at
// azimuth 144, where the look's own sun stands 4 degrees off straight behind the eye and every tower's
// shadow falls behind it; turned, the shadows fall on the floor in front of the towers. L3 opens with the
// eye at azimuth 0 and draws exactly as before. Rapier, headless Chromium; grain off (it reseeds every
// frame) so two captures can be compared pixel for pixel.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;

interface Shot { width: number; height: number; data: number[]; ids: number[]; stride: number }

async function shot(page: Page): Promise<Shot> {
  const s = await page.evaluate(() => window.__game.capture(true));
  if (!s?.pixels || !s.ids) throw new Error('no capture');
  return { width: s.width, height: s.height, data: s.pixels.data, ids: s.ids, stride: s.pixels.bytesPerRow };
}

/**
 * The share of the floor in front of the structure that is in shadow: floor pixels (no body) below the
 * median row of the structure's pixels, and among them those darker than 0.6 of their median luma.
 */
function floorShadow(s: Shot): { floor: number; shadow: number } {
  const rows: number[] = [];
  for (let i = 0; i < s.ids.length; i++) if (s.ids[i]) rows.push(Math.floor(i / s.width));
  rows.sort((a, b) => a - b);
  const from = rows[rows.length >> 1]!;
  const luma: number[] = [];
  for (let y = from; y < s.height; y++) for (let x = 0; x < s.width; x++) {
    if (s.ids[y * s.width + x]) continue;
    const o = y * s.stride + 4 * x;
    luma.push(0.2126 * s.data[o]! + 0.7152 * s.data[o + 1]! + 0.0722 * s.data[o + 2]!);
  }
  const med = [...luma].sort((a, b) => a - b)[luma.length >> 1]!;
  return { floor: luma.length, shadow: luma.filter((l) => l < 0.6 * med).length / luma.length };
}

describe('the real look\'s sun from the opening view', () => {
  it('B2: turned, the towers\' shadows fall on the floor in front of them; the look\'s own sun hides them behind', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const got: Record<string, ReturnType<typeof floorShadow>> = {};
    for (const sun of ['view', 'look']) {
      const o = await game.open(`/?level=B2&look=real&real.grain=0&engine=rapier&offscreen=1&progress=off&door=0&keystone.sun=${sun}`, 5 * MINUTES);
      if (!o) return ctx.skip();
      await ready(o.page, 5 * MINUTES);
      expect(await o.page.evaluate(() => window.__game.feel.sun)).toBe(sun);
      got[sun] = floorShadow(await shot(o.page));
      expect(o.errors).toEqual([]);
      await o.page.close();
    }
    console.log('B2 floor in shadow', JSON.stringify(got));
    expect(got.view!.floor).toBeGreaterThan(10_000);
    expect(got.view!.shadow).toBeGreaterThan(0.1);
    expect(got.look!.shadow).toBeLessThan(0.02);
  }, 10 * MINUTES);

  it('L3 (the eye at azimuth 0): the same frame either way', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const frames: Shot[] = [];
    for (const sun of ['view', 'look']) {
      const o = await game.open(`/?level=L3&look=real&real.grain=0&engine=rapier&offscreen=1&progress=off&door=0&keystone.sun=${sun}`, 5 * MINUTES);
      if (!o) return ctx.skip();
      await ready(o.page, 5 * MINUTES);
      frames.push(await shot(o.page));
      expect(o.errors).toEqual([]);
      await o.page.close();
    }
    expect(frames[0]!.data.length).toBe(frames[1]!.data.length);
    expect(frames[0]!.data.every((v, i) => v === frames[1]!.data[i])).toBe(true);
  }, 10 * MINUTES);
});
