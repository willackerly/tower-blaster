// The aim's clarity on the game page (PT14, docs/game/aim-clarity.md): before the player moves, a level with a
// pre-aimed opener shows that opener's flight and where it lands (on the structure), with no "Out of reach";
// aiming at the structure from the opening view marks the face the shot meets; keystone.impact=0 draws no marker.
// Headless Chromium, desktop and an upright phone.
import { devices } from 'playwright';
import { describe, expect, it } from 'vitest';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const PHONE = { ...devices['iPhone 13']!, viewport: { width: 390, height: 844 } };

describe('game page, the aim at shot 0', () => {
  for (const [shape, context] of [['desktop', undefined], ['phone', PHONE]] as const) {
    it(`${shape}: L1 opens on its opener's flight, landing on the structure, with no warning; aiming at the structure marks the face`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      const o = await game.open('/?level=L1&engine=rapier&offscreen=1&progress=off&door=0', 60_000, context);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page);
      // The opener's preview: drawn, landing on a structure body, and nothing aimed (the HUD shows no reach state).
      await page.waitForFunction(() => window.__game.view.impact, undefined, { timeout: 30_000, polling: 100 });
      const at0 = await page.evaluate(() => ({ impact: window.__game.impact, aimed: window.__game.input.aimed, hud: document.querySelector('.kg-hud')!.textContent }));
      expect(at0.impact).toMatchObject({ opener: true });
      expect(at0.impact!.body).toBeGreaterThanOrEqual(0);
      expect(at0.aimed).toBeNull();
      expect(at0.hud).not.toMatch(/Out of reach/);
      // Aiming at the middle of the view (on L1's tower): reachable, the marker on a body's face, no warning.
      const aimed = await page.evaluate(() => window.__game.aim(0, 0));
      expect(aimed?.reachable).toBe(true);
      const at1 = await page.evaluate(() => window.__game.impact);
      expect(at1).toMatchObject({ opener: false });
      expect(at1!.body).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(...at1!.normal)).toBeCloseTo(1, 6);
      await page.waitForFunction(() => window.__game.view.impact, undefined, { timeout: 30_000, polling: 100 });
      expect(await page.evaluate(() => document.querySelector('.kg-hud')!.textContent)).not.toMatch(/Out of reach/);
      expect(errors).toEqual([]);
      await page.close();
    }, 180_000);
  }

  it('keystone.impact=0: the flight shows, the marker does not', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&progress=off&door=0&keystone.impact=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.impact)).toBe(false);
    await page.waitForFunction(() => window.__game.impact !== null, undefined, { timeout: 30_000, polling: 100 });
    // A few frames on, still none drawn.
    const f0 = await page.evaluate(() => window.__game.frames);
    await page.waitForFunction((n) => window.__game.frames > n + 3, f0, { timeout: 30_000, polling: 100 });
    expect(await page.evaluate(() => window.__game.view.impact)).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);
});
