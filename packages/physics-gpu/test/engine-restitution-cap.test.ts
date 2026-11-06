// The GPU's restitution energy cap (AvbdParams.restitutionEnergyCap, on by
// default with restitution; src/restitution.ts's island kernels, the rule in
// the reference's restitute(), "Energy cap", physics-ref/src/avbd.ts): no
// island (bodies joined by the step's contacts) leaves the pass with more of
// semi-implicit Euler's invariant energy than it had at the start of the step
// or than the solve left it. The reference's own property test is
// physics-ref/test/restitution-cap.test.ts; here the GPU is held to the
// reference's scaling, its labels to their definition, its sums to replay
// bit for bit, and the property to the host's own energies on S5 knocks.
//
// Measured on SwiftShader (2026-11-06) unless a comment says otherwise. Off,
// the engine gave the same floats as before the cap (main at f45f639) on 4
// scenes: an S5 knock at e 0.9 (records 1, the point Hessian array, and
// without anchors) and a heavy ball onto a cube; on, the heavy ball's run was
// unchanged too (the cap never scaled it).
import { describe, expect, it } from 'vitest';
import type { BodyDesc, SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { both, cube, floats, gainOf, gpuRun, islandExcess, ON, type Run, shadowEnergy, withE, zeroG } from './bounce.ts';
import { gpu } from './harness.ts';

const slow = process.env.PHYSICS_GPU_SLOW === '1';
/** The E4 knock set: a ball at `speed` and `massRatio` into a 48-cube S5 city, every e set to e. */
const knockOf = (e: number, speed: number, massRatio: number) => withE(buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio, radius: 0.6 }, 1), e);
const KNOCKS = [0.3, 0.5, 0.6, 0.9].flatMap((e) => [8, 15, 25].flatMap((v) => [5, 50].map((mr) => [e, v, mr] as const)));

describe('GPU AVBD engine: restitution energy cap', () => {
  // Two cubes side by side strike a tall box at e 1 in zero g: a chain the rounds over-resolve (the reference's
  // header, "Energy in chains of simultaneous impacts"). Measured, without the cap: both engines end 1.867e-3
  // (16 rounds) and 3.366e-3 (64) above the start, to 1e-6 of each other; with it, both scale on step 4 only, by
  // alpha 0.99809 (GPU) and 0.99812 (reference) at 16 rounds, 0.99660 and 0.99663 at 64, and neither ends above
  // its start (the GPU 3e-5 under it: D rounded down, G and Q up, in f32).
  it('two cubes into a box at e 1: with the cap neither engine gains, scaled on the same step by the same alpha to 1e-4; without it both gain', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 1, box: BodyDesc = { ...cube([0, 0, 0], { e }), shape: { kind: 'box', half: [0.5, 1, 0.5] } };
    const scene = zeroG([cube([-1.3, 0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), cube([-1.3, -0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), box]);
    for (const rounds of [16, 64]) {
      const on = await both(scene, 60, { ...ON, restitutionRounds: rounds }, true), id = `${rounds} rounds`;
      expect(gainOf(scene, on.ref).gain, id).toBeLessThanOrEqual(1e-12);
      expect(gainOf(scene, on.gpu).gain, id).toBeLessThanOrEqual(1e-6);
      const capped = (r: typeof on.gpu) => r.stats.flatMap((s, k) => (s?.capped ? [k] : []));
      expect(capped(on.gpu), id).toEqual(capped(on.ref));
      expect(capped(on.ref).length, id).toBeGreaterThan(0);
      for (const k of capped(on.ref)) {
        expect(on.ref.stats[k]!.capAlpha, id).toBeLessThan(1);
        expect(Math.abs(on.gpu.stats[k]!.capAlpha - on.ref.stats[k]!.capAlpha), id).toBeLessThan(1e-4);
      }
      const off = await both(scene, 60, { ...ON, restitutionRounds: rounds, restitutionEnergyCap: false });
      expect(gainOf(scene, off.ref).gain, id).toBeGreaterThan(1e-3);
      expect(Math.abs(gainOf(scene, off.gpu).gain - gainOf(scene, off.ref).gain), id).toBeLessThan(1e-5);
    }
  });

  // The labels (restIslandHook, then restIslandSum's compression): each body's island's least index, the bodies
  // listed out of order; a body in no contact is its own. Three groups in zero g: {1, 3} and {0, 2, 4} closing at
  // 4 m/s, and 5 alone.
  it('labels each island by its least body, whatever the order; a body in no contact is its own', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const at = (x: number, vx = 0) => ({ ...cube([x, 0, 0], { linVel: [vx, 0, 0] }), restitution: 0.8 });
    const scene = zeroG([at(11), at(0.99, -2), at(12, -2), at(0, 2), at(10, 2), at(20, 1)]);
    const r = await gpuRun(scene, 1, ON, {}, true);
    expect(r.stats[0]!.contacts).toBeGreaterThan(0);
    expect(r.labels).toEqual([[0, 1, 0, 1, 0, 5]]);
  });

  // The sums are integers (fixed point, restitution.ts's ISLAND), so any order of the atomics gives the same alpha:
  // a run replays to the bit. (SwiftShader may run the atomics in one order; the property is the integers'.)
  it('replays bit for bit: an S5 knock at e 0.9, the same floats and labels, the cap having scaled steps', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = knockOf(0.9, 15, 5);
    const a = await gpuRun(scene, 120, ON, {}, true), b = await gpuRun(scene, 120, ON, {}, true);
    expect(floats(b)).toEqual(floats(a));
    expect(b.labels).toEqual(a.labels);
    expect(a.stats.filter((s) => s?.capped).length).toBeGreaterThan(0); // measured 8
  });

  // The E4 knock set (240 steps each), every island of every bouncing step checked with the host's energies
  // (islandExcess). In CI, three: e 0.9 at 15 m/s, mass ratio 5 (the one of the 24 whose total energy rises
  // without the cap, 3.87% at step 18), e 0.6 at 8 m/s (the knock whose pass jams on the reference without the
  // cap, adding 73% by step 160) and e 0.9 at 8 m/s, mass ratio 50 (8 steps scaled); PHYSICS_GPU_SLOW=1 runs all
  // 24. Measured over the 24 with the cap: no island above its bound, the cap scaling 0-9 steps a run, and no
  // run's total energy above its start (without it, 1 of 24).
  it(`S5 knocks${slow ? ' (all 24)' : ' (3 of 24; PHYSICS_GPU_SLOW=1 for all)'}: no island leaves the pass with more energy than its start or the solve gave it`, { timeout: 1_800_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const cases = slow ? KNOCKS : ([[0.9, 15, 5], [0.6, 8, 5], [0.9, 8, 50]] as const);
    const gainFrom1 = (scene: SceneDesc, r: Run) => {
      // The whole scene from the ball's first step (snaps[0] is before it spawns).
      const E0 = shadowEnergy(scene, r.snaps[1]!);
      return (Math.max(...r.snaps.slice(1).map((s) => shadowEnergy(scene, s))) - E0) / Math.abs(E0);
    };
    let capped = 0;
    for (const [e, v, mr] of cases) {
      const scene = knockOf(e, v, mr), id = `e ${e} at ${v} m/s, mass ratio ${mr}`;
      const r = await gpuRun(scene, 240, ON, {}, true);
      const x = islandExcess(scene, r);
      expect(x.steps, id).toBeGreaterThan(0);
      expect(x.worst, id).toBeLessThanOrEqual(1e-5);
      expect(gainFrom1(scene, r), id).toBeLessThanOrEqual(1e-6);
      capped += r.stats.filter((s) => s?.capped).length;
    }
    expect(capped).toBeGreaterThan(0);
    // Teeth: without the cap the first of them gains (measured 3.87%).
    const knock9 = knockOf(0.9, 15, 5);
    expect(gainFrom1(knock9, await gpuRun(knock9, 60, { ...ON, restitutionEnergyCap: false }))).toBeGreaterThan(1e-2);
  });
});
