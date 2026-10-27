// The GPU AVBD engine with the fused dual update (AvbdParams.dualFusion): the
// same bodies and contact records as the separate dual pass, bit for bit, in
// the side array and in place (GpuEngineOptions.solveContactsRW), and the
// S12/S13 gates against the reference with dualFusion too.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, freeFlight, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { GpuAvbdEngine, type GpuEngineOptions, HESSIAN_FORMS, solveWgsl } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, cube, gpu, runGpu, sceneOf, toSnap } from './harness.ts';

describe('GPU AVBD engine: fused dual (AvbdParams.dualFusion)', () => {
  // Each contact's dual update after main sweep k < I - 1 runs at the
  // contact's first visit in sweep k + 1 (solver.ts contactForce()), by the
  // earlier body in the colour order, or the body itself for a ground contact;
  // the last main sweep's still runs as a pass. Neither body has moved in
  // between, so it is the separate pass's arithmetic on the same values: on
  // SwiftShader every body and every contact record must match the default
  // bit for bit, with the dual state in the side array (ContactDual, the
  // default with dualFusion) and in the records (solveContactsRW), on every
  // split between direct colours and the tail.
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  type Variant = { params?: Partial<AvbdParams>; opts?: Omit<GpuEngineOptions, 'device'> };
  const FUSED: Variant = { params: { dualFusion: true } };
  const IN_PLACE: Variant = { params: { dualFusion: true }, opts: { solveContactsRW: true } };
  /** The scene without fusion (base options), then each variant (its own options, else the base's): every snapshot and the whole contact buffer the same. */
  const same = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, variants: Variant[], every = 0, baseOpts: Omit<GpuEngineOptions, 'device'> = {}) => {
    const base = await call('simulateGpu', scene, steps, params, every, baseOpts, [], true);
    expect(base.error).toBeNull();
    expect(base.contacts!.used).toBeGreaterThan(10);
    for (const v of variants) {
      const r = await call('simulateGpu', scene, steps, { ...params, ...v.params }, every, v.opts ?? baseOpts, [], true);
      const what = JSON.stringify(v);
      expect(r.error, what).toBeNull();
      expect(r.snaps.length).toBe(base.snaps.length);
      r.snaps.forEach((s, k) => expect(state(s), `${what}, step ${s.step}`).toEqual(state(base.snaps[k]!)));
      expect(r.contacts, what).toEqual(base.contacts);
    }
    const last = toSnap(base.snaps.at(-1)!);
    expect(nonFinite(last)).toBe(0);
    return base;
  };
  // A ball into two 2x2x8 towers (it reaches them at about step 17): contacts from the first step, and colours that change.
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

  it('a ball into two towers: bodies and contacts bit for bit, in the side array and in place, on every split', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Every colour in the tail, also at 8 threads and 1, where its colours are larger than the workgroup and taken in strides.
    const splits = [{}, { indirectColors: true }, { colorTail: 0 }, { colorTail: 2 }, { colorTail: 63 }, { colorTail: 0, tailThreads: 256 }, { colorTail: 0, tailThreads: 8 }, { colorTail: 0, tailThreads: 1 }];
    const base = await same(knock(), 24, { iterations: 4 }, [
      ...splits.map((opts) => ({ ...FUSED, opts })), IN_PLACE, { ...IN_PLACE, opts: { ...IN_PLACE.opts, colorTail: 0 } },
      // The contacts binding alone (the read-only path's A/B) changes nothing either.
      { opts: { solveContactsRW: true } },
    ], 4);
    expect(base.maxColors).toBeGreaterThan(2);
  });

  it('colour overflow (2 colouring rounds): touching uncoloured bodies in colour 63, solved one after another, bit for bit on every split', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Most bodies stay uncoloured and go to colour 63, where a contact's two bodies share the colour and the earlier
    // in the colour order (the lower index) runs its dual update. The serial sweep (colorTail 0, one thread) is the oracle.
    const base = await same(knock(), 24, { iterations: 4 }, [
      { ...FUSED, opts: { colorRounds: 2 } }, { ...FUSED, opts: { colorRounds: 2, colorTail: 0 } }, { ...FUSED, opts: { colorRounds: 2, indirectColors: true } },
      { ...FUSED, opts: { colorRounds: 2, colorTail: 0, tailThreads: 1 } }, { ...IN_PLACE, opts: { ...IN_PLACE.opts, colorRounds: 2 } },
    ], 4, { colorRounds: 2, colorTail: 0, tailThreads: 1 });
    expect(base.worst.uncolored).toBeGreaterThan(20);
  });

  it('S5, a small city hit by a ball, at 10 iterations (the default): bit for bit every 10 steps', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S5', { N: 150, F: 3, H: 6, street: 2, fireStep: 0, radius: 0.8, speed: 15 }, 1);
    expect(scene.bodies.some((b) => b.shape.kind === 'sphere') || scene.inputs.some((e) => e.body.shape.kind === 'sphere')).toBe(true);
    await same(scene, 40, {}, [FUSED, IN_PLACE], 10);
  });

  it('20 iterations, 1 (nothing to fuse) and 2 (one fused update), and the array form: bit for bit', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const iterations of [20, 1, 2]) await same(knock(), 24, { iterations }, [FUSED, IN_PLACE], 8);
    await same(knock(), 24, { iterations: 4 }, [{ ...FUSED, opts: { hessian: 'array' } }, { ...IN_PLACE, opts: { ...IN_PLACE.opts, hessian: 'array' } }], 8, { hessian: 'array' });
  });

  it('spheres on boxes, on each other and rolling into a box (rolling contacts): bit for bit', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const sphere = (pos: Vec3, radius: number, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), shape: { kind: 'sphere', radius } });
    const scene = sceneOf([
      cube([-1.2, 0.5, 0]), cube([0, 0.5, 0]), cube([1.2, 0.5, 0]),
      sphere([-1.2, 1.4, 0], 0.4), sphere([0, 1.4, 0], 0.4, [0.5, 0, 0.2]), sphere([1.2, 1.4, 0], 0.4),
      sphere([3, 0.5, 0], 0.5), sphere([4, 0.5, 0], 0.5), sphere([3.5, 0.5, 0.866], 0.5), sphere([3.5, 1.32, 0.289], 0.5),
      sphere([-4.5, 0.5, 0], 0.5, [3, 0, 0.3]), cube([-3, 0.5, 0]),
    ]);
    await same(scene, 60, {}, [FUSED, IN_PLACE], 20);
  });

  it('drops the dual dispatches between main sweeps, keeps the last, and adds one (visitOrder)', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 200 }, 7);
    for (const iterations of [3, 6]) {
      const def = await call('dispatchCounts', scene, { iterations }, {});
      for (const v of [FUSED, IN_PLACE]) {
        const fused = await call('dispatchCounts', scene, { iterations, ...v.params }, v.opts ?? {});
        expect([def.error, fused.error]).toEqual([null, null]);
        // Indirect: match, narrowphase pairs, degree, fill, pair setup, and the dual pairs once (not per iteration).
        expect(fused.indirect).toBe(6);
        expect(def.indirect - fused.indirect).toBe(iterations - 1);
        // Direct: the dual's ground dispatch I - 1 times fewer, plus visitOrder.
        expect(def.direct - fused.direct).toBe(iterations - 2);
      }
    }
  });

  it('the option reaches the shaders: read-only contacts in a side array, 8 storage buffers per kernel at most, and the variant', async (ctx) => {
    const reg = solveWgsl('registers');
    const storage = (wgsl: string) => (wgsl.replace(/\/\/.*$/gm, '').match(/var<storage/g) ?? []).length;
    expect(solveWgsl('registers', { dualFusion: false, solveContactsRW: false })).toBe(reg);
    for (const hessian of HESSIAN_FORMS) {
      const side = solveWgsl(hessian, { dualFusion: true }), inPlace = solveWgsl(hessian, { dualFusion: true, solveContactsRW: true });
      expect(side).toContain('var<storage, read> contacts');
      expect(side).toContain('var<storage, read_write> duals: array<ContactDual>');
      expect(side).toContain('fn visitOrder(');
      expect(side.replace(/\/\/.*$/gm, '')).not.toMatch(/colorStart\[/);
      expect(inPlace).toContain('var<storage, read_write> contacts');
      expect(inPlace).not.toContain('duals');
      expect(solveWgsl(hessian, { solveContactsRW: true })).toBe(solveWgsl(hessian).replace('var<storage, read> contacts', 'var<storage, read_write> contacts'));
      for (const w of [solveWgsl(hessian), side, inPlace]) expect(storage(w)).toBeLessThanOrEqual(8);
    }
    expect(new GpuAvbdEngine({ dualFusion: true }, { solveContactsRW: true }).info.variant).toMatchObject({ dualFusion: true, solveContactsRW: true });
    expect(new GpuAvbdEngine({}).info.variant).not.toHaveProperty('dualFusion');
    expect(new GpuAvbdEngine({ dualFusion: false }).info.variant).toEqual(new GpuAvbdEngine({}).info.variant);
    expect(() => new GpuAvbdEngine({ dualFusion: 1 as never })).toThrow('AvbdParams.dualFusion must be a boolean, got 1');
    expect(() => new GpuAvbdEngine({}, { solveContactsRW: 'yes' as never })).toThrow('GpuEngineOptions.solveContactsRW must be a boolean, got yes');
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 50 }, 7);
    const def = await call('dispatchPlan', scene, {});
    expect(def.dispatch).not.toHaveProperty('dualFusion');
    for (const [v, code] of [[FUSED, solveWgsl('registers', { dualFusion: true })], [IN_PLACE, solveWgsl('registers', { dualFusion: true, solveContactsRW: true })]] as const) {
      const r = await call('solveShader', scene, v.opts ?? {}, v.params);
      expect(r.dispatch).toMatchObject({ dualFusion: true, ...v.opts });
      expect(r.codes).toEqual([code]);
    }
  });

  // The S12 and S13 gates of engine-rest.test.ts, fused, and against the reference with dualFusion too
  // (bit-identical to its default: physics-ref/test/dualfusion.test.ts). At 20 iterations, S13 at 4 degrees is
  // the brief's Q1: within 3% of the rigid column, bending less than 0.1 m.
  it('S12: the cubes above the hole fall freely, the rest of the wall stays, as on the reference', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S12', {}, 1), steps = 30;
    const above = aboveHole(scene);
    const g = await runGpu(scene, steps, { dualFusion: true });
    for (const i of above) {
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      expect((scene.bodies[i]!.pos[1] - g.s1.pos[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
    }
    let worst = 0;
    scene.bodies.forEach((b, i) => {
      if (!above.includes(i)) worst = Math.max(worst, Math.hypot(g.s1.pos[3 * i]! - b.pos[0], g.s1.pos[3 * i + 1]! - b.pos[1], g.s1.pos[3 * i + 2]! - b.pos[2]));
    });
    expect(worst).toBeLessThan(0.03);
    const e = new AvbdReferenceEngine({ dualFusion: true });
    await e.init(scene);
    for (let i = 0; i < steps; i++) e.step();
    const ref = e.snapshot();
    let diff = 0;
    for (let k = 0; k < ref.pos.length; k++) diff = Math.max(diff, Math.abs(ref.pos[k]! - g.s1.pos[k]!));
    expect(diff).toBeLessThan(1e-3);
  });

  const column = async (deg: number, steps: number, iterations: number) => {
    const H = 20, scene = buildScenario('S13', { H, deg }, 1);
    const g = await runGpu(scene, steps, { iterations, dualFusion: true }, 5);
    const e = new AvbdReferenceEngine({ iterations, dualFusion: true });
    await e.init(scene);
    const ref = [{ t: 0, pos: [...e.snapshot().pos] }];
    for (let i = 1; i <= steps; i++) { e.step(); if (i % 5 === 0 || i === steps) ref.push({ t: i * scene.dt, pos: [...e.snapshot().pos] }); }
    return { H, gpu: readColumn(g.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), ref: readColumn(ref, H) };
  };
  it.for([[10, 0.12, Infinity], [20, 0.03, 0.1]] as const)('S13: a 20-cube column leaning 4 deg topples like the rigid column (%s iterations)', { timeout: 300_000 }, async ([iterations, tol, maxBend], ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(4, 330, iterations), rod = rodToppleTime(r.H, 4, 30);
    expect(r.gpu.topple).not.toBeNull();
    expect(Math.abs(r.gpu.topple! / rod - 1)).toBeLessThan(tol);
    expect(r.gpu.bend).toBeLessThan(maxBend);
    expect(Math.abs(r.gpu.topple! - r.ref.topple!)).toBeLessThan(0.02);
  });
  it('S13: a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column (10 iterations)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // The gates of the unfused test (engine-rest.test.ts), which says why the far side's bounds are what they are.
    const r = await column(2, 300, 10), rod = rodRock(r.H, 2);
    expect(r.gpu.upright).not.toBeNull();
    expect(Math.abs(r.gpu.upright! / rod.upright - 1)).toBeLessThan(0.15);
    expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
    expect(r.gpu.turned).toBe(true);
    expect(r.gpu.farSide / rod.farSide).toBeGreaterThan(0.58);
    expect(r.gpu.farSide / rod.farSide).toBeLessThan(1.02);
    expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
    expect(r.gpu.farSide - r.ref.farSide).toBeGreaterThan(-0.07);
    expect(r.gpu.farSide - r.ref.farSide).toBeLessThan(0.04);
  });
});
