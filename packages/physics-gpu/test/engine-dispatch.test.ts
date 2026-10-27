// The GPU AVBD engine's primal dispatch (direct colours and the tail) and
// Hessian forms: every variant gives the same state, bit for bit.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { defaultTailThreads, GpuAvbdEngine, type GpuEngineOptions, HESSIAN_FORMS, solveWgsl } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { gpu, call, toSnap, runGpu, cube, sceneOf, G } from './harness.ts';

describe('GPU AVBD engine: primal dispatch (direct colours and the one-workgroup tail)', () => {
  // Colours below colorTail get a dispatch each; the rest are solved in order
  // by one workgroup. A colour's bodies share no contact, so who solves which
  // body must not change a bit of the result.
  const state = (r: { s1: Snapshot }) => [r.s1.pos, r.s1.rot, r.s1.linVel, r.s1.angVel].map((a) => [...a]);
  // Few iterations and steps: on SwiftShader the cost is dispatches, and
  // bit-identity holds at any iteration count.
  const params = { iterations: 4 };
  const run = (scene: SceneDesc, steps: number, opts: Omit<GpuEngineOptions, 'device'>, every = 0) =>
    call('simulateGpu', scene, steps, params, every, opts);
  // A ball into two 2x2x8 towers: contacts from the first step, and colours
  // that change as they fall.
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

  it('every split between direct colours and the tail gives the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = knock();
    const base = await runGpu(scene, 16, params, 4);
    expect(base.maxColors).toBeGreaterThan(2); // so colorTail = 2 puts colours with bodies in the tail
    // Then every colour in the tail, at its largest size, and the serial
    // sweep: every colour in the tail, one thread.
    for (const opts of [{ indirectColors: true }, { colorTail: 0 }, { colorTail: 2 }, { colorTail: 63 }, { colorTail: 0, tailThreads: 256 }, { colorTail: 0, tailThreads: 1 }]) {
      const r = await run(scene, 16, opts);
      expect(r.error).toBeNull();
      expect(state({ ...base, s1: toSnap(r.snaps.at(-1)!) }), JSON.stringify(opts)).toEqual(state(base));
    }
  });

  it('the tail solves a colour larger than its workgroup, every body of it', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // 600 cubes, barely touching yet, in so few colours that every step has
    // one of more than 256 bodies (at least 600 / colours), which the tail
    // (64 threads by default, 256 at most) takes in strides. Colours are read
    // after every step.
    const scene = buildScenario('S11', { N: 600 }, 3);
    const a = await runGpu(scene, 10, params, 1);
    expect(600 / a.maxColors).toBeGreaterThan(256);
    for (const opts of [{ colorTail: 0 }, { colorTail: 0, tailThreads: 1 }]) {
      const b = await run(scene, 10, opts);
      expect(b.error).toBeNull();
      expect(state({ ...a, s1: toSnap(b.snaps.at(-1)!) }), JSON.stringify(opts)).toEqual(state(a));
    }
  });

  it('uncoloured bodies, which may touch, are solved one after another, the same on every split', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Two colouring rounds leave most bodies uncoloured (51 of 65 here); they
    // all go to the last colour, which one thread of the tail solves in order.
    // The serial sweep is the oracle: solving that colour with the whole
    // workgroup races where its bodies touch, and no longer matches it.
    const scene = knock();
    const s = [];
    for (const opts of [{ colorTail: 0, tailThreads: 1 }, {}, { colorTail: 0 }, { indirectColors: true }]) {
      const r = await run(scene, 16, { ...opts, colorRounds: 2 }, 4);
      expect(r.error).toBeNull();
      expect(r.worst.uncolored, JSON.stringify(opts)).toBeGreaterThan(0);
      s.push(toSnap(r.snaps.at(-1)!));
    }
    for (const other of s.slice(1)) expect(state({ s1: other })).toEqual(state({ s1: s[0]! }));
    expect(nonFinite(s[0]!)).toBe(0);
    // Every split skipping that colour would agree too, so check that it is
    // solved at all: against the fully coloured sweep, the other colour order
    // moves the towers by 0.7 mm; leaving the colour out, by about 0.35 m.
    const full = await run(scene, 16, {});
    expect(full.error).toBeNull();
    const f = full.snaps.at(-1)!.pos;
    expect(Math.max(...s[0]!.pos.map((v, i) => Math.abs(v - f[i]!)))).toBeLessThan(5e-3);
  });

  it('dispatches each colour below colorTail directly, and the rest in one dispatch', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 200 }, 7);
    for (const iterations of [3, 6]) {
      const def = await call('dispatchCounts', scene, { iterations }, {});
      const old = await call('dispatchCounts', scene, { iterations }, { indirectColors: true });
      const tail0 = await call('dispatchCounts', scene, { iterations }, { colorTail: 0 });
      const tail3 = await call('dispatchCounts', scene, { iterations }, { colorTail: 3 });
      expect([def.error, old.error, tail0.error, tail3.error]).toEqual([null, null, null, null]);
      const sweeps = iterations + 1;
      // Indirect, outside the primal: match, narrowphase pairs, degree, fill, pair setup, and the dual per iteration.
      for (const r of [def, tail0, tail3]) expect(r.indirect).toBe(iterations + 5);
      expect(old.indirect).toBe(iterations + 5 + 63 * sweeps);
      // Per sweep: colorTail direct colours + the tail; indirectColors and colorTail 0 have the tail alone.
      expect(old.direct).toBe(tail0.direct);
      expect(tail3.direct - tail0.direct).toBe(3 * sweeps);
      expect(def.direct - tail0.direct).toBe(8 * sweeps);
      expect(def.direct + def.indirect).toBe(old.direct + old.indirect - 55 * sweeps);
    }
  });
  it('(e) the tail is 256 threads on a hardware GPU and 64 on a software adapter, unless set', async () => {
    expect([defaultTailThreads(false), defaultTailThreads(true)]).toEqual([256, 64]);
    const scene = buildScenario('S11', { N: 50 }, 7);
    const def = await call('dispatchPlan', scene, {});
    expect(def.before).toBeNull();
    expect(def.software).not.toBeNull();
    expect(def.dispatch).toEqual({ colorTail: 8, indirectColors: false, tailThreads: def.software ? 64 : 256, hessian: 'registers' });
    // The tests run on SwiftShader unless a real GPU is present; it must count as software.
    if (/swiftshader/i.test(def.adapter ?? '')) expect(def.software).toBe(true);
    const set = await call('dispatchPlan', scene, { tailThreads: 32, colorTail: 3, indirectColors: true, hessian: 'array' });
    expect(set.dispatch).toEqual({ colorTail: 3, indirectColors: true, tailThreads: 32, hessian: 'array' });
  });
});

describe('GPU AVBD engine: primal hessian form (named registers against the private array)', () => {
  // hessian 'registers' (plan step 2b) holds each body's 6x6 system in named
  // scalars, unrolled; 'array' is the earlier private-array form. The register
  // form does the array form's floating-point operations in the same order
  // (registerSolveBody in solver.ts), so where the compiler does not contract
  // or reassociate one differently, the two agree bit for bit: on SwiftShader
  // they do, every scene here, at every step compared.
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  const same = async (scene: SceneDesc, steps: number, params: Partial<{ iterations: number }>, opts: Omit<GpuEngineOptions, 'device' | 'hessian'> = {}, every = 0) => {
    const [a, r] = [await call('simulateGpu', scene, steps, params, every, { ...opts, hessian: 'array' }), await call('simulateGpu', scene, steps, params, every, { ...opts, hessian: 'registers' })];
    expect([a.error, r.error]).toEqual([null, null]);
    expect(r.snaps.length).toBe(a.snaps.length);
    a.snaps.forEach((s, k) => expect(state(r.snaps[k]!), `step ${s.step}`).toEqual(state(s)));
    const last = toSnap(r.snaps.at(-1)!);
    expect(nonFinite(last)).toBe(0);
    // Contacts acted, so the comparison is not of free flight: bodies held up, falling at under half the free-fall speed.
    let held = 0;
    for (let i = 0; i < last.count; i++) if (last.linVel[3 * i + 1]! > -0.5 * G * steps * scene.dt) held++;
    expect(held).toBeGreaterThanOrEqual(10);
    return { a, r };
  };
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);
  const sphere = (pos: Vec3, radius: number, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), shape: { kind: 'sphere', radius } });

  // The ball reaches the towers at about step 17.
  it('two 2x2x8 towers and a ball: the same state, bit for bit, every 4 steps', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await same(knock(), 24, {}, {}, 4);
  });

  it('S11, 300 loose cubes landing: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await same(buildScenario('S11', { N: 300 }, 7), 40, {});
  });

  it('S5, a small city hit by a ball: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S5', { N: 150, F: 3, H: 6, street: 2, fireStep: 0, radius: 0.8, speed: 15 }, 1);
    await same(scene, 30, {});
  });

  it('spheres on boxes, on each other and rolling into a box: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sceneOf([
      cube([-1.2, 0.5, 0]), cube([0, 0.5, 0]), cube([1.2, 0.5, 0]),
      sphere([-1.2, 1.4, 0], 0.4), sphere([0, 1.4, 0], 0.4, [0.5, 0, 0.2]), sphere([1.2, 1.4, 0], 0.4),
      // Three touching spheres on the ground and one resting on them (just above, it drops into contact).
      sphere([3, 0.5, 0], 0.5), sphere([4, 0.5, 0], 0.5), sphere([3.5, 0.5, 0.866], 0.5), sphere([3.5, 1.32, 0.289], 0.5),
      sphere([-4.5, 0.5, 0], 0.5, [3, 0, 0.3]), cube([-3, 0.5, 0]),
    ]);
    await same(scene, 60, {}, {}, 20);
  });

  it('20 iterations: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await same(knock(), 20, { iterations: 20 });
  });

  it('every colour in the tail, uncoloured bodies included (primalTail): the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const { r } = await same(knock(), 24, { iterations: 4 }, { colorTail: 0, colorRounds: 2 });
    expect(r.worst.uncolored).toBeGreaterThan(0);
  });

  // One primal dispatch of the solve kernel on 2048 synthetic bodies with up
  // to 16 contact points each (page.ts primalKernel): random poses, normals
  // (a quarter axis-aligned, so the Jacobian has exact and signed zeros),
  // lever arms, forces, and stiffnesses (15% zero).
  //
  // Bodies 0 and 1 are built so that skipping a zero-stiffness row, as both
  // forms must, is visible. Negative inertia at the identity rotation seeds
  // the rotational block's off-diagonal entries with -0 (I[1][0] = -0 + -0 +
  // -0), and one ground contact has kN = kT = 0. Skipped, entry (4, 3) stays
  // -0, so l43 = -0 / d3 = +0 (d3 < 0), x3 = y3 - l43 x4 - l53 x5 = -0 with
  // y3 = +0 / d3 = -0, and phi.x = -0 - x3 = +0. A row with J[4] = 1 and
  // J[3] = 0 (u = x, lever arm (1, 1, 1)) added as (0 J[4]) J[3] = +0
  // instead turns the entry +0, x3 = +0 and phi.x = -0. That row is body 0's
  // first tangent (n = y, t1 = x) and body 1's normal (n = x, t1 = y); every
  // other row of the two adds -0, which leaves the entry as it is.
  it('the solve kernel on random systems: the two forms agree bit for bit, a skipped zero-stiffness row included', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const [a, r] = [await call('primalKernel', 'array', 2048, 5), await call('primalKernel', 'registers', 2048, 5)];
    expect([a.error, r.error]).toEqual([null, null]);
    expect(a.points).toBeGreaterThan(10_000);
    expect(a.zeroRows).toBeGreaterThan(1000);
    expect(a.changed).toBeGreaterThan(0.95 * a.bits.length);
    expect(a.nonFinite).toBe(0);
    let differ = 0;
    for (let k = 0; k < a.bits.length; k++) if (a.bits[k] !== r.bits[k]) differ++;
    expect(differ).toBe(0);
    // Bodies 0 and 1: phi.x is +0 (bits 0), not -0 (0x80000000).
    expect([a.bits[3], r.bits[3], a.bits[9], r.bits[9]]).toEqual([0, 0, 0, 0]);
  });

  it('the option reaches the shader: registers by default, two different modules, and the array form is the private-array code', async (ctx) => {
    expect(HESSIAN_FORMS).toEqual(['registers', 'array']);
    const reg = solveWgsl('registers'), arr = solveWgsl('array');
    expect(arr).toContain('var<private> lhs: array<f32, 36>;');
    expect(arr).toContain('fn accumulate(ct: SolverContact, i: u32)');
    const code = (wgsl: string) => wgsl.replace(/\/\/.*$/gm, '');
    for (const name of ['lhs', 'rhs', 'accumulate', 'var<private>', 'array<f32, 36>']) expect(code(reg)).not.toContain(name);
    expect(reg).toContain('h43 += k4 * J1[3];');
    expect(() => solveWgsl('matrix' as never)).toThrow(/hessian must be one of registers, array, got matrix/);
    expect(() => new GpuAvbdEngine({}, { hessian: 'matrix' as never })).toThrow("GpuEngineOptions.hessian must be one of registers, array, got matrix");
    expect(new GpuAvbdEngine({}, { hessian: 'array' }).info.variant).toMatchObject({ hessian: 'array' });
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 50 }, 7);
    // The point form's primal (records 0; unset is records 1, whose primal is recordWgsl()'s, and the array form is points).
    const def = await call('solveShader', scene, {}, { records: 0 });
    expect(def.dispatch!.hessian).toBe('registers');
    expect(def.codes).toEqual([reg]);
    const set = await call('solveShader', scene, { hessian: 'array' });
    expect(set.dispatch!.hessian).toBe('array');
    expect(set.codes).toEqual([arr]);
  });

  it('init() fails, naming the error, when a solve pipeline cannot be built (on Metal: too many registers for the tail workgroup)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('solvePipelineFailure', buildScenario('S11', { N: 50 }, 7));
    expect(r.maxInvocations).toBeLessThan(512);
    // The default's layout, records 1 (gpuRecordsLayout), is named with the dispatch.
    expect(r.message).toMatch(/^GpuAvbdEngine: init\(\) could not build the GPU pipelines \(hessian registers, tailThreads 256, records 1\): /);
    expect(r.message).toMatch(/primalTail/);
    // Nothing is left half-built: step() needs a new init(), which works once the shader does.
    expect(r.stepAfter).toBe('init() first');
    expect(r.healthy).toBe('resolved');
    expect(r.uncaptured).toEqual([]);
  });
});
