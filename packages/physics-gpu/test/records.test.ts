// Manifold records (AvbdParams.records) on the GPU engine: records 1 (the exact
// record) against points, bit for bit; records 2 (centre friction) against the
// reference's records 2, and on the S12/S13 walls and columns.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, freeFlight, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { CentreRecord, field, SolverContact, SolverRecord } from '@tb/schema';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { AvbdSolver, GpuAvbdEngine, gpuRecordsLayout, RECORD_MODES, recordWgsl, SOLVER_WGSL, solveWgsl } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, cube, type D, G, gpu, runGpu, sceneOf, toSnap } from './harness.ts';

const sphere = (pos: Vec3, radius: number, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), shape: { kind: 'sphere', radius } });
const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

// One describe around the rest, so a name filter on it selects every test here.
describe('GPU AVBD engine: manifold records: the option and its layouts, records 1 bit for bit, records 2 against the reference', () => {

  describe('the option and its layouts', () => {
    // records 1 is the GPU engine's default; points where only they are implemented (the array Hessian). Restitution
    // runs on records 1 (engine-restitution-records.test.ts).
    it('unset, the GPU engine solves with records 1, or points with the array Hessian; given, as given; the variant lists it when given', () => {
      expect(gpuRecordsLayout({})).toBe(1);
      expect(gpuRecordsLayout({}, { hessian: 'registers' })).toBe(1);
      expect(gpuRecordsLayout({}, { hessian: 'array' })).toBe(0);
      for (const records of [0, 1, 2]) expect(gpuRecordsLayout({ records })).toBe(records);
      expect(gpuRecordsLayout({ records: 0 }, { hessian: 'array' })).toBe(0);
      // The engine takes it, with restitution on as off.
      expect([new GpuAvbdEngine().records, new GpuAvbdEngine({}, { hessian: 'array' }).records, new GpuAvbdEngine({ records: 0 }).records, new GpuAvbdEngine({ records: 2 }).records]).toEqual([1, 0, 0, 2]);
      expect([new GpuAvbdEngine({ restitution: true }).records, new GpuAvbdEngine({ restitution: true }, { hessian: 'array' }).records, new GpuAvbdEngine({ records: 0, restitution: true }).records]).toEqual([1, 0, 0]);
      // avbd-gpu (unset) and avbd-gpu:records=0 are different engines: the variant lists records whenever it is given.
      expect(new GpuAvbdEngine().info.variant).not.toHaveProperty('records');
      expect(new GpuAvbdEngine({}, { hessian: 'array' }).info.variant).not.toHaveProperty('records');
      for (const records of [0, 1, 2]) expect(new GpuAvbdEngine({ records }).info.variant).toMatchObject({ records });
      // The reference is unchanged: records 0 is off there, as unset.
      expect(new AvbdReferenceEngine({ records: 0 }).info.variant).not.toHaveProperty('records');
    });

    // That the point form's modules are main's is a property of the branch, not of the code, so it is checked when
    // the branch is reviewed (the PR lists the module hashes against its base), not here: here, the engine builds
    // exactly SOLVER_WGSL and solveWgsl() with records 0, and records 1's shaders unset.
    it('records 0 builds the point form\'s shaders; 1 and 2 bind records, only the hot block in the primal and dual, in the register form only', async (ctx) => {
      expect(RECORD_MODES).toEqual([0, 1, 2]);
      for (const h of ['registers', 'array'] as const) expect(recordWgsl(0, h)).toEqual({ setup: SOLVER_WGSL.SETUP, solve: solveWgsl(h), dual: SOLVER_WGSL.DUAL });
      const code = (wgsl: string) => wgsl.replace(/\/\/.*$/gm, '');
      for (const [mode, struct] of [[1, 'SolverRecord'], [2, 'CentreRecord']] as const) {
        const w = recordWgsl(mode);
        for (const k of ['setup', 'solve', 'dual'] as const) {
          expect(w[k]).toContain(`records: array<${struct}>;`);
          expect(code(w[k])).not.toContain('contacts');
        }
        // The record kernel keeps its system in registers: no private arrays but jrow's and F's, which are indexed by constants.
        for (const name of ['lhs', 'rhs', 'accumulate', 'var<private>', 'array<f32, 36>']) expect(code(w.solve)).not.toContain(name);
        expect(w.solve).toContain('h43 += k4 * ');
        expect(() => recordWgsl(mode, 'array')).toThrow(`recordWgsl: records ${mode} needs hessian registers, got array`);
      }
      // 4 SolverContact points of 128 B against one record per slot, both history halves.
      expect([SolverContact.size, SolverRecord.size, CentreRecord.size]).toEqual([128, 384, 384]);
      expect([0, 1, 2].map((m) => AvbdSolver.contactBytes(10, 100, m as 0 | 1 | 2))).toEqual([2 * 110 * 512, 2 * 110 * 384, 2 * 110 * 384]);
      // The primal and the dual read only the hot block: the record fields they access end at 256 B (SolverRecord)
      // and 232 B (CentreRecord). At the 384 B stride that block is 2 lines of 128 B (4 of 64 B) in every slot; at
      // the unpadded 352 B or 320 B it would cross 3 lines in 3 slots of 4, or 1 of 2.
      const lines = (start: number, bytes: number, line: number) => Math.floor((start + bytes - 1) / line) - Math.floor(start / line) + 1;
      for (const [mode, struct, hot, unpadded] of [[1, SolverRecord, 256, 352], [2, CentreRecord, 232, 320]] as const) {
        const w = recordWgsl(mode);
        for (const k of ['setup', 'solve', 'dual'] as const) {
          const src = code(w[k]);
          const used = [...src.matchAll(/records\[(\w+)\]\.(\w+)/g)].map((m) => m[2]!);
          // Every access has that form, so none is missed.
          expect(used.length, `${struct.name} ${k}`).toBe(src.split('records[').length - 1);
          expect(used.filter((f) => f.startsWith('pad')), `${struct.name} ${k}`).toEqual([]);
          if (k === 'setup') continue;
          expect(Math.max(...used.map((f) => field(struct, f).offset + field(struct, f).size)), `${struct.name} ${k}`).toBe(hot);
        }
        expect(struct.size % 128).toBe(0);
        for (let r = 0; r < 8; r++) expect([lines(r * struct.size, hot, 128), lines(r * struct.size, hot, 64)]).toEqual([2, 4]);
        expect([0, 1, 2, 3].map((r) => lines(r * unpadded, hot, 128))).toEqual(mode === 1 ? [2, 3, 3, 3] : [2, 3, 2, 3]);
      }
      expect(() => recordWgsl(3 as never)).toThrow('recordWgsl: records must be one of 0, 1, 2, got 3');
      expect(() => new GpuAvbdEngine({ records: 3 })).toThrow('AvbdParams.records must be one of 0, 1, 2, got 3');
      expect(() => new GpuAvbdEngine({ records: 1 }, { hessian: 'array' })).toThrow('GpuAvbdEngine: AvbdParams.records 1 needs GpuEngineOptions.hessian registers, got array');
      // The loaded-gap slop (AvbdParams.gapSlop) with records: setup marks a loaded point in the record (bit 8 + q of
      // flags or stick), the primal and the dual read the mark behind the constant; engine-gapslop.test.ts runs it.
      for (const records of [1, 2] as const) {
        expect(new GpuAvbdEngine({ records, gapSlop: 3e-5 }).info.variant).toMatchObject({ records, gapSlop: 3e-5 });
        expect(() => new GpuAvbdEngine({ records, gapSlop: 0 })).not.toThrow();
        const w = recordWgsl(records), word = records === 1 ? 'flags' : 'stick';
        expect(w.setup).toContain('if (gapSlop > 0.0 && !roll && lambdaN < 0.0 && c0');
        expect(w.setup).toContain(`records[dst].${word} = ${records === 1 ? 'flags' : 'stick | marks'};`);
        for (const k of ['solve', 'dual'] as const) expect(w[k]).toMatch(records === 1 ? /if \(gapSlop > 0\.0 && recLoaded\(records\[\w+\]\.flags, q\)\) \{ ct\.used = 1u \| LOADED_GAP; \}/ : /evalN\(n, records\[\w+\]\.c0N\[q\], gapSlop > 0\.0 && recLoaded\(/);
      }
      expect(new GpuAvbdEngine({ records: 2 }).info.variant).toMatchObject({ records: 2 });
      expect(new GpuAvbdEngine().info.variant).not.toHaveProperty('records');
      expect(() => new AvbdReferenceEngine({ records: 4 })).toThrow('AvbdParams.records must be one of 0, 1, 2, got 4');
      if (!gpu) return ctx.skip();
      const scene = buildScenario('S11', { N: 50 }, 7);
      const pts = await call('solveShader', scene, {}, { records: 0 });
      expect(pts.modules['avbd setup']).toBe(SOLVER_WGSL.SETUP);
      expect(pts.modules['avbd solve']).toBe(solveWgsl('registers'));
      expect(pts.modules['avbd dual']).toBe(SOLVER_WGSL.DUAL);
      const def = await call('solveShader', scene, {}), one = recordWgsl(1);
      expect([def.modules['avbd setup'], def.modules['avbd solve'], def.modules['avbd dual']]).toEqual([one.setup, one.solve, one.dual]);
      // The array Hessian unset is points.
      const arr = await call('solveShader', scene, { hessian: 'array' });
      expect([arr.modules['avbd setup'], arr.modules['avbd dual']]).toEqual([SOLVER_WGSL.SETUP, SOLVER_WGSL.DUAL]);
      for (const mode of [1, 2] as const) {
        const set = await call('solveShader', scene, {}, { records: mode });
        const w = recordWgsl(mode);
        expect([set.modules['avbd setup'], set.modules['avbd solve'], set.modules['avbd dual']]).toEqual([w.setup, w.solve, w.dual]);
      }
    });
  });

  describe('records 1 (the exact record, the GPU default) is the point form, bit for bit', () => {
    // The scenes of the hessian-form tests (engine.test.ts), with the load cap
    // and rolling contacts on as by default: the default (records unset, so
    // records 1: gpuRecordsLayout) against points (records 0) at every step
    // compared; `records` 1 runs explicit records 1 too.
    const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
    const same = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, opts: Parameters<D['simulateGpu']>[4] = {}, every = 0, records?: 1) => {
      const [a, r] = [await call('simulateGpu', scene, steps, { ...params, records: 0 }, every, opts), await call('simulateGpu', scene, steps, { ...params, ...(records ? { records } : {}) }, every, opts)];
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

    it('two 2x2x8 towers and a ball: the same state, bit for bit, every 4 steps, unset and with records 1', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      await same(knock(), 24, {}, {}, 4);
      await same(knock(), 24, {}, {}, 4, 1);
    });

    it('S11, 300 loose cubes landing: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      await same(buildScenario('S11', { N: 300 }, 7), 40, {});
    });

    it('S5, a small city hit by a ball: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      await same(buildScenario('S5', { N: 150, F: 3, H: 6, street: 2, fireStep: 0, radius: 0.8, speed: 15 }, 1), 30, {});
    });

    it('spheres on boxes, on each other and rolling into a box (rolling contacts): the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const scene = sceneOf([
        cube([-1.2, 0.5, 0]), cube([0, 0.5, 0]), cube([1.2, 0.5, 0]),
        sphere([-1.2, 1.4, 0], 0.4), sphere([0, 1.4, 0], 0.4, [0.5, 0, 0.2]), sphere([1.2, 1.4, 0], 0.4),
        sphere([3, 0.5, 0], 0.5), sphere([4, 0.5, 0], 0.5), sphere([3.5, 0.5, 0.866], 0.5), sphere([3.5, 1.32, 0.289], 0.5),
        sphere([-4.5, 0.5, 0], 0.5, [3, 0, 0.3]), cube([-3, 0.5, 0]),
      ]);
      await same(scene, 60, {}, {}, 20);
    });

    it('20 iterations, and every colour in the tail with uncoloured bodies: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      await same(knock(), 20, { iterations: 20 });
      const { r } = await same(knock(), 24, { iterations: 4 }, { colorTail: 0, colorRounds: 2 });
      expect(r.worst.uncolored).toBeGreaterThan(0);
    });

    it('a 12-cube column settled with a lean, 450 steps (the load floor and cap at work): the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const leaning = (k: number): BodyDesc => ({
        shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, pos: [1e-5 * k, 0.25 + 0.5 * k, 0], rot: [0, 0, 0, 1],
        linVel: [0, 0, 0], angVel: [0, 0, 0], density: 250, friction: 0.6, restitution: 0.05, tag: 0,
      });
      await same({ ...sceneOf(Array.from({ length: 12 }, (_, k) => leaning(k))), frictionCombine: 'min' }, 450, {}, {}, 50);
    });

    // At the iterations the bench claims (20): S13's column, which engine.test.ts runs at 10 only.
    it('S13 at 20 iterations, a 20-cube column leaning 4 deg: the same state, bit for bit, toppling within 3% of the rigid column (Q1)', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const H = 20, scene = buildScenario('S13', { H, deg: 4 }, 1);
      const { r } = await same(scene, 330, { iterations: 20 }, {}, 5);
      const col = readColumn(r.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), rod = rodToppleTime(H, 4, 30);
      console.log(`records 1 S13 4 deg, 20 iterations: GPU topple ${col.topple} bend ${col.bend} rigid ${rod}`);
      expect(col.topple).not.toBeNull();
      expect(Math.abs(col.topple! / rod - 1)).toBeLessThan(0.03);
      expect(col.bend).toBeLessThan(0.1);
    });
  });

  /** Worst |GPU - reference| position over sampled steps, both with the same params (the reference in f64). */
  async function parity(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every: number) {
    const g = await runGpu(scene, steps, params, every);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    let worst = 0;
    const at: Array<[number, number]> = [];
    for (let i = 1; i <= steps; i++) {
      e.step();
      const s = g.snaps.find((x) => x.step === i);
      if (!s) continue;
      const ref = e.snapshot().pos;
      let w = 0;
      for (let k = 0; k < ref.length; k++) w = Math.max(w, Math.abs(ref[k]! - s.pos[k]!));
      at.push([i, w]);
      worst = Math.max(worst, w);
    }
    return { worst, at, g };
  }

  describe('records 2 (centre friction) against the reference\'s records 2, and on walls, columns and rolling balls', () => {
    it('S13, a 20-cube column leaning 4 deg, and S1, a 4x4x10 tower: positions within a few f32 ulps of the f64 reference, as points', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      // Once S13's column falls (from about step 90), f32 against f64 grows for points as well, so the whole run
      // is held to twice points' error, and the column before it falls (steps <= 80; 1.35e-5 on 2026-10-27) and
      // the tower (2.07e-5) to an absolute bound.
      const cases: Array<[string, SceneDesc, number, number, number]> = [
        ['S13 H=20 4 deg', buildScenario('S13', { H: 20, deg: 4 }, 1), 120, 80, 2e-5],
        ['S1 4x4x10', buildScenario('S1', { F: 4, H: 10, gap: 0 }, 1), 120, 120, 4e-5],
      ];
      for (const [name, scene, steps, early, bound] of cases) {
        const pts = await parity(scene, steps, { records: 0 }, 10), rec = await parity(scene, steps, { records: 2 }, 10);
        console.log(`records parity ${name}: points ${pts.worst.toExponential(2)} records 2 ${rec.worst.toExponential(2)} (${JSON.stringify(rec.at.map(([s, w]) => [s, Number(w.toExponential(2))]))})`);
        expect(nonFinite(rec.g.s1), name).toBe(0);
        expect(rec.worst, name).toBeLessThan(Math.max(1e-5, 2 * pts.worst));
        expect(Math.max(...rec.at.filter(([s]) => s <= early).map(([, w]) => w)), `${name}, steps <= ${early}`).toBeLessThan(bound);
      }
    });

    // The friction rows of a multi-point record, which the columns and walls barely load: a cube spinning on the
    // ground (the twist row of a ground record), a cube spinning on another (a pair's twist, body a not the
    // ground) and a cube sliding at 3 m/s (T1 and T2), GPU against the reference's records 2 at every step.
    // 2026-10-27 (review scratch test, separate scenes): |dw| 8.7e-7 and 2.4e-5, slide |dx| 9.4e-7.
    it('cubes spinning on the ground and on a cube, and a cube sliding: the friction rows as the reference\'s records 2', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const spun = (pos: Vec3, angVel: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), angVel });
      const scene = sceneOf([spun([-4, 0.5, 0], [0, 5, 0]), cube([0, 0.5, 0]), spun([0, 1.5, 0], [0, 4, 0]), cube([4, 0.5, 0], [3, 0, 0])]);
      const steps = 90, params = { records: 2 };
      const g = await runGpu(scene, steps, params, 1);
      const e = new AvbdReferenceEngine(params);
      await e.init(scene);
      let dw = 0, dx = 0;
      for (let i = 1; i <= steps; i++) {
        e.step();
        const s = g.snaps.find((x) => x.step === i)!, r = e.snapshot();
        for (const b of [0, 2]) dw = Math.max(dw, Math.abs(s.angVel[3 * b + 1]! - r.angVel[3 * b + 1]!));
        for (let k = 0; k < r.pos.length; k++) dx = Math.max(dx, Math.abs(s.pos[k]! - r.pos[k]!));
      }
      const r = e.snapshot();
      console.log(`records 2 spin and slide: |dw| ${dw.toExponential(2)} |dx| ${dx.toExponential(2)}; reference w ${r.angVel[1]} ${r.angVel[7]}, slide ${r.pos[9]! - 4} m`);
      // The friction acted: both spins stopped, and the slider stopped after sliding.
      expect([Math.abs(r.angVel[1]!), Math.abs(r.angVel[7]!)].every((w) => w < 0.05)).toBe(true);
      expect(r.pos[9]! - 4).toBeGreaterThan(0.5);
      expect(Math.abs(r.linVel[9]!)).toBeLessThan(0.05);
      expect(dw).toBeLessThan(1e-4);
      expect(dx).toBeLessThan(1e-5);
    });

    // The default S12/S13 tests (engine.test.ts, physics-ref/test/collapse.test.ts) with records 2, at the
    // shipping 10 iterations, against the rigid column and the reference's records 2. Records 2 reference,
    // 2026-10-26: Q1 4 deg topples +2.14% late (points +3.03%), Q2 2 deg uprights 4.85% early and swings 0.689
    // of the rigid column's far side (points 6.12% and 0.632).
    it('S12: the cubes above the hole fall freely, and the rest of the wall stays', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const scene = buildScenario('S12', {}, 1), steps = 30;
      const above = aboveHole(scene);
      const g = await runGpu(scene, steps, { records: 2 });
      for (const i of above) {
        const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
        expect((scene.bodies[i]!.pos[1] - g.s1.pos[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
      }
      let worst = 0;
      scene.bodies.forEach((b, i) => {
        if (!above.includes(i)) worst = Math.max(worst, Math.hypot(g.s1.pos[3 * i]! - b.pos[0], g.s1.pos[3 * i + 1]! - b.pos[1], g.s1.pos[3 * i + 2]! - b.pos[2]));
      });
      expect(worst).toBeLessThan(0.03);
    });

    const column = async (deg: number, steps: number, params: Partial<AvbdParams>) => {
      const H = 20, scene = buildScenario('S13', { H, deg }, 1);
      const g = await runGpu(scene, steps, params, 5);
      const e = new AvbdReferenceEngine(params);
      await e.init(scene);
      const ref = [{ t: 0, pos: [...e.snapshot().pos] }];
      for (let i = 1; i <= steps; i++) { e.step(); if (i % 5 === 0 || i === steps) ref.push({ t: i * scene.dt, pos: [...e.snapshot().pos] }); }
      return { H, gpu: readColumn(g.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), ref: readColumn(ref, H) };
    };

    it('S13: a 20-cube column leaning 4 deg topples like the rigid column, and as the reference\'s records 2', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const r = await column(4, 330, { records: 2 }), rod = rodToppleTime(r.H, 4, 30);
      console.log(`records 2 S13 4 deg: GPU topple ${r.gpu.topple} reference ${r.ref.topple} rigid ${rod}`);
      expect(r.gpu.topple).not.toBeNull();
      expect(Math.abs(r.gpu.topple! / rod - 1)).toBeLessThan(0.12);
      expect(Math.abs(r.gpu.topple! - r.ref.topple!)).toBeLessThan(0.02);
    });

    it('S13: a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column, as the reference\'s records 2', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const r = await column(2, 300, { records: 2 }), rod = rodRock(r.H, 2);
      console.log(`records 2 S13 2 deg: GPU upright ${r.gpu.upright} far ${r.gpu.farSide} reference ${r.ref.upright} far ${r.ref.farSide} rigid ${rod.upright} far ${rod.farSide}`);
      expect(r.gpu.upright).not.toBeNull();
      expect(Math.abs(r.gpu.upright! / rod.upright - 1)).toBeLessThan(0.15);
      expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
      expect(r.gpu.turned).toBe(true);
      expect(r.gpu.farSide / rod.farSide).toBeGreaterThan(0.58);
      expect(r.gpu.farSide / rod.farSide).toBeLessThan(1.02);
      expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
      // The far side is the number rounding moves (engine.test.ts says why). With records 2 the unmoved reference
      // run is the outlier: moving every start position by up to 1e-6 m (physics-ref/scripts/records-quality.ts
      // spread, 120 seeds, 2026-10-26) puts its far side at 1.270-1.323 deg, 0.086-0.033 below the unmoved run's
      // 1.356. The GPU on SwiftShader lands at 1.279, inside that spread (0.077 below). So the bounds follow the
      // spread, -0.10 / +0.02. At 20 iterations the spread is 1.881-1.883 deg, and the GPU there is held to 0.07.
      expect(r.gpu.farSide - r.ref.farSide).toBeGreaterThan(-0.1);
      expect(r.gpu.farSide - r.ref.farSide).toBeLessThan(0.02);
    });

    // At 20 iterations, with the brief's Q1 and Q2 conditions. Reference records 2, 2026-10-26: 4 deg +0.05%,
    // bend 0.02; 2 deg 0.53% early, far side 0.957 of the rigid column's.
    it('S13 at 20 iterations: 4 deg topples within 3% of the rigid column, 2 deg rocks back within 3% and 0.85-1.02 of its far side, as the reference\'s records 2', { timeout: 600_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const t = await column(4, 330, { records: 2, iterations: 20 }), rod = rodToppleTime(t.H, 4, 30);
      console.log(`records 2 S13 4 deg, 20 iterations: GPU topple ${t.gpu.topple} bend ${t.gpu.bend} reference ${t.ref.topple} rigid ${rod}`);
      expect(t.gpu.topple).not.toBeNull();
      expect(Math.abs(t.gpu.topple! / rod - 1)).toBeLessThan(0.03);
      expect(t.gpu.bend).toBeLessThan(0.1);
      expect(Math.abs(t.gpu.topple! - t.ref.topple!)).toBeLessThan(0.02);
      const r = await column(2, 300, { records: 2, iterations: 20 }), rr = rodRock(r.H, 2);
      console.log(`records 2 S13 2 deg, 20 iterations: GPU upright ${r.gpu.upright} far ${r.gpu.farSide} reference ${r.ref.upright} far ${r.ref.farSide} rigid ${rr.upright} far ${rr.farSide}`);
      expect(r.gpu.upright).not.toBeNull();
      expect(Math.abs(r.gpu.upright! / rr.upright - 1)).toBeLessThan(0.03);
      expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
      expect(r.gpu.turned).toBe(true);
      expect(r.gpu.farSide / rr.farSide).toBeGreaterThan(0.85);
      expect(r.gpu.farSide / rr.farSide).toBeLessThan(1.02);
      expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
      expect(Math.abs(r.gpu.farSide - r.ref.farSide)).toBeLessThan(0.07);
    });

    // Rolling contacts with records 2: a one-point record is a point's friction (rt = 0), with its slip carried at
    // the centre, so a ball keeps rolling as with points (engine.test.ts, rolling contacts).
    it('a steel ball rolling on the ground at 2 and 6 m/s keeps its height, speed and rolling, as on the reference\'s records 2', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const R = 0.25, SETTLE = 60;
      const ball = (pos: Vec3): BodyDesc => ({ shape: { kind: 'sphere', radius: R }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 7800, friction: 0.55, restitution: 0, tag: 0 });
      const kick = (body: number, v: number): Drivers.Kick => ({ step: SETTLE, body, linVel: [v, 0, 0], angVel: [0, 0, -v / R] });
      const scene: SceneDesc = { ...sceneOf([ball([0, R, 0]), ball([0, R, 3])]), frictionCombine: 'min' };
      const { all } = await runGpu(scene, SETTLE + 120, { records: 2 }, 1, [kick(0, 2), kick(1, 6)]);
      for (const [b, v0] of [[0, 2], [1, 6]] as const) {
        let dy = 0, dv = 0, dw = 0;
        const y0 = all[SETTLE]!.pos[3 * b + 1]!;
        for (const s of all.slice(SETTLE + 1)) {
          dy = Math.max(dy, Math.abs(s.pos[3 * b + 1]! - y0));
          dv = Math.max(dv, Math.abs(s.linVel[3 * b]! / v0 - 1));
          dw = Math.max(dw, Math.abs((-s.angVel[3 * b + 2]! * R) / s.linVel[3 * b]! - 1));
        }
        console.log(`records 2 rolling at ${v0} m/s: dy ${dy.toExponential(2)} dv ${dv.toExponential(2)} dw ${dw.toExponential(2)}`);
        expect(dy, `${v0} m/s`).toBeLessThan(1e-3);
        expect(dv, `${v0} m/s`).toBeLessThan(0.01);
        expect(dw, `${v0} m/s`).toBeLessThan(0.01);
      }
    });
  });
});
