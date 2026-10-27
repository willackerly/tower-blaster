// The GPU AVBD engine bringing columns to rest (the load cap) and walls and
// columns falling as rigid bodies do (S12, S13).
import { describe, expect, it } from 'vitest';
import { type BodyDesc, freeFlight } from '@tb/engine-api';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { gpu, runGpu, runRef } from './harness.ts';

describe('GPU AVBD engine: the load cap (AvbdParams.loadCap)', () => {
  // physics-ref/test/avbd.test.ts says why: with the load floor alone, k_n
  // keeps a landing's stiffness for ~100 steps, and a column taller than 10
  // iterations resolve boils for good. The cap eases it back down within a
  // dozen-odd steps (capFall). The columns stand 40 m apart in one scene, so
  // one run covers them (on SwiftShader a run costs mostly per step). Speeds,
  // heights and sideways drift from the start are sampled every 10 steps over
  // steps 301-600. Measured 2026-10-26 on SwiftShader: max speed 1.7e-7,
  // 1.4e-7, 6.8e-5 and 1.4e-6 m/s, sideways at most 0.047 mm. With loadCap 0
  // the 1x1x24 and 2x2x30 columns boil (0.36 and 0.66 m/s; the 2x2x30 one
  // 0.41 m sideways), and a 4x4x25 tower rests with the cap (4e-5 m/s,
  // 0.051 mm). Those runs cost CI time (118 s for the tower on SwiftShader),
  // so they are opt-in (PHYSICS_GPU_SLOW=1, below), with an S4 city tower;
  // the reference tests cover both on the CPU path.
  const column = (F: number, H: number) => buildScenario('S1', { F, H, gap: 0 }, 1).bodies;
  const settle = async (parts: [string, BodyDesc[]][], params: Partial<AvbdParams> = {}) => {
    const bodies: BodyDesc[] = [], range: [number, number][] = [];
    parts.forEach(([, p], i) => {
      range.push([bodies.length, bodies.length + p.length]);
      for (const b of p) bodies.push({ ...b, pos: [b.pos[0] + 40 * i, b.pos[1], b.pos[2]] });
    });
    const scene = { ...buildScenario('S1', { F: 1, H: 1, gap: 0 }, 1), id: 'load-cap', sleep: false, bodies };
    const g = await runGpu(scene, 600, params, 10);
    const out = new Map<string, { maxV: number; maxUp: number; side: number }>();
    parts.forEach(([name], i) => {
      let maxV = 0, maxUp = -Infinity, side = 0;
      for (const s of g.snaps.filter((x) => x.step > 300))
        for (let b = range[i]![0]; b < range[i]![1]; b++) {
          const p0 = bodies[b]!.pos;
          maxV = Math.max(maxV, Math.hypot(s.linVel[3 * b]!, s.linVel[3 * b + 1]!, s.linVel[3 * b + 2]!));
          maxUp = Math.max(maxUp, s.pos[3 * b + 1]! - p0[1]);
          side = Math.max(side, Math.hypot(s.pos[3 * b]! - p0[0], s.pos[3 * b + 2]! - p0[2]));
        }
      out.set(name, { maxV, maxUp, side });
      console.log(`load cap GPU ${name} ${JSON.stringify(params)}: maxV=${maxV.toExponential(2)} maxUp=${(maxUp * 1e3).toFixed(3)}mm side=${(side * 1e3).toFixed(3)}mm`);
    });
    console.log(`load cap GPU ${bodies.length} bodies ${JSON.stringify(params)}: wall=${(g.wallMs / 1000).toFixed(1)}s`);
    return out;
  };
  it('packed columns of 1x1x24, 1x1x30 and 2x2x30 cubes, and 24 cubes under a 100x heavier one (S9), come to rest without sliding (10 iterations)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await settle([['1x1x24', column(1, 24)], ['1x1x30', column(1, 30)], ['2x2x30', column(2, 30)], ['S9', buildScenario('S9', { H: 24, ratio: 100 }, 1).bodies]]);
    for (const [name, v] of r) {
      expect(v.maxV, name).toBeLessThan(1e-3);
      expect(v.maxUp, name).toBeLessThan(1e-4);
      expect(v.side, name).toBeLessThan(1e-3);
    }
  });
  // Opt-in, too slow for CI: 5.5 and 0.8 minutes on SwiftShader. Measured 2026-10-26 on SwiftShader: the 4x4x25 and
  // 8x8x25 towers 4.0e-5 and 2.8e-5 m/s, 0.051 and 0.046 mm sideways.
  const slow = process.env.PHYSICS_GPU_SLOW === '1';
  it.runIf(slow)('slow: a packed 4x4x25 tower and an S4 city tower (8x8x25) come to rest without sliding (10 iterations)', { timeout: 3_600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await settle([['4x4x25', column(4, 25)], ['S4 8x8x25', buildScenario('S4', { N: 1600, F: 8, H: 25, street: 6 }, 1).bodies]]);
    for (const [name, v] of r) {
      expect(v.maxV, name).toBeLessThan(1e-3);
      expect(v.maxUp, name).toBeLessThan(1e-4);
      expect(v.side, name).toBeLessThan(1e-3);
    }
  });
  it.runIf(slow)('slow: with the floor alone (loadCap 0) the 1x1x24 and 2x2x30 columns never come to rest', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await settle([['1x1x24', column(1, 24)], ['2x2x30', column(2, 30)]], { loadCap: 0 });
    for (const [name, v] of r) expect(v.maxV, name).toBeGreaterThan(0.1);
  });
});

describe('GPU AVBD engine: walls and columns fall as rigid bodies do (S12, S13)', () => {
  // The cases of physics-ref/test/collapse.test.ts, which says why, at the
  // default 10 iterations, plus agreement with the reference run. The
  // reference also covers 20 iterations; on SwiftShader each S13 case here
  // takes 17-27 s on the dev VM, so the GPU runs only the shipping default.
  it('S12: the cubes above a hole in a stack-bond wall fall freely, and the rest of the wall stays', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S12', {}, 1), steps = 30;
    const above = aboveHole(scene);
    expect(above).toHaveLength(18);
    const g = await runGpu(scene, steps);
    for (const i of above) {
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      expect((scene.bodies[i]!.pos[1] - g.s1.pos[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
    }
    let worst = 0;
    scene.bodies.forEach((b, i) => {
      if (!above.includes(i)) worst = Math.max(worst, Math.hypot(g.s1.pos[3 * i]! - b.pos[0], g.s1.pos[3 * i + 1]! - b.pos[1], g.s1.pos[3 * i + 2]! - b.pos[2]));
    });
    expect(worst).toBeLessThan(0.03);
    const ref = await runRef(scene, steps);
    let diff = 0;
    for (let k = 0; k < ref.pos.length; k++) diff = Math.max(diff, Math.abs(ref.pos[k]! - g.s1.pos[k]!));
    expect(diff).toBeLessThan(1e-3);
  });

  const column = async (deg: number, steps: number, iterations: number) => {
    const H = 20, scene = buildScenario('S13', { H, deg }, 1);
    const g = await runGpu(scene, steps, { iterations }, 5);
    const e = new AvbdReferenceEngine({ iterations });
    await e.init(scene);
    const ref = [{ t: 0, pos: [...e.snapshot().pos] }];
    for (let i = 1; i <= steps; i++) { e.step(); if (i % 5 === 0 || i === steps) ref.push({ t: i * scene.dt, pos: [...e.snapshot().pos] }); }
    return { H, gpu: readColumn(g.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), ref: readColumn(ref, H) };
  };

  it('S13: a 20-cube column leaning 4 deg topples like the rigid column', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(4, 330, 10), rod = rodToppleTime(r.H, 4, 30);
    expect(r.gpu.topple).not.toBeNull();
    expect(Math.abs(r.gpu.topple! / rod - 1)).toBeLessThan(0.12);
    expect(Math.abs(r.gpu.topple! - r.ref.topple!)).toBeLessThan(0.02);
  });

  it('S13: a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(2, 300, 10), rod = rodRock(r.H, 2);
    expect(r.gpu.upright).not.toBeNull();
    expect(Math.abs(r.gpu.upright! / rod.upright - 1)).toBeLessThan(0.15);
    expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
    expect(r.gpu.turned).toBe(true);
    // The far side is the one number here that rounding moves: on SwiftShader the GPU crosses upright 0.005 s
    // after the reference (step ~123), and the landing there sets the swing. With the load cap, moving every start
    // position by up to 1e-6 m spreads the reference's far side over 1.185-1.273 deg (360 seeds, 2026-10-26),
    // from 0.057 below the unmoved run to 0.031 above it; rounding its state to f32 each step moves it 0.0001
    // (bodies) or 0.010 (bodies and contacts). The GPU's 1.192 on SwiftShader is 0.050 below, inside that spread
    // (0.018 off with the floor alone). So the GPU - reference bounds follow the spread, -0.07 / +0.04, and on the
    // low side that bound binds: 1.172 deg, 0.596 of the rigid column's far side, 0.020 below the GPU and 0.013
    // below the spread's lowest run (0.602 of the rigid column's; the GPU 0.606). The 0.58 gate is a backstop in
    // case the reference itself moves; physics-ref/test/collapse.test.ts holds the unmoved reference (0.63) to 0.6.
    expect(r.gpu.farSide / rod.farSide).toBeGreaterThan(0.58);
    expect(r.gpu.farSide / rod.farSide).toBeLessThan(1.02);
    expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
    expect(r.gpu.farSide - r.ref.farSide).toBeGreaterThan(-0.07);
    expect(r.gpu.farSide - r.ref.farSide).toBeLessThan(0.04);
  });
});
