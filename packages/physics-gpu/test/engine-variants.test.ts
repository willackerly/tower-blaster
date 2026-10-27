// The opt-in variants together on the GPU engine (AvbdParams.dualFusion,
// records, colorMode, colorPriority). The fused dual on records is the
// separate pass's arithmetic on the same values, as on points: bodies and the
// whole record buffer bit for bit against the same variants without it, in the
// side array and in place. Each combination also against the reference's same
// combination, within the single variants' tolerances (records.test.ts,
// lattice-physics.test.ts).
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { GpuAvbdEngine, type GpuEngineOptions, recordWgsl } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call, gpu, toSnap } from './harness.ts';

describe('GPU AVBD engine: the opt-in variants together', () => {
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  type Variant = { params?: Partial<AvbdParams>; opts?: Omit<GpuEngineOptions, 'device'> };
  const FUSED: Variant = { params: { dualFusion: true } };
  const IN_PLACE: Variant = { params: { dualFusion: true }, opts: { solveContactsRW: true } };
  /** The scene with `params` (base options), then with each variant on top: every snapshot and the whole contact buffer the same. */
  const same = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, variants: Variant[], every = 0, baseOpts: Omit<GpuEngineOptions, 'device'> = {}) => {
    const base = await call('simulateGpu', scene, steps, params, every, baseOpts, [], true);
    expect(base.error).toBeNull();
    expect(base.contacts!.used).toBeGreaterThan(10);
    for (const v of variants) {
      const r = await call('simulateGpu', scene, steps, { ...params, ...v.params }, every, v.opts ?? baseOpts, [], true);
      const what = JSON.stringify({ params, ...v });
      expect(r.error, what).toBeNull();
      expect(r.snaps.length).toBe(base.snaps.length);
      r.snaps.forEach((s, k) => expect(state(s), `${what}, step ${s.step}`).toEqual(state(base.snaps[k]!)));
      expect(r.contacts, what).toEqual(base.contacts);
    }
    expect(nonFinite(toSnap(base.snaps.at(-1)!))).toBe(0);
    return base;
  };
  // A ball into two 2x2x8 towers (it reaches them at about step 17): contacts from the first step, and colours that change.
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

  describe('the fused dual on records, and with the lattice colouring: bit for bit against the same variants without it', () => {
    it.for([1, 2] as const)('records %s: bodies and records in the side array and in place, on every split', { timeout: 300_000 }, async (records, ctx) => {
      if (!gpu) return ctx.skip();
      const splits = [{}, { colorTail: 0 }, { colorTail: 2 }, { indirectColors: true }, { colorTail: 0, tailThreads: 1 }];
      const base = await same(knock(), 24, { iterations: 4, records }, [
        ...splits.map((opts) => ({ ...FUSED, opts })), IN_PLACE, { ...IN_PLACE, opts: { ...IN_PLACE.opts, colorTail: 0 } },
      ], 4);
      expect(base.maxColors).toBeGreaterThan(2);
    });

    it.for([1, 2] as const)('records %s: colour overflow (uncoloured bodies in colour 63, solved one after another)', { timeout: 300_000 }, async (records, ctx) => {
      if (!gpu) return ctx.skip();
      const base = await same(knock(), 24, { iterations: 4, records }, [
        { ...FUSED, opts: { colorRounds: 2 } }, { ...FUSED, opts: { colorRounds: 2, colorTail: 0 } }, { ...IN_PLACE, opts: { ...IN_PLACE.opts, colorRounds: 2 } },
      ], 4, { colorRounds: 2, colorTail: 0, tailThreads: 1 });
      expect(base.worst.uncolored).toBeGreaterThan(20);
    });

    it('records 2 at 20 iterations, 1 (nothing to fuse) and 2 (one fused update)', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      for (const iterations of [20, 1, 2]) await same(knock(), 24, { iterations, records: 2 }, [FUSED, IN_PLACE], 8);
    });

    it('colorMode 3 and 4 (4 with colorPriority 1), and both with records 2: bodies and contacts', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const unlatticed = await call('simulateGpu', knock(), 24, { iterations: 4, records: 2 }, 8, {});
      expect(unlatticed.error).toBeNull();
      for (const params of [{ colorMode: 3 }, { colorMode: 4, colorPriority: 1 }, { colorMode: 3, records: 2 }, { colorMode: 4, records: 2 }]) {
        const base = await same(knock(), 24, { iterations: 4, ...params }, [FUSED, IN_PLACE], 8);
        // With records 2 the colouring is in effect: the order, and so the rounding, is not the default's.
        if ('records' in params) expect(state(base.snaps.at(-1)!), JSON.stringify(params)).not.toEqual(state(unlatticed.snaps.at(-1)!));
      }
    });

    it('records 1 under colorMode 3 and 4, fused or not: the point form\'s bodies under the same colouring, bit for bit', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      // The record buffer is laid out unlike the contacts, so only the bodies compare (records.test.ts, for the default colouring).
      const run = async (params: Partial<AvbdParams>) => {
        const r = await call('simulateGpu', knock(), 24, { iterations: 4, ...params }, 8, {});
        expect(r.error, JSON.stringify(params)).toBeNull();
        return r;
      };
      const unlatticed = await run({});
      for (const colorMode of [3, 4]) {
        const points = await run({ colorMode });
        // The colouring is in effect: the order, and so the rounding, is not the default's.
        expect(state(points.snaps.at(-1)!)).not.toEqual(state(unlatticed.snaps.at(-1)!));
        for (const p of [{ records: 1 }, { records: 1, dualFusion: true }, { records: 1, dualFusion: true, colorPriority: 1 }]) {
          const r = await run({ colorMode, ...p });
          const base = p.colorPriority ? await run({ colorMode, colorPriority: 1 }) : points;
          expect(r.snaps.length).toBe(base.snaps.length);
          r.snaps.forEach((s, k) => expect(state(s), `colorMode ${colorMode} ${JSON.stringify(p)}, step ${s.step}`).toEqual(state(base.snaps[k]!)));
        }
      }
    });
  });

  /** Worst |GPU - reference| position over sampled steps, both with the same params (the reference in f64). */
  async function parity(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every: number) {
    const g = await call('simulateGpu', scene, steps, params, every, {}, []);
    expect(g.error).toBeNull();
    expect(g.worst.uncolored).toBe(0);
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
    return { worst, at, last: g.snaps.at(-1)! };
  }

  describe('each combination against the reference\'s same combination', () => {
    // records.test.ts's bounds for records 2 against the reference's records 2 (S13 held to twice points' error and to
    // 2e-5 before the column falls; the S1 tower to 4e-5), here with the fused dual on both sides.
    it('dualFusion and records 2: S13, a 20-cube column leaning 4 deg, and S1, a 4x4x10 tower, as records 2 alone', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const cases: Array<[string, SceneDesc, number, number, number]> = [
        ['S13 H=20 4 deg', buildScenario('S13', { H: 20, deg: 4 }, 1), 120, 80, 2e-5],
        ['S1 4x4x10', buildScenario('S1', { F: 4, H: 10, gap: 0 }, 1), 120, 120, 4e-5],
      ];
      for (const [name, scene, steps, early, bound] of cases) {
        const pts = await parity(scene, steps, {}, 10), rec = await parity(scene, steps, { records: 2, dualFusion: true }, 10);
        console.log(`dualFusion + records 2 parity ${name}: points ${pts.worst.toExponential(2)} fused records 2 ${rec.worst.toExponential(2)}`);
        expect(nonFinite(toSnap(rec.last)), name).toBe(0);
        expect(rec.worst, name).toBeLessThan(Math.max(1e-5, 2 * pts.worst));
        expect(Math.max(...rec.at.filter(([s]) => s <= early).map(([, w]) => w)), `${name}, steps <= ${early}`).toBeLessThan(bound);
      }
    });

    // lattice-physics.test.ts's bounds for a colorMode against the reference's: a 3x3x8 tower and an 8x8x5 block stand
    // for 120 steps, within 1e-3 of the reference variant and of where they started. A stand does that under any
    // colouring, so these are smoke tests of the combinations; that the colouring is applied is tested above (and in
    // lattice-colours and lattice-impact).
    it.for([
      [{ colorMode: 3, dualFusion: true }],
      [{ colorMode: 3, records: 2 }],
      [{ colorMode: 4, records: 2 }],
      [{ colorMode: 3, records: 2, dualFusion: true }],
    ] as const)('%j: a 3x3x8 tower and an 8x8x5 block stand, matching the reference', { timeout: 300_000 }, async ([params], ctx) => {
      if (!gpu) return ctx.skip();
      for (const shape of [{ F: 3, H: 8, gap: 0 }, { F: 8, H: 5, gap: 0 }]) {
        const scene = buildScenario('S1', shape, 1);
        const g = await parity(scene, 120, params, 120);
        expect(g.worst, JSON.stringify(shape)).toBeLessThan(1e-3);
        let side = 0;
        scene.bodies.forEach((b, i) => { side = Math.max(side, Math.hypot(g.last.pos[3 * i]! - b.pos[0], g.last.pos[3 * i + 2]! - b.pos[2])); });
        expect(side, JSON.stringify(shape)).toBeLessThan(1e-3);
      }
    });
  });

  it('records with the fused dual: a side array of ContactDual per point (records 1) or CentreDual per record (2), read-only records, 8 storage buffers per kernel at most; the engine builds them', async (ctx) => {
    const code = (wgsl: string) => wgsl.replace(/\/\/.*$/gm, '');
    const storage = (wgsl: string) => (code(wgsl).match(/var<storage/g) ?? []).length;
    for (const [records, struct, dual] of [[1, 'SolverRecord', 'ContactDual'], [2, 'CentreRecord', 'CentreDual']] as const) {
      const side = recordWgsl(records, 'registers', { dualFusion: true }), inPlace = recordWgsl(records, 'registers', { dualFusion: true, solveContactsRW: true });
      expect(side.setup).toBe(recordWgsl(records).setup);
      expect(side.solve).toContain(`var<storage, read> records: array<${struct}>;`);
      expect(side.solve).toContain(`var<storage, read_write> duals: array<${dual}>;`);
      expect(side.solve).toContain('fn visitOrder(');
      expect(code(side.solve)).not.toMatch(/colorStart\[/);
      expect(side.dual).toContain(`var<storage, read> duals: array<${dual}>;`);
      expect(side.dual).toContain('fn dualPairsSide(');
      expect(inPlace.solve).toContain(`var<storage, read_write> records: array<${struct}>;`);
      expect(inPlace.solve).not.toContain('duals');
      expect(inPlace.dual).toBe(recordWgsl(records).dual);
      for (const w of [side, inPlace]) for (const k of ['setup', 'solve', 'dual'] as const) expect(storage(w[k]), `records ${records} ${k}`).toBeLessThanOrEqual(8);
    }
    const all = { dualFusion: true, records: 2, colorMode: 3, colorPriority: 1 } as const;
    expect(new GpuAvbdEngine(all, { solveContactsRW: true }).info.variant).toMatchObject({ ...all, solveContactsRW: true });
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 50 }, 7);
    for (const records of [1, 2] as const) for (const opts of [{}, { solveContactsRW: true }]) {
      const r = await call('solveShader', scene, opts, { records, dualFusion: true });
      const w = recordWgsl(records, 'registers', { dualFusion: true, ...opts });
      expect([r.modules['avbd setup'], r.modules['avbd solve'], r.modules['avbd dual']]).toEqual([w.setup, w.solve, w.dual]);
    }
  });
});
