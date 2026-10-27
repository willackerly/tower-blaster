// The GPU AVBD engine with the loaded-gap slop (AvbdParams.gapSlop, opt-in;
// the header of physics-ref/src/avbd.ts says why), the cases of the
// reference's own tests (physics-ref/test/avbd.test.ts): off it is the engine
// as before, on it brings the sideways-kicked column back to rest, it leaves
// rolling contacts and unloaded points alone (spheres without rollingContacts
// get it), and a lifted stack or cube rests on the excused gap and comes down
// as on the reference. Its checks and variant keys are in engine.test.ts.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import type { GpuEngineOptions } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, cube, gpu, sceneOf } from './harness.ts';

describe('GPU AVBD engine: the loaded-gap slop (AvbdParams.gapSlop)', () => {
  const column = () => buildScenario('S1', { F: 1, H: 8, gap: 0 }, 1);
  // The reference test's sideways kick: before step 401 every body's velocity gains 0.01 (2 rnd - 1) m/s on x,
  // then on z, drawn in body order from its LCG.
  const sideways = (n: number): Vec3[] => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    return Array.from({ length: n }, (): Vec3 => { const x = 0.01 * (2 * rnd() - 1); return [x, 0, 0.01 * (2 * rnd() - 1)]; });
  };
  type Poke = Parameters<typeof Drivers.pokedRun>[4];
  const poked = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, poke: Poke, opts: Omit<GpuEngineOptions, 'device'> = {}) => {
    const r = await call('pokedRun', scene, steps, params, opts, poke);
    expect(r.error).toBeNull();
    expect(r.diagnostics.uncolored).toBe(0);
    expect(r.diagnostics.colorOverflow).toBe(0);
    expect(r.diagnostics.pairsRequired).toBeLessThanOrEqual(r.diagnostics.pairsWritten);
    return r;
  };
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  // The kicked column's state after 450 steps (the reference test's kicked()).
  const kicked = async (params: Partial<AvbdParams>, scene = column(), opts: Omit<GpuEngineOptions, 'device'> = {}) =>
    state((await poked(scene, 450, params, { at: 400, dv: sideways(scene.bodies.length) }, opts)).final);

  // The slop is a pipeline constant (solver.ts), passed only while it is on, so off the pipelines are built as
  // before: on SwiftShader, absent or 0, the engine gave the same floats as at 9c1ed93 (before the port) on this
  // case, at 20 iterations and with the array Hessian, and on a 3x3x8 tower, a ball knocking down two towers (S5),
  // the ball stack below and S13 leaning 2 deg (2026-10-27). On, 96 of the 104 floats here differ. The constant
  // goes to the setup, primal, tail and dual kernels; with colorTail 0 the tail sweeps every colour, and the array
  // form is another primal shader, so the last run fails if one of them is built without it.
  it('absent or 0 it is the same floats; on, it changes them alike in every primal dispatch and Hessian form', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const off = await kicked({});
    expect(await kicked({ gapSlop: 0 })).toEqual(off);
    const on = await kicked({ gapSlop: 3e-5 });
    expect(on).not.toEqual(off);
    expect(await kicked({ gapSlop: 3e-5 }, column(), { colorTail: 0, hessian: 'array' })).toEqual(on);
  });

  // The fused dual (AvbdParams.dualFusion) runs the dual update inside the primal and, from the side array, in the
  // dualPairsSide/dualGroundSide kernels: each gets the constant, so with it the floats are the unfused ones, as off
  // (engine-fused.test.ts). Built without it in any of them, the excused gap would count in full there and differ.
  // The lattice colouring (colorMode) only reorders the bodies: with the slop on it still changes the floats.
  it('with the fused dual, in the side array and in place, it is the same floats; with the lattice colouring it acts', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const on = await kicked({ gapSlop: 3e-5 });
    expect(await kicked({ gapSlop: 3e-5, dualFusion: true })).toEqual(on);
    expect(await kicked({ gapSlop: 3e-5, dualFusion: true }, column(), { solveContactsRW: true })).toEqual(on);
    expect(await kicked({ gapSlop: 3e-5, dualFusion: true }, column(), { colorTail: 0 })).toEqual(on);
    expect(await kicked({ gapSlop: 3e-5, colorMode: 3 })).not.toEqual(await kicked({ colorMode: 3 }));
  });

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

  it('it leaves rolling contacts alone, and spheres without rollingContacts get it: a ball on a cube on a ball, kicked', { timeout: 400_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const ball = (y: number): BodyDesc => ({ ...cube([0, y, 0]), shape: { kind: 'sphere', radius: 0.5 } });
    const balls = sceneOf([ball(0.5), cube([0, 1.5, 0]), ball(2.5)]);
    // Every contact rolls (rollingContacts is on by default): the same floats.
    expect(await kicked({ gapSlop: 3e-5 }, balls)).toEqual(await kicked({}, balls));
    // Without rollingContacts the same contacts are plain points and get it, so the gate is rollingContacts and
    // not the shape. Kicked before step 101 instead, to keep it short: 50 steps on, 39 of the 39 floats differ
    // (2026-10-27; 39 of 39 too at 450 steps, here and on the reference).
    const plain = async (params: Partial<AvbdParams>) => state((await poked(balls, 150, { rollingContacts: false, ...params }, { at: 100, dv: sideways(3) })).final);
    expect(await plain({ gapSlop: 3e-5 })).not.toEqual(await plain({}));
  });

  it('it leaves unloaded points alone: a cube dropped flat lands with the same floats', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Fresh (speculative) contacts carry no force, so their gap counts in full and nothing is stopped short.
    for (const bodies of [[cube([0, 0.51, 0])], [cube([0, 0.5, 0]), cube([0, 1.52, 0])]]) {
      const scene = sceneOf(bodies);
      expect(state((await poked(scene, 60, { gapSlop: 3e-5 }, { at: -1 })).final)).toEqual(state((await poked(scene, 60, {}, { at: -1 })).final));
    }
  });

  // The settled scene's bodies `top` lifted by `by` after `settle` steps, then the largest lift left after each of
  // `n` steps, with gapSlop 3e-5, on the GPU and on the reference.
  const lifted = async (scene: SceneDesc, top: number[], by: number, settle: number, n: number) => {
    const gpuRise = (await poked(scene, settle + n, { gapSlop: 3e-5 }, { at: settle, lift: top, by, riseSteps: n })).rise;
    const e = new AvbdReferenceEngine({ gapSlop: 3e-5 });
    await e.init(scene);
    for (let i = 0; i < settle; i++) e.step();
    const bodies = top.map((b) => e.world!.bodies[b]!), y0 = bodies.map((b) => b.pos[1]);
    for (const b of bodies) b.pos[1] += by;
    const refRise: number[] = [];
    for (let i = 0; i < n; i++) { e.step(); refRise.push(Math.max(...bodies.map((b, k) => b.pos[1] - y0[k]!))); }
    expect(gpuRise).toHaveLength(n);
    return { gpu: gpuRise, ref: refRise };
  };
  // The reference test's hover probe: the settled column's top 4 cubes lifted by 25 um (and 100 um). Measured on
  // SwiftShader (2026-10-27), 25 um: 24.8 um after 1 step, 12.9 after 10, 8.1 after 20 (the reference 25.0, 11.9,
  // 6.4); then it stops closing, 6.2 um up from step 27 on, where the reference's goes on (0.71 um after 60
  // steps). That is f32, since it depends on where the scene is (3.5 um with it moved 6 m down, 2.6 um 4 m
  // down); which f32 quantity sets it is not traced. Without the slop the same lift is down to 1.9 um within 2
  // steps and stays there (0.95 um 6 m lower). Lifted 100 um: 48.6 um after 1 step (the reference 48.1; 100 if the
  // whole gap were excused); without the slop 6.7 um and 26.2 um (the reference 6.5 and 25.8).
  const top4 = [4, 5, 6, 7];
  it('with gapSlop 3e-5 a lifted stack rests on the excused gap and comes down as on the reference, never rising', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const { gpu: on, ref } = await lifted(column(), top4, 25e-6, 400, 60);
    expect(on[0]).toBeGreaterThan(20e-6); // it rests on the excused gap (6.7 um without the slop)
    expect(Math.abs(on[0]! - ref[0]!)).toBeLessThan(1e-6);
    // Never above where it was put, but for one f32 position step (the lift itself is rounded to one).
    expect(Math.max(...on)).toBeLessThan(25e-6 + 0.5e-6);
    expect(Math.abs(on[9]! - ref[9]!)).toBeLessThan(2e-6);
    expect(on[19]).toBeLessThan(10e-6);
    expect(on[59]).toBeLessThan(8e-6); // stopped closing at 6.2 um (above)
    const { gpu: far, ref: farRef } = await lifted(column(), top4, 100e-6, 400, 1);
    // More than the slop: only gapSlop of the gap is excused.
    expect(far[0]).toBeGreaterThan(35e-6);
    expect(far[0]).toBeLessThan(75e-6);
    expect(Math.abs(far[0]! - farRef[0]!)).toBeLessThan(1e-6);
  });

  // The same, well resolved: one cube resting on the ground (0.5 m up, where an f32 position step is 0.06 um),
  // lifted 25 um. Measured on SwiftShader (2026-10-27): 13.14 um after 1 step, 6.88 after 2, 0.09 after 10 (the
  // reference 13.10, 6.87, 0.04); without the slop 0.03 um after 1 step. It tells the primal's part apart: with
  // the constant left out of the primal pipelines only (the dual still applying it) the cube stays 25.0 um up,
  // 11.9 um off the reference's after 1 step, where the column above shows 1.2 um.
  it('with gapSlop 3e-5 a cube on the ground lifted 25 um comes down as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const { gpu: on, ref } = await lifted(sceneOf([cube([0, 0.5, 0])]), [0], 25e-6, 100, 10);
    expect(on[0]).toBeGreaterThan(10e-6); // it rests on the excused gap
    expect(Math.abs(on[0]! - ref[0]!)).toBeLessThan(1e-6);
    expect(Math.abs(on[9]! - ref[9]!)).toBeLessThan(0.5e-6);
  });
});
