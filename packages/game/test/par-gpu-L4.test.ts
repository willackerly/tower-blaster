import { expect } from 'vitest';
import { PRESETTLE_STEPS } from '@tb/keystone';
import { ready } from './page.ts';
import { parOnGpu } from './par-gpu.ts';

// L4 (38 bodies) also checks the GPU game itself: the arc preview follows the
// GPU's one substep, and a replay on the same device is bit-identical.
parOnGpu('L4', {
  async before(page) {
    await ready(page, 600_000);
    expect(await page.evaluate(() => window.__game.bodies)).toBe(38);
    await page.evaluate(() => window.__game.select('marble'));
    expect((await page.evaluate(() => window.__game.aim(0, 0)))?.reachable).toBe(true);
  },
  async after(page, shots) {
    const live = await page.evaluate(() => window.__game.state());
    expect(live.step).toBeGreaterThan(PRESETTLE_STEPS);
    expect(await page.evaluate((s) => window.__game.replay(s), shots)).toEqual(live);
  },
});
