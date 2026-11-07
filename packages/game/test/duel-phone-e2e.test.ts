// The Siege Table on a docked phone (PT30, agent playtest 2: the portrait turn view put both keeps in the bottom
// fifth and your own under the tray). On the game page at 390 x 844 and 844 x 390 (touch): the duel measures its
// HUD's band at load as single-player levels do (play.ts dockedHud; docs/game/phone-hud.md), and each turn's view,
// Gold's at the start and Blue's after the swing, keeps both kings inside the screen less that band
// (duel-view.ts bandView). Headless Chromium, Rapier.
import { describe, expect, it } from 'vitest';
import { compileLevel, D1, Duel, duelLevel, type Shot } from '@tb/keystone';
import type { Page } from 'playwright';
import { DEFAULT_FRAMING, type Orbit, viewProj } from '@tb/render/camera';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const PHONES = [
  ['upright', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }],
  ['sideways', { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }],
] as const;
/** A cannonball turned 90 degrees off the lot centre at low power from azimuth az: it lands beside the launcher (duel-e2e.test.ts). */
const miss = (az: number): Shot => ({ ammo: 'cannonball', az, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot);
type Band = { top: number; bottom: number; left: number; right: number };

/** The corners of bodies `idx` (home boxes) that project outside the screen less `band`, or behind the eye. */
function outside(o: Orbit, aspect: number, c: ReturnType<typeof compileLevel>, idx: ArrayLike<number>, band: Band): number {
  const m = viewProj(o, aspect);
  let n = 0;
  for (let j = 0; j < idx.length; j++) for (let s = 0; s < 8; s++) {
    const i = idx[j]!, p = [0, 1, 2].map((k) => c.meta.home[3 * i + k]! + ((s >> k) & 1 ? 1 : -1) * c.meta.half[3 * i + k]!);
    const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
    const x = (m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!) / w, y = (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!) / w;
    if (!(w > 0) || x < -1 + 2 * band.left || x > 1 - 2 * band.right || y > 1 - 2 * band.top || y < -1 + 2 * band.bottom) n++;
  }
  return n;
}

const viewAtRest = async (page: Page) => {
  await page.waitForFunction(() => !window.__game.view.turning && window.__game.view.arcBeads > 0, undefined, { timeout: MINUTES, polling: 100 });
  const v = await page.evaluate(() => window.__game.view);
  return { target: v.target, yaw: v.yaw, pitch: v.pitch, distance: v.distance, fovY: (DEFAULT_FRAMING.fov * Math.PI) / 180 } as Orbit;
};

describe('PT30: the Siege Table on a docked phone', () => {
  it("D1: each turn's view keeps both kings inside the HUD's measured band, upright and sideways", async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const c = compileLevel(duelLevel(D1)), kings = new Duel(D1, c).kings;
    for (const [name, phone] of PHONES) {
      const { width: W, height: H } = phone.viewport;
      const o = await game.open(`/?duel=D1&engine=rapier&offscreen=${W}x${H}&progress=off`, 2 * MINUTES, phone);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page, 2 * MINUTES);
      // Docked, and the duel measured its band (it framed under the 40% guess before).
      expect(await page.evaluate(() => document.querySelector('.kg-hud')!.classList.contains('kg-dock')), name).toBe(true);
      const band = await page.evaluate(() => window.__game.openingHud);
      expect(band, `${name}: the duel's measured band`).not.toBeNull();
      if (name === 'upright') expect(band!.top + band!.bottom).toBeLessThan(0.5);
      else expect(band!.left).toBeLessThan(0.35);
      // Gold's turn, then Blue's after a miss and the swing.
      for (const turn of [0, 1] as const) {
        if (turn) {
          await page.evaluate(() => { window.__game.fast = true; });
          expect(await page.evaluate((s) => window.__game.fire(s), miss(360))).toBe(true);
          await page.waitForFunction(() => window.__game.duel!.turn === 1 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
        }
        const v = await viewAtRest(page);
        for (const k of [0, 1] as const) expect(outside(v, W / H, c, kings[k]!, band!), `${name}, ${turn ? 'Blue' : 'Gold'}'s turn: ${D1.sides[k].name}'s king's corners outside the band`).toBe(0);
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 6 * MINUTES);
});
