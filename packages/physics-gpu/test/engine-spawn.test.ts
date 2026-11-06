// Relative spawns (engine-api spawn.ts) on the GPU engine: the shared case of @tb/testkit's spawn.ts in f32,
// with and without sleep (the spawn pass also seeds the child's quiet window).
import { describe, expect, it } from 'vitest';
import { BURST_CASE, burstMomentumError, burstScene, SPAWN_CASE, spawnErrors, spawnScene } from '@tb/testkit';
import { gpu, runGpu } from './harness.ts';

describe('GPU AVBD engine: relative spawns', () => {
  for (const sleep of [false, true]) {
    it(`starts each child where relativeBody puts it from its parent as the step starts, and leaves every other body bit for bit as it was${sleep ? ' (sleep on)' : ''}`, { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const opts = sleep ? { sleep: true } : {};
      const scene = (rel: boolean) => ({ ...spawnScene(rel), sleep });
      const base = await runGpu(scene(false), SPAWN_CASE.end, {}, 1, [], opts), rel = await runGpu(scene(true), SPAWN_CASE.end, {}, 1, [], opts);
      const r = spawnErrors(base.all, rel.all, 1);
      expect(r.children).toBe(5);
      expect(r.othersChanged).toEqual([]);
      // f32: positions near 50 m to a few ulps, velocities to rounding of the frame.
      expect(r.pos).toBeLessThan(2e-5);
      expect(r.vel).toBeLessThan(2e-5);
      expect(r.rot).toBeLessThan(2e-6);
      expect(rel.all[SPAWN_CASE.step + 1]!.tier![1]).toBe(255);
    });
  }

  it('a burst whose offsets and velocities sum to zero over children of the parent\'s mass conserves its momentum (f32)', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await runGpu(burstScene(), BURST_CASE.step + 1, {}, 1);
    expect(burstMomentumError(r.all[BURST_CASE.step]!, r.all[BURST_CASE.step + 1]!)).toBeLessThan(1e-6);
  });
});
