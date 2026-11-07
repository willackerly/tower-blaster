// Every level stands at load (the agent playtest's PT11): on the f64 reference, its pre-settle moves no body
// half a cell from where the level put it (an arch whose bricks fall in, a heap), and the 300 steps after move
// none 0.1 m. CI runs the levels of up to REF_MAX bodies (the reference takes about 0.6 ms a body a step);
// PHYSICS_GPU_SLOW=1 runs every level up to 2,000. The GPU solver's check is level-stability-gpu.test.ts and
// Rapier's (the smoke and fallback engine) level-stability-rapier.test.ts. The levels are dealt over
// level-stability.test.ts and level-stability-2/3.test.ts (largest first, in turn), so no file passes CI's
// 300 s budget for one file.
import { describe, expect, it } from 'vitest';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, SERIES } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { loadReport, REST_BOUND_M } from '../src/index.ts';

const SLOW = process.env.PHYSICS_GPU_SLOW === '1';
const REF_MAX = SLOW ? 2000 : 160;
/** A level's case timeout: CI's levels take under a minute; with PHYSICS_GPU_SLOW=1, T-S3 (1,000 bodies) took 667 s
 * on a runner (nightly run 42394058839), about 0.67 s a body, so a slow case gets 1.5 s a body over the 180 s. */
const timeout = (n: number) => 180_000 + (SLOW ? 1500 * n : 0);
export const PARTS = 3;
const levels = SERIES.flat().map((def) => ({ def, c: compileLevel(def) }));

/** Registers part `part` (1..PARTS) of the levels; part 1 also names the levels too big for the reference. */
export function refStabilitySuite(part: number): void {
  const mine = levels.filter((l) => l.c.meta.n <= REF_MAX).sort((a, b) => b.c.meta.n - a.c.meta.n || (a.def.id < b.def.id ? -1 : 1)).filter((_, i) => i % PARTS === part - 1);
  describe('every level stands at load on the reference', () => {
    for (const { def, c } of mine) it(`${def.id} (${c.meta.n} bodies)`, async () => {
      const r = await loadReport(new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP }), c);
      expect(r.settle.fell, `bodies that fell in the pre-settle (most moved ${r.settle.maxMove.toFixed(3)} m)`).toBe(0);
      expect(r.maxMove).toBeLessThan(REST_BOUND_M);
    }, timeout(c.meta.n));
    if (part === 1) it('names the levels too big for the reference here', () => {
      const big = levels.filter((l) => l.c.meta.n > REF_MAX).map((l) => l.def.id);
      if (big.length) console.log(`on the GPU solver and Rapier only (reference up to ${REF_MAX} bodies): ${big.join(', ')}`);
      expect(levels.length - big.length).toBeGreaterThanOrEqual(10);
    });
  });
}
