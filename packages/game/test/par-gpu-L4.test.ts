import { expect } from 'vitest';
import { PRESETTLE_STEPS } from '@tb/keystone';
import { ready } from './page.ts';
import { parOnGpu } from './par-gpu.ts';

// L4 (38 bodies) also checks the GPU game itself: the arc preview follows the
// GPU's one substep, a replay on the same device is bit-identical, and the
// page keeps running through a reload of the level (the GPU's pre-settle
// spans many frames, and the frame loop must not see a half-built level).
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
    // Retry reloads the level. Frames run during the reload (the loop really ran beside the half-loaded level), and the page is still running after it.
    const frames = await page.evaluate(() => window.__game.frames);
    await page.evaluate(() => window.__game.retry());
    expect(await page.evaluate(() => window.__game.frames)).toBeGreaterThan(frames + 1);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error, phase: window.__game.state().phase }))).toEqual({ status: 'running', error: undefined, phase: 'aiming' });
    await ready(page, 600_000);
  },
});
