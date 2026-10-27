// The body of the lattice-impact tests (lattice-impact-<mode>.test.ts): one
// file per colorMode, so CI's shard planner can put them on different
// workers (as one file the three took 835 s on one runner, 2026-10-27).
import { expect } from 'vitest';
import { impact, maxDiff, runGpu, runRef } from './lattice-harness.ts';

export const IMPACT_CASE = 'the impact matches the reference variant until the ball arrives, and every split between direct colours and the tail gives the same state, bit for bit';

// The order's own trace: the GPU is within 5e-5 of the reference variant (the default's own GPU-to-f64 gap is
// about 1.4e-5), and farther than that from the default reference (the order moves the tower by ~1.7e-4).
export async function impactCase(colorMode: number): Promise<void> {
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
}
