// A duel's colours on the game page (look-colours.md §6, scene.ts duelTints/duelCoats, @tb/render COAT_PAINT):
// on D1 each side's blocks read in its ink and the wall between them neutral, in every look, by the OKLCh of
// their own pixels (the ID pass of the same frame). Before, the inks multiplied the look's colours: hazy's
// blue-grey plaster wall read as Blue's (hue 270 against Blue's 265) and candy turned Gold's ink green (124);
// keystone.coats=0 keeps that, and the hazy case is checked as the regression it was. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, D1, Duel, MATERIALS } from '@tb/keystone';
import { linearToOklab, srgbToLinear } from '@tb/render';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const c = compileLevel(D1.level);
const duel = new Duel(D1, c);
const GROUPS = {
  wall: [...Array(c.meta.n).keys()].filter((i) => MATERIALS[c.meta.material[i]!]!.name === 'plaster'),
  gold: [...duel.owned[0]],
  blue: [...duel.owned[1]],
};

type Hue = { hue: number; chroma: number; px: number };
/** Mean OKLab of each group's pixels, as hue (degrees) and chroma. */
async function hues(page: Page): Promise<Record<keyof typeof GROUPS, Hue>> {
  const s = await page.evaluate(() => window.__game.capture(true));
  if (!s?.pixels || !s.ids) throw new Error('no capture');
  const out = {} as Record<keyof typeof GROUPS, Hue>;
  for (const [name, slots] of Object.entries(GROUPS) as [keyof typeof GROUPS, number[]][]) {
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

async function measure(look: string, extra = ''): Promise<Record<keyof typeof GROUPS, Hue> | null> {
  const o = await game.open(`/?duel=D1&engine=rapier&look=${look}&offscreen=1&progress=off${extra}`, 5 * MINUTES);
  if (!o) return null;
  await ready(o.page, 5 * MINUTES);
  const h = await hues(o.page);
  expect(o.errors).toEqual([]);
  await o.page.close();
  return h;
}

describe('duel colours on the game page', () => {
  it('each side in its ink and the wall neutral, in every look; keystone.coats=0 keeps the old hazy wall', async (ctx) => {
    for (const look of ['candy', 'hazy', 'real']) {
      const h = await measure(look);
      if (!h) return ctx.skip();
      for (const g of Object.values(h)) expect(g.px, look).toBeGreaterThan(1000);
      // Measured (SwiftShader, 2026-11-07): Gold 88.7-91.5 deg, Blue 256.9-261.5 deg in all three looks.
      expect(hueGap(h.gold.hue, 90), look).toBeLessThan(10);
      expect(hueGap(h.blue.hue, 259), look).toBeLessThan(10);
      // The wall: grey (chroma 0.003 hazy, 0.009 real; 0.023-0.025 candy, whose blue night light tints every grey, 31%
      // of Gold's 0.074 in the first turn view and 34% in PT34's, which backs off to show your own keep), well under
      // either side's. (The hue check below tells the old wall, at Blue's hue, apart.)
      expect(h.wall.chroma, look).toBeLessThan(0.4 * Math.min(h.gold.chroma, h.blue.chroma));
    }
    const old = await measure('hazy', '&keystone.coats=0');
    if (!old) return ctx.skip();
    // Before: the wall at Blue's hue, with almost half its chroma.
    expect(hueGap(old.wall.hue, old.blue.hue)).toBeLessThan(15);
    expect(old.wall.chroma).toBeGreaterThan(0.3 * old.blue.chroma);
  }, 20 * MINUTES);
});
