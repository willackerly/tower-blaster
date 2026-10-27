// The GPU AVBD engine with the loaded-gap slop (AvbdParams.gapSlop): on, it
// brings the sideways-kicked 8-cube column back to rest, as on the reference
// (physics-ref/test/avbd.test.ts). Split from engine-gapslop.test.ts, which has
// the slop's other cases, for CI's shards.
import { describe, expect, it } from 'vitest';
import { column, poked, sideways } from './gapslop-case.ts';
import { gpu } from './harness.ts';

describe('GPU AVBD engine: the loaded-gap slop (AvbdParams.gapSlop), the kicked column', () => {
  // Defect B (the reference's header). Measured on SwiftShader (2026-10-27), max speed over steps 1201-1500 and
  // the largest sideways offset at step 1500: without the slop 0.17 m/s and 11.5 mm at 10 iterations, 0.015 m/s
  // and 3.4 mm at 20 (the reference: 0.25 and 0.016 m/s); with it 8.1e-5 m/s and 0.020 mm, 1.1e-5 m/s and
  // 0.024 mm (the reference: 8.2e-5 and 1.1e-5 m/s, 0.019 and 0.024 mm).
  it.for([10, 20])('with gapSlop 3e-5 the sideways-kicked 8-cube column comes back to rest (%i iterations)', { timeout: 600_000 }, async (iterations, ctx) => {
    if (!gpu) return ctx.skip();
    const scene = column();
    const r = await poked(scene, 1500, { iterations, gapSlop: 3e-5 }, { at: 400, dv: sideways(8), win: 300 });
    let side = 0;
    scene.bodies.forEach((b, i) => { side = Math.max(side, Math.hypot(r.final.pos[3 * i]! - b.pos[0], r.final.pos[3 * i + 2]! - b.pos[2])); });
    expect(r.maxV).toBeLessThan(1e-3);
    expect(side).toBeLessThan(1e-3); // no lean left over
  });
});
