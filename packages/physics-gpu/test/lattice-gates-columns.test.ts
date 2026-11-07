// The S13 gates of engine.test.ts with the opt-in lattice colouring
// (AvbdParams.colorMode) on the GPU; S12 and Q6 are lattice-gates.test.ts (split for CI's 300 s per file).
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { call, gpu, runGpu, runRef } from './lattice-harness.ts';

// The S12 and S13 cases of engine.test.ts with colorMode 2 and 3, at the
// iterations the tall-column gate needs (20) and with the bounds the reference
// holds there (physics-ref/test/collapse.test.ts). A column's cubes have two
// neighbours, fewer than a preference needs, so the colouring there is the
// default's; the wall's take the pattern.
describe('GPU AVBD engine: S12 and S13 with the lattice colouring, 20 iterations', () => {
  const iterations = 20;
  const column = async (colorMode: number, deg: number, steps: number) => {
    const H = 20, scene = buildScenario('S13', { H, deg }, 1);
    const shape = await call('latticeRun', scene, 1, { colorMode, iterations }, {}, [1]);
    expect(shape.checks[0]!.preferring).toBe(0);
    const g = await runGpu(scene, steps, { colorMode, iterations }, 5);
    const ref = await runRef(scene, steps, { colorMode, iterations }, 5);
    return { H, gpu: readColumn(g.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), ref: readColumn(ref.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H) };
  };

  it.for([2, 3])('S13 (colorMode %s): a 20-cube column leaning 4 deg topples within 3% of the rigid column, bending < 0.1 m', { timeout: 300_000 }, async (colorMode, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(colorMode, 4, 330), rod = rodToppleTime(r.H, 4, 30);
    expect(r.gpu.topple).not.toBeNull();
    expect(Math.abs(r.gpu.topple! / rod - 1)).toBeLessThan(0.03);
    expect(r.gpu.bend).toBeLessThan(0.1);
    expect(Math.abs(r.gpu.topple! - r.ref.topple!)).toBeLessThan(0.02);
  });

  it.for([2, 3])('S13 (colorMode %s): a 20-cube column leaning 2 deg rocks back past upright within 3% of the rigid column, no further than it', { timeout: 300_000 }, async (colorMode, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(colorMode, 2, 300), rod = rodRock(r.H, 2);
    expect(r.gpu.upright).not.toBeNull();
    expect(Math.abs(r.gpu.upright! / rod.upright - 1)).toBeLessThan(0.03);
    expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
    expect(r.gpu.turned).toBe(true);
    expect(r.gpu.farSide / rod.farSide).toBeGreaterThan(0.85);
    expect(r.gpu.farSide / rod.farSide).toBeLessThan(1.02);
    expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
  });

});
