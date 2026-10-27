// The opt-in lattice colouring (AvbdParams.colorMode) on the GPU against
// the f64 reference variant: packed stacks stand (lattice-impact.test.ts:
// an impact; lattice-colours.test.ts: the colours themselves).
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { gpu, maxDiff, runGpu, runRef } from './lattice-harness.ts';

describe('GPU AVBD engine: lattice colouring against the reference variant', () => {
  it.for([1, 2, 3, 4])('colorMode %s: a 3x3x8 tower and an 8x8x5 block stand, matching the reference variant', { timeout: 300_000 }, async (colorMode, ctx) => {
    if (!gpu) return ctx.skip();
    for (const params of [{ F: 3, H: 8, gap: 0 }, { F: 8, H: 5, gap: 0 }]) {
      const scene = buildScenario('S1', params, 1);
      const g = await runGpu(scene, 120, { colorMode });
      const ref = await runRef(scene, 120, { colorMode });
      expect(maxDiff(ref[ref.length - 1]!.pos, g.snaps[g.snaps.length - 1]!.pos)).toBeLessThan(1e-3);
      let side = 0;
      scene.bodies.forEach((b, i) => { side = Math.max(side, Math.hypot(g.snaps[g.snaps.length - 1]!.pos[3 * i]! - b.pos[0], g.snaps[g.snaps.length - 1]!.pos[3 * i + 2]! - b.pos[2])); });
      expect(side).toBeLessThan(1e-3);
    }
  });
});
