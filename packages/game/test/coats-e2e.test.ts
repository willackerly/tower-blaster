// Coats on the game page (PT15, scene.ts structureCoats, @tb/render coats.ts): L3's crowns read gold and its
// heritage teal in every look, by the hue of their own pixels (the ID pass of the same frame), away from the
// aim beads' coral; with keystone.coats=0 candy multiplies its rainbow again (the playtest's salmon crowns).
// Rapier, headless Chromium; the real look's grain off so a frame is a frame.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, L3 } from '@tb/keystone';
import { COAT_GILT, COAT_GLAZE, linearToOklab, srgbToLinear } from '@tb/render';
import { structureCoats } from '../src/scene.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const c = compileLevel(L3);

/** Mean OKLab of the pixels of the given slots, as hue (degrees) and chroma. */
async function roleHues(page: Page, groups: Record<string, readonly number[]>): Promise<Record<string, { hue: number; chroma: number; px: number }>> {
  const s = await page.evaluate(() => window.__game.capture(true));
  if (!s?.pixels || !s.ids) throw new Error('no capture');
  const out: Record<string, { hue: number; chroma: number; px: number }> = {};
  for (const [name, slots] of Object.entries(groups)) {
    const want = new Set(slots.map((k) => k + 1));
    let a = 0, b = 0, n = 0;
    for (let i = 0; i < s.ids.length; i++) {
      if (!want.has(s.ids[i]!)) continue;
      const o = Math.floor(i / s.width) * s.pixels.bytesPerRow + 4 * (i % s.width);
      const lab = linearToOklab([0, 1, 2].map((k) => srgbToLinear(s.pixels!.data[o + k]! / 255)) as [number, number, number]);
      a += lab[1]; b += lab[2]; n++;
    }
    a /= n; b /= n;
    out[name] = { hue: (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360, chroma: Math.hypot(a, b), px: n };
  }
  return out;
}

const hueGap = (x: number, y: number) => Math.abs((((x - y) % 360) + 540) % 360 - 180);
/** The aim beads' coral (scene.ts BEAD_COLOUR, sRGB 255 122 90): OKLCh hue 35. */
const BEAD_HUE = 35;

describe('coats on the game page', () => {
  it('L3: crowns gilt and heritage glaze as loaded; crowns gold and heritage teal in candy, hazy and real', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const coats = Array.from(structureCoats(c));
    expect(c.meta.crowns.length).toBe(2);
    expect(Array.from(c.meta.crowns, (i) => coats[i])).toEqual([COAT_GILT, COAT_GILT]);
    expect(Array.from(c.meta.heritage, (i) => coats[i])).toEqual(Array.from(c.meta.heritage, () => COAT_GLAZE));
    const groups = { crown: Array.from(c.meta.crowns), heritage: Array.from(c.meta.heritage) };
    const got: Record<string, Awaited<ReturnType<typeof roleHues>>> = {};
    for (const look of ['candy', 'hazy', 'real', 'candy-off']) {
      const off = look.endsWith('-off');
      const o = await game.open(`/?level=L3&engine=rapier&look=${look.replace('-off', '')}&real.grain=0&offscreen=1&progress=off&door=0${off ? '&keystone.coats=0' : ''}`, 5 * MINUTES);
      if (!o) return ctx.skip();
      await ready(o.page, 5 * MINUTES);
      expect(await o.page.evaluate(() => window.__game.feel.coats)).toBe(!off);
      got[look] = await roleHues(o.page, groups);
      expect(o.errors).toEqual([]);
      await o.page.close();
    }
    console.log('L3 role hues', JSON.stringify(got));
    const crowns = ['candy', 'hazy', 'real'].map((l) => got[l]!.crown!), heritage = ['candy', 'hazy', 'real'].map((l) => got[l]!.heritage!);
    for (const h of crowns) {
      expect(h.px).toBeGreaterThan(500);
      expect(h.hue).toBeGreaterThan(60);
      expect(h.hue).toBeLessThan(100);
      expect(h.chroma).toBeGreaterThan(0.06);
      expect(hueGap(h.hue, BEAD_HUE)).toBeGreaterThan(25);
    }
    for (const h of heritage) {
      expect(h.hue).toBeGreaterThan(150);
      expect(h.hue).toBeLessThan(200);
      expect(h.chroma).toBeGreaterThan(0.04);
    }
    // One colour language: each role's hue within 20 degrees across the looks.
    for (const g of [crowns, heritage]) for (const x of g) for (const y of g) expect(hueGap(x.hue, y.hue)).toBeLessThan(20);
    // Without coats, candy's top course turns the crowns' gold toward the beads' coral (the playtest's salmon).
    expect(hueGap(got['candy-off']!.crown!.hue, BEAD_HUE)).toBeLessThan(hueGap(got.candy!.crown!.hue, BEAD_HUE) - 15);
    // ... and its heritage away from teal (the playtest's violet).
    expect(hueGap(got['candy-off']!.heritage!.hue, got.candy!.heritage!.hue)).toBeGreaterThan(45);
  }, 15 * MINUTES);
});
