// Ice pale at any depth in the real look (PT15, agent playtest 1: "the lower ice rows go near-black"). The
// lower courses of T-I1 refract the floor just behind the column, and that floor lay in the column's own
// shadow: ice cast an opaque shadow. Ice now casts a screen-door shadow that lets 0.7 of the sun through
// (render ice.ts IceParams.shadow, cull.ts SEG.boxIceShadow). Measured with the look's own sun
// (keystone.sun=look), which puts that shadow behind the column, as an orbiting player would see it.
// OKLab lightness of each course's own pixels (the ID pass of the same frame). Rapier, headless Chromium, grain off.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, TRIAL_LEVELS } from '@tb/keystone';
import { linearToOklab, srgbToLinear } from '@tb/render';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const c = compileLevel(TRIAL_LEVELS.find((d) => d.id === 'T-I1')!);

/** Mean OKLab lightness of the ice pixels of each course (by height, from the bottom), crowns left out. */
async function courseLightness(page: Page): Promise<number[]> {
  const s = await page.evaluate(() => window.__game.capture(true));
  if (!s?.pixels || !s.ids) throw new Error('no capture');
  const crown = new Set(c.meta.crowns);
  const ys = [...new Set(c.scene.bodies.slice(0, c.meta.n).map((b) => Math.round(b.pos[1] * 1000)))].sort((a, b) => a - b);
  const course = (slot: number) => ys.indexOf(Math.round(c.scene.bodies[slot]!.pos[1] * 1000));
  const sum: number[] = [], n: number[] = [];
  for (let i = 0; i < s.ids.length; i++) {
    const id = s.ids[i]!;
    if (!id || id > c.meta.n || crown.has(id - 1)) continue;
    const k = course(id - 1), o = Math.floor(i / s.width) * s.pixels.bytesPerRow + 4 * (i % s.width);
    const L = linearToOklab([0, 1, 2].map((j) => srgbToLinear(s.pixels!.data[o + j]! / 255)) as [number, number, number])[0];
    sum[k] = (sum[k] ?? 0) + L; n[k] = (n[k] ?? 0) + 1;
  }
  return sum.map((x, k) => x / n[k]!);
}

describe('ice pale at any depth (real look)', () => {
  it('T-I1, the shadow behind the column: the lowest four courses as light as the four above them; an opaque ice shadow (ice.shadow=0) darkens them', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const got: Record<string, number[]> = {};
    for (const shadow of ['0.7', '0', '1']) {
      const o = await game.open(`/?level=T-I1&look=real&real.grain=0&engine=rapier&offscreen=1&progress=off&door=0&keystone.sun=look${shadow === '0.7' ? '' : `&ice.shadow=${shadow}`}`, 5 * MINUTES);
      if (!o) return ctx.skip();
      await ready(o.page, 5 * MINUTES);
      got[shadow] = await courseLightness(o.page);
      expect(o.errors).toEqual([]);
      await o.page.close();
    }
    console.log('T-I1 course lightness', JSON.stringify(got));
    const low = (L: number[]) => (L[0]! + L[1]! + L[2]! + L[3]!) / 4, mid = (L: number[]) => (L[4]! + L[5]! + L[6]! + L[7]!) / 4;
    const now = got['0.7']!, before = got['0']!, none = got['1']!;
    expect(now.length).toBeGreaterThanOrEqual(9);
    // T-I1 is a 3 x 3 tower since PT38 (it was a 2 x 2 column): light crosses three blocks, not two, so every
    // course sits about 0.05 lower (docs/render/ice.md). Still no course near black.
    for (let k = 0; k < 8; k++) expect(now[k], `course ${k}`).toBeGreaterThan(0.45);
    // The opaque shadow darkens the low courses against ice casting no shadow at all (the ceiling); on the
    // 3 x 3 tower it darkens every course alike, so the measure is against the ceiling, not the mid courses.
    // The screen door closes at least 70% of the gap and keeps them within 7% of the mid courses.
    expect(low(before)).toBeLessThan(0.85 * low(none));
    expect(low(now)).toBeGreaterThan(0.93 * mid(now));
    expect(low(now) - low(before)).toBeGreaterThan(0.7 * (low(none) - low(before)));
  }, 15 * MINUTES);
});
