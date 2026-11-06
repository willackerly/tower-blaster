// Forces (engine-api force.ts) on the GPU engine: the shared case of @tb/testkit's force.ts in f32, with and
// without sleep; the held pull on a sleeping column (the forced cube wakes with its column, stays awake while
// held, and sleeps again once let go); and two runs on one device are bit for bit the same.
import { describe, expect, it } from 'vitest';
import { FORCE_CASE, forceErrors, forceScene, PULL_CASE, pullScene } from '@tb/testkit';
import { gpu, runGpu } from './harness.ts';

describe('GPU AVBD engine: forces', () => {
  for (const sleep of [false, true]) {
    it(`each step is free flight from the step before plus the force's kick h F / m; bodies never forced stay bit for bit as they were${sleep ? ' (sleep on)' : ''}`, { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const opts = sleep ? { sleep: true } : {};
      const scene = (forces: boolean) => ({ ...forceScene(forces), sleep });
      const base = await runGpu(scene(false), FORCE_CASE.end, {}, 1, [], opts), forced = await runGpu(scene(true), FORCE_CASE.end, {}, 1, [], opts);
      const r = forceErrors(base.all, forced.all, 1);
      expect(r.forced).toBe(48);
      expect(r.controlChanged).toEqual([]);
      expect(r.firstDiff).toBe(FORCE_CASE.start + 1);
      // f32: positions near 50 m to a few ulps; the kick and the frames to rounding.
      expect(r.pos).toBeLessThan(2e-5);
      expect(r.vel).toBeLessThan(2e-5);
      expect(r.rot).toBeLessThan(2e-6);
      // Bit for bit on one device: the same run again.
      const again = await runGpu(scene(true), FORCE_CASE.end, {}, 1, [], opts);
      expect(again.all).toEqual(forced.all);
    });
  }

  it('a held pull wakes the sleeping column, drags the middle cube out, the cube above falls; held still, it stays awake, and sleeps once let go', { timeout: 240_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const { rest, hold, press } = PULL_CASE, steps = rest + hold + press + 360;
    const r = await runGpu(pullScene(), steps, {}, 1, [], { sleep: true }), s = r.all, at = s[rest]!, held = s[rest + hold]!;
    // Asleep and standing when the pull begins; a step later the whole column is awake.
    expect([...at.awake]).toEqual([0, 0, 0]);
    expect(Math.abs(at.pos[7]! - 2.5)).toBeLessThan(0.01);
    expect([...s[rest + 1]!.awake]).toEqual([1, 1, 1]);
    expect(Math.hypot(held.pos[3]! - PULL_CASE.target[0], held.pos[5]! - PULL_CASE.target[2])).toBeLessThan(0.1);
    expect(held.pos[7]!).toBeLessThan(1.6);
    // Pressed onto the ground it comes to rest (quiet), and still stays awake while the force acts (SleepBody.forced).
    const pressed = s[rest + hold + press]!;
    expect(Math.abs(pressed.pos[4]! - 0.5)).toBeLessThan(0.01);
    expect(Math.hypot(pressed.linVel[3]!, pressed.linVel[4]!, pressed.linVel[5]!, pressed.angVel[3]!, pressed.angVel[4]!, pressed.angVel[5]!)).toBeLessThan(0.01);
    for (let k = rest + 1; k <= rest + hold + press; k++) expect(s[k]!.awake[1], `step ${k}`).toBe(1);
    // Let go, it falls asleep again.
    expect(s.at(-1)!.awake[1]).toBe(0);
    const again = await runGpu(pullScene(), steps, {}, 1, [], { sleep: true });
    expect(again.all).toEqual(s);
  });
});
