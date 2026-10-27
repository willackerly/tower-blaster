// The S12 and S13 gates of engine.test.ts, and the brief's Q6, with the
// opt-in lattice colouring (AvbdParams.colorMode) on the GPU.
import { describe, expect, it } from 'vitest';
import { freeFlight, type SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, leanDeg, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { call, gpu, maxDiff, runGpu, runRef } from './lattice-harness.ts';

// The S12 and S13 cases of engine.test.ts with colorMode 2 and 3, at the
// iterations the tall-column gate needs (20) and with the bounds the reference
// holds there (physics-ref/test/collapse.test.ts). A column's cubes have two
// neighbours, fewer than a preference needs, so the colouring there is the
// default's; the wall's take the pattern.
describe('GPU AVBD engine: S12 and S13 with the lattice colouring, 20 iterations', () => {
  const iterations = 20;
  it.for([2, 3, 4])('S12 (colorMode %s): the cubes above a hole in a stack-bond wall fall freely, and the rest of the wall stays', { timeout: 300_000 }, async (colorMode, ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S12', {}, 1), steps = 30;
    const above = aboveHole(scene);
    const shape = await call('latticeRun', scene, 2, { colorMode, iterations }, {}, [1]);
    expect(shape.checks[0]!.tookPreference).toBeGreaterThan(scene.bodies.length / 2);
    const g = await runGpu(scene, steps, { colorMode, iterations });
    const end = g.snaps[g.snaps.length - 1]!.pos;
    for (const i of above) {
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      expect((scene.bodies[i]!.pos[1] - end[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
    }
    let worst = 0;
    scene.bodies.forEach((b, i) => {
      if (!above.includes(i)) worst = Math.max(worst, Math.hypot(end[3 * i]! - b.pos[0], end[3 * i + 1]! - b.pos[1], end[3 * i + 2]! - b.pos[2]));
    });
    expect(worst).toBeLessThan(0.03);
    const ref = await runRef(scene, steps, { colorMode, iterations }), ref0 = await runRef(scene, steps, { iterations });
    expect(maxDiff(ref[ref.length - 1]!.pos, end)).toBeLessThan(5e-5);
    expect(maxDiff(ref0[ref0.length - 1]!.pos, end)).toBeGreaterThan(5e-5);
  });

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

  // The brief's Q6 shape, a 2x2x20 tower tilted 8 deg: the S13 columns above prefer nothing (two neighbours),
  // but here the lattice part of the tower takes the pattern while the rest does not, as it falls.
  const tilted = (): SceneDesc => {
    const W = 2, H = 20, th = (8 * Math.PI) / 180, base = buildScenario('S1', { F: W, H, gap: 0 }, 1);
    const bodies = base.bodies.map((b, i) => {
      const xr = b.pos[0] - W / 2, y = b.pos[1];
      return { ...b, pos: [W / 2 + xr * Math.cos(th) + y * Math.sin(th), -xr * Math.sin(th) + y * Math.cos(th) + 1e-6 * (Math.floor(i / (W * W)) + 1), b.pos[2]] as [number, number, number], rot: [0, 0, -Math.sin(th / 2), Math.cos(th / 2)] as [number, number, number, number] };
    });
    return { ...base, bodies };
  };
  // When the first of its four columns passes 30 deg (the f64 script's t30min, without the interpolation).
  const t30 = (snaps: { step: number; pos: ArrayLike<number> }[], dt: number) => {
    const cols = [0, 1, 2, 3].map((k) => Array.from({ length: 20 }, (_, y) => 4 * y + k));
    const hit = snaps.find((s) => cols.some((cl) => leanDeg(Float64Array.from(cl.flatMap((i) => [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!])), 20) >= 30));
    return hit ? hit.step * dt : null;
  };
  it.for([[3, 0], [4, 0]] as const)('Q6 (colorMode %s, colorPriority %s): a 2x2x20 tower tilted 8 deg falls as the default does, and as the reference variant', { timeout: 600_000 }, async ([colorMode, colorPriority], ctx) => {
    if (!gpu) return ctx.skip();
    const scene = tilted(), steps = 240, p = { colorMode, colorPriority, iterations };
    const shape = await call('latticeRun', scene, 60, p, {}, [1, 10, 20, 40, 60]);
    expect(shape.error).toBeNull();
    for (const c of shape.checks) expect(c.mismatches).toBe(0);
    expect(shape.checks.reduce((a, c) => a + c.tookPreference, 0)).toBeGreaterThan(0);
    const g = await runGpu(scene, steps, p, 1), g0 = await runGpu(scene, steps, { iterations }, 1);
    const ref = await runRef(scene, steps, p, 1);
    const tg = t30(g.snaps, scene.dt), t0 = t30(g0.snaps, scene.dt), tr = t30(ref, scene.dt);
    expect(tg).not.toBeNull();
    expect(Math.abs(tg! - t0!)).toBeLessThan(0.03);
    expect(Math.abs(tg! - tr!)).toBeLessThan(0.03);
  });
});
