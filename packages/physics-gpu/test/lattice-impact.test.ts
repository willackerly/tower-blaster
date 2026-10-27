// The opt-in lattice colouring (AvbdParams.colorMode) on the GPU against
// the f64 reference variant through an impact: it follows the reference until
// the ball arrives, on every split between direct colours and the tail. Apart
// from lattice-physics.test.ts so the two run on separate CI workers.
import { describe, expect, it } from 'vitest';
import { gpu, impact, maxDiff, runGpu, runRef } from './lattice-harness.ts';

describe('GPU AVBD engine: lattice colouring against the reference variant through an impact', () => {
  // The order's own trace: the GPU is within 5e-5 of the reference variant (the default's own GPU-to-f64 gap is
  // about 1.4e-5), and farther than that from the default reference (the order moves the tower by ~1.7e-4).
  it.for([2, 3, 4])('colorMode %s: the impact matches the reference variant until the ball arrives, and every split between direct colours and the tail gives the same state, bit for bit', { timeout: 600_000 }, async (colorMode, ctx) => {
    if (!gpu) return ctx.skip();
    const scene = impact();
    const g = await runGpu(scene, 34, { colorMode });
    const ref = await runRef(scene, 34, { colorMode }), ref0 = await runRef(scene, 34, {});
    expect(maxDiff(ref[ref.length - 1]!.pos, g.snaps[g.snaps.length - 1]!.pos)).toBeLessThan(5e-5);
    expect(maxDiff(ref0[ref0.length - 1]!.pos, g.snaps[g.snaps.length - 1]!.pos)).toBeGreaterThan(5e-5);
    const base = await runGpu(scene, 48, { colorMode }, 12);
    for (const opts of [{ colorTail: 0 }, { colorTail: 2 }, { colorTail: 0, tailThreads: 1 }, { indirectColors: true }]) {
      const r = await runGpu(scene, 48, { colorMode }, 12, opts);
      expect(r.snaps, JSON.stringify(opts)).toEqual(base.snaps);
    }
  });
});
