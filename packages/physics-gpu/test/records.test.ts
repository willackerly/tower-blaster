// Manifold records (AvbdParams.records) on the GPU engine: the option and its
// layouts, and records 1 (the exact record) against points, bit for bit.
// Records 2 (centre friction) against the reference's records 2, and on the
// S12/S13 walls and columns: records-2.test.ts (its own file, for CI's shards).
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { CentreRecord, field, SolverContact, SolverRecord } from '@tb/schema';
import { buildScenario } from '@tb/scenarios';
import { readColumn, rodToppleTime } from '@tb/testkit';
import { AvbdSolver, GpuAvbdEngine, gpuRecordsLayout, RECORD_MODES, recordWgsl, SOLVER_WGSL, solveWgsl } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, cube, type D, G, gpu, sceneOf, toSnap } from './harness.ts';

const sphere = (pos: Vec3, radius: number, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), shape: { kind: 'sphere', radius } });
const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

// One describe around the rest, so a name filter on it selects every test here.
describe('GPU AVBD engine: manifold records: the option and its layouts, records 1 bit for bit', () => {

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
});
