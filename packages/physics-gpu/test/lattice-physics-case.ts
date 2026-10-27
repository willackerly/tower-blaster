// The body of the lattice-physics tests (lattice-physics-<modes>.test.ts): two
// colorModes per file, so CI's shard planner can put them on different workers
// (as one file the four took 325 s on one runner, 2026-10-27).
import { expect } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { maxDiff, runGpu, runRef } from './lattice-harness.ts';

export const STAND_CASE = 'a 3x3x8 tower and an 8x8x5 block stand, matching the reference variant';

export async function standCase(colorMode: number): Promise<void> {
  for (const params of [{ F: 3, H: 8, gap: 0 }, { F: 8, H: 5, gap: 0 }]) {
    const scene = buildScenario('S1', params, 1);
    const g = await runGpu(scene, 120, { colorMode });
    const ref = await runRef(scene, 120, { colorMode });
    expect(maxDiff(ref[ref.length - 1]!.pos, g.snaps[g.snaps.length - 1]!.pos)).toBeLessThan(1e-3);
    let side = 0;
    scene.bodies.forEach((b, i) => { side = Math.max(side, Math.hypot(g.snaps[g.snaps.length - 1]!.pos[3 * i]! - b.pos[0], g.snaps[g.snaps.length - 1]!.pos[3 * i + 2]! - b.pos[2])); });
    expect(side).toBeLessThan(1e-3);
  }
}
